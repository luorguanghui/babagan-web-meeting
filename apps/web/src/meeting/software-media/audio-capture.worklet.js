/* global AudioWorkletProcessor, registerProcessor, currentFrame, sampleRate */
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1920); this.offset = 0; this.started = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input?.[0]) return true;
    for (let index = 0; index < input[0].length; index++) {
      if (!this.offset) this.started = currentFrame + index;
      this.buffer[this.offset++] = input[0][index];
      this.buffer[this.offset++] = (input[1] ?? input[0])[index];
      if (this.offset === 1920) {
        this.port.postMessage({ data: this.buffer, contextTime: this.started / sampleRate }, [this.buffer.buffer]);
        this.buffer = new Float32Array(1920); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('project-share-capture', Capture);
