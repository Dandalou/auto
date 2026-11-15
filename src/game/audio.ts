// Syntetizovaný zvuk motoru, deště a signálů (Web Audio, bez souborů).

export class AudioFx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engGain!: GainNode;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private filter!: BiquadFilterNode;
  private noiseGain!: GainNode;
  enabled = true;

  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(ctx.destination);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 600;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.osc1.connect(this.filter);
    this.osc2.connect(g2).connect(this.filter);
    this.filter.connect(this.engGain).connect(this.master);
    this.osc1.start();
    this.osc2.start();
    // Šum (déšť, vítr, pneumatiky).
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1200;
    nf.Q.value = 0.4;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    src.connect(nf).connect(this.noiseGain).connect(this.master);
    src.start();
  }

  update(rpm: number, throttle: number, speed: number, heavy: boolean, rain: boolean, active: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.enabled && active;
    const base = heavy ? rpm / 60 * 1.5 : rpm / 60 * 2;
    this.osc1.frequency.setTargetAtTime(base, t, 0.05);
    this.osc2.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    this.filter.frequency.setTargetAtTime(300 + throttle * 900 + rpm * 0.05, t, 0.08);
    this.engGain.gain.setTargetAtTime(on ? 0.08 + throttle * 0.12 : 0, t, 0.1);
    const n = (rain ? 0.12 : 0) + Math.min(0.12, speed * 0.003);
    this.noiseGain.gain.setTargetAtTime(this.enabled ? n : 0, t, 0.2);
  }

  beep(freq = 880, dur = 0.12, type: OscillatorType = 'sine') {
    if (!this.ctx || !this.enabled) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = 0.15;
    g.gain.setTargetAtTime(0, this.ctx.currentTime + dur * 0.6, dur * 0.3);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(this.ctx.currentTime + dur * 2);
  }

  chime() {
    this.beep(660, 0.15);
    setTimeout(() => this.beep(880, 0.2), 160);
  }

  crash() {
    this.beep(90, 0.25, 'sawtooth');
  }

  private hornNodes: { o1: OscillatorNode; o2: OscillatorNode; g: GainNode } | null = null;

  horn(on: boolean) {
    if (!this.ctx || !this.enabled) return;
    if (on && !this.hornNodes) {
      const g = this.ctx.createGain();
      g.gain.value = 0.12;
      const o1 = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      o1.type = o2.type = 'square';
      o1.frequency.value = 415;
      o2.frequency.value = 523;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1800;
      o1.connect(f);
      o2.connect(f);
      f.connect(g).connect(this.master);
      o1.start();
      o2.start();
      this.hornNodes = { o1, o2, g };
    } else if (!on && this.hornNodes) {
      const h = this.hornNodes;
      h.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      h.o1.stop(this.ctx.currentTime + 0.1);
      h.o2.stop(this.ctx.currentTime + 0.1);
      this.hornNodes = null;
    }
  }

  private squealGain: GainNode | null = null;

  /** Pískání pneumatik podle míry smyku (0..1). */
  squeal(amount: number) {
    if (!this.ctx) return;
    if (!this.squealGain) {
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2400;
      f.Q.value = 6;
      this.squealGain = this.ctx.createGain();
      this.squealGain.gain.value = 0;
      src.connect(f).connect(this.squealGain).connect(this.master);
      src.start();
    }
    this.squealGain.gain.setTargetAtTime(this.enabled ? Math.min(0.25, amount * 0.3) : 0, this.ctx.currentTime, 0.05);
  }
}
