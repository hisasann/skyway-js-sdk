const RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription;
const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection;
const RTCIceCandidate = window.RTCIceCandidate || window.mozRTCIceCandidate;

module.exports = {
  RTCSessionDescription,
  RTCPeerConnection,
  RTCIceCandidate,
};
