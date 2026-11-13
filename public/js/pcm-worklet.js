// Runs on the audio thread. The capture AudioContext is created at 16 kHz, so the
// browser has already resampled the mic for us; this just batches 128-frame blocks
// into ~64 ms chunks and hands them to the main thread as Float32.
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.target = 1024; // frames per message at 16 kHz ≈ 64 ms
    this.buf = new Float32Array(this.target);
    this.filled = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;

      this.buf[this.filled++] = v;
      if (this.filled === this.target) {
        this.port.postMessage({ pcm: this.buf.slice(0), peak }, []);
        this.filled = 0;
        peak = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PCMCapture);
