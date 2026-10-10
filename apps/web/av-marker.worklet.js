/* Dev acceptance fixture: observe actual PCM from the returned audio track. */
/* global AudioWorkletProcessor, registerProcessor, currentFrame, sampleRate */
class MarkerMonitor extends AudioWorkletProcessor {
  constructor() { super(); this.loud = false; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let index = 0; index < input.length; index++) {
      const loud = Math.abs(input[index]) > .04;
      if (loud && !this.loud) this.port.postMessage({ time: (currentFrame + index) / sampleRate });
      if (loud) this.last = currentFrame + index;
      this.loud = loud || currentFrame + index - (this.last ?? -Infinity) < sampleRate * .15;
    }
    return true;
  }
}
registerProcessor('av-marker-monitor', MarkerMonitor);
