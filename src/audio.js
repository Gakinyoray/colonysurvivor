// Lightweight WebAudio sound effects. The original SWF ships ~20 mp3 clips
// (zombie moans/bashes, sniper shots, tower build/destroy). We synthesise
// short tonal stand-ins so the recreation has audio feedback without
// redistributing the original copyrighted assets.
export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.lastPlay = {};
  }
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { this.enabled = false; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  // throttle a sound so bursts don't overwhelm
  throttle(name, ms) {
    const now = performance.now();
    if (this.lastPlay[name] && now - this.lastPlay[name] < ms) return false;
    this.lastPlay[name] = now;
    return true;
  }
  blip(freq, dur, type = 'square', gain = 0.06) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.ctx.destination);
    osc.start(t); osc.stop(t + dur);
  }
  noise(dur, gain = 0.05) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(this.ctx.destination); src.start(t);
  }
  shot() { if (this.throttle('shot', 40)) this.noise(0.08, 0.08); }
  bash() { if (this.throttle('bash', 60)) this.blip(90, 0.1, 'square', 0.08); }
  moan() { if (this.throttle('moan', 600)) this.blip(120 + Math.random() * 40, 0.4, 'sawtooth', 0.04); }
  death() { if (this.throttle('death', 50)) this.blip(70, 0.2, 'sawtooth', 0.06); }
  build() { this.blip(440, 0.08); this.blip(660, 0.08); }
  destroyed() { this.blip(200, 0.3, 'sawtooth', 0.1); this.noise(0.2, 0.08); }
  horde() { this.blip(80, 0.6, 'sawtooth', 0.07); }
}
