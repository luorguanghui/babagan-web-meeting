/* global AudioWorkletProcessor, registerProcessor, currentFrame, sampleRate */
class Playback extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = [];
    this.port.onmessage = ({ data }) => {
      if (data.type === 'clear') { this.queue = []; return; }
      if (!data.samples || data.startFrame > currentFrame + sampleRate * .2) return;
      if (this.queue.length >= 10) this.queue.shift();
      this.queue.push(data); this.queue.sort((a, b) => a.startFrame - b.startFrame);
    };
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output?.[0]) return true;
    for (let index = 0; index < output[0].length; index++) {
      const frame = currentFrame + index;
      while (this.queue.length && this.queue[0].startFrame + this.queue[0].samples.length / 2 <= frame) this.queue.shift();
      const item = this.queue[0];
      if (!item || frame < item.startFrame) continue;
      const offset = (frame - item.startFrame) * 2;
      output[0][index] = item.samples[offset] ?? 0;
      if (output[1]) output[1][index] = item.samples[offset + 1] ?? 0;
    }
    return true;
  }
}
registerProcessor('project-share-playback', Playback);
