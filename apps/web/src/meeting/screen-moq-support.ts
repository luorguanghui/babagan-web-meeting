function supportsTransport(): boolean {
  return globalThis.isSecureContext && typeof WebTransport === 'function' && 'protocol' in WebTransport.prototype;
}

export function supportsMoqPublisher(): boolean {
  return supportsTransport() && typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

export function supportsMoqSubscriber(): boolean {
  return supportsTransport() && typeof VideoDecoder === 'function'
    && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}
