/**
 * This file demonstrates the process of starting WebRTC streaming using a KVS Signaling Channel.
 */
const master = {
    signalingClient: null,
    peerConnectionByClientId: {},
    localStream: null,
    remoteStreams: [],
    peerConnectionStatsInterval: null,
};

async function startMaster(localView, remoteView, formValues, onStatsReport) {
    master.localView = localView;
    master.remoteView = remoteView;

    // Create KVS client
    const kinesisVideoClient = new AWS.KinesisVideo({
        region: formValues.region,
        accessKeyId: formValues.accessKeyId,
        secretAccessKey: formValues.secretAccessKey,
        sessionToken: formValues.sessionToken,
        endpoint: formValues.endpoint,
    });

    // Get signaling channel ARN
    const describeSignalingChannelResponse = await kinesisVideoClient
        .describeSignalingChannel({
            ChannelName: formValues.channelName,
        })
        .promise();
    const channelARN = describeSignalingChannelResponse.ChannelInfo.ChannelARN;
    console.log('[MASTER] Channel ARN: ', channelARN);

    // Get signaling channel endpoints
    const getSignalingChannelEndpointResponse = await kinesisVideoClient
        .getSignalingChannelEndpoint({
            ChannelName: formValues.channelName,
            SingleMasterChannelEndpointConfiguration: {
                Protocols: ['WSS', 'HTTPS'],
                Role: KVSWebRTC.Role.MASTER,
            },
        })
        .promise();
    const endpointsByProtocol = getSignalingChannelEndpointResponse.ResourceEndpointList.reduce((endpoints, endpoint) => {
        endpoints[endpoint.Protocol] = endpoint.ResourceEndpoint;
        return endpoints;
    }, {});
    console.log('[MASTER] Endpoints: ', endpointsByProtocol);

    // Create Signaling Client
    master.signalingClient = new KVSWebRTC.SignalingClient({
        channelName: formValues.channelName,
        channelEndpoint: endpointsByProtocol.WSS,
        role: KVSWebRTC.Role.MASTER,
        region: formValues.region,
        credentials: {
            accessKeyId: formValues.accessKeyId,
            secretAccessKey: formValues.secretAccessKey,
            sessionToken: formValues.sessionToken,
        },
    });

    // Get ICE server configuration
    const kinesisVideoSignalingClient = new AWS.KinesisVideoSignaling({
        region: formValues.region,
        accessKeyId: formValues.accessKeyId,
        secretAccessKey: formValues.secretAccessKey,
        sessionToken: formValues.sessionToken,
        endpoint: endpointsByProtocol.HTTPS,
    });
    const getIceServerConfigResponse = await kinesisVideoSignalingClient
        .getIceServerConfig({
            ChannelARN: channelARN,
            ClientId: KVSWebRTC.Role.MASTER, // TODO: Remove after Private Beta
        })
        .promise();
    const iceServers = getIceServerConfigResponse.IceServerList.map(iceServer => ({
        urls: iceServer.Uris,
        username: iceServer.Username,
        credential: iceServer.Password,
    }));
    iceServers.unshift({ urls: 'stun:stun.beta.kinesisvideo.us-west-2.amazonaws.com:443' });
    console.log('[MASTER] ICE servers: ', iceServers);

    const configuration = {
        iceServers,
    };

    const constraints = {
        video: formValues.sendVideo,
        audio: formValues.sendAudio,
    };

    master.signalingClient.on('open', async () => {
        console.log('[MASTER] Connected to signaling service');

        // Get a stream from the webcam and display it in the local view
        try {
            master.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            localView.srcObject = master.localStream;
        } catch (e) {
            console.error('[MASTER] Could not find webcam');
        }
    });

    master.signalingClient.on('sdpOffer', async (offer, remoteClientId) => {
        console.log('[MASTER] Received SDP offer from client: ' + remoteClientId);

        // Create a new peer connection using the offer from the given client
        const peerConnection = new RTCPeerConnection(configuration);
        master.peerConnectionByClientId[remoteClientId] = peerConnection;

        // Poll for connection stats
        if (!master.peerConnectionStatsInterval) {
            master.peerConnectionStatsInterval = setInterval(() => peerConnection.getStats().then(onStatsReport), 1000);
        }

        // Send any ICE candidates to the other peer
        peerConnection.addEventListener('icecandidate', ({ candidate }) => {
            if (candidate) {
                console.log('[MASTER] Sending ICE candidate to client: ' + remoteClientId);
                master.signalingClient.sendIceCandidate(candidate, remoteClientId);
            } else {
                console.log('[MASTER] All ICE candidates have been sent to client: ' + remoteClientId);
            }
        });

        // As remote tracks are received, add them to the remote view
        peerConnection.addEventListener('track', event => {
            console.log('[MASTER] Received remote track from client: ' + remoteClientId);
            if (remoteView.srcObject) {
                return;
            }
            remoteView.srcObject = event.streams[0];
        });

        master.localStream.getTracks().forEach(track => peerConnection.addTrack(track, master.localStream));
        await peerConnection.setRemoteDescription(offer);

        // Create an SDP answer to send back to the client
        console.log('[MASTER] Creating SDP answer and sending to client: ' + remoteClientId);
        await peerConnection.setLocalDescription(
            await peerConnection.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
            }),
        );
        master.signalingClient.sendSdpAnswer(peerConnection.localDescription, remoteClientId);
    });

    master.signalingClient.on('iceCandidate', async (candidate, remoteClientId) => {
        console.log('[MASTER] Received ICE candidate from client: ' + remoteClientId);

        // Add the ICE candidate received from the client to the peer connection
        const peerConnection = master.peerConnectionByClientId[remoteClientId];
        peerConnection.addIceCandidate(candidate);
    });

    master.signalingClient.on('close', () => {
        console.log('[MASTER] Disconnected from signaling channel');
    });

    master.signalingClient.on('error', () => {
        console.error('[MASTER] Signaling client error');
    });

    console.log('[MASTER] Starting master connection');
    master.signalingClient.open();
}

function stopMaster() {
    console.log('[MASTER] Stopping master connection');
    if (master.signalingClient) {
        master.signalingClient.close();
        master.signalingClient = null;
    }

    Object.keys(master.peerConnectionByClientId).forEach(clientId => {
        master.peerConnectionByClientId[clientId].close();
    });
    master.peerConnectionByClientId = [];

    if (master.localStream) {
        master.localStream.getTracks().forEach(track => track.stop());
        master.localStream = null;
    }

    master.remoteStreams.forEach(remoteStream => remoteStream.getTracks().forEach(track => track.stop()));
    master.remoteStreams = [];

    if (master.peerConnectionStatsInterval) {
        clearInterval(master.peerConnectionStatsInterval);
        master.peerConnectionStatsInterval = null;
    }

    if (master.localView) {
        master.localView.srcObject = null;
    }

    if (master.remoteView) {
        master.remoteView.srcObject = null;
    }
}