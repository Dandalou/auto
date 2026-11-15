// Kruhová minimapa: kreslí stejné textury dlaždic jako terén, trasu a cíl.

import type { Game } from '../game/game';

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private t = 0;
  private isDirty = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = 220 * dpr;
    canvas.height = 220 * dpr;
  }

  dirty() {
    this.isDirty = true;
  }

  draw(g: Game) {
    const now = performance.now();
    if (now - this.t < 50 && !this.isDirty) return;
    this.t = now;
    this.isDirty = false;
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const px = g.px, pz = g.pz;
    const heading = g.walking ? g.walker.heading : g.vehicle.heading;
    const speed = g.walking ? 0 : g.vehicle.speed;
    const scale = (W / 220) * (g.walking ? 0.9 : 0.55 - Math.min(0.3, speed * 0.008)); // px na metr
    c.save();
    c.fillStyle = '#2b3a2a';
    c.fillRect(0, 0, W, H);
    c.translate(W / 2, H / 2);
    c.rotate(-heading);
    c.imageSmoothingEnabled = true;
    for (const t of g.world.minimapTiles()) {
      const x = (t.ox - px) * scale;
      const y = (t.oz - pz) * scale;
      const s = t.size * scale;
      if (x > W || y > H || x + s < -W || y + s < -H) continue;
      c.drawImage(t.img, x, y, s + 0.5, s + 0.5);
    }
    // Trasa.
    if (g.navPts && g.navPts.length > 1) {
      c.strokeStyle = '#47e07a';
      c.lineWidth = 4 * (W / 220);
      c.lineJoin = 'round';
      c.lineCap = 'round';
      c.beginPath();
      g.navPts.forEach(([x, z], i) => {
        const sx = (x - px) * scale, sy = (z - pz) * scale;
        if (i === 0) c.moveTo(sx, sy);
        else c.lineTo(sx, sy);
      });
      c.stroke();
    }
    // Firemní linky.
    for (const l of g.state.company?.lines ?? []) {
      c.strokeStyle = 'rgba(226,72,61,0.7)';
      c.lineWidth = 2 * (W / 220);
      c.beginPath();
      l.path.forEach(([x, z], i) => {
        const sx = (x - px) * scale, sy = (z - pz) * scale;
        if (i === 0) c.moveTo(sx, sy);
        else c.lineTo(sx, sy);
      });
      c.stroke();
    }
    // Čerpací stanice.
    for (const f of g.world.allFuel()) {
      const sx = (f.x - px) * scale, sy = (f.z - pz) * scale;
      if (Math.abs(sx) > W / 2 || Math.abs(sy) > H / 2) continue;
      c.fillStyle = '#f2a23a';
      c.strokeStyle = '#3a2a10';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(sx, sy, 5 * (W / 220), 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    // Ostatní vozidla.
    c.fillStyle = '#ffffff';
    for (const car of g.traffic.cars) {
      const sx = (car.x - px) * scale, sy = (car.z - pz) * scale;
      if (Math.abs(sx) > W || Math.abs(sy) > H) continue;
      c.fillRect(sx - 2, sy - 2, 4, 4);
    }
    // Zaparkované auto při chůzi.
    if (g.walking) {
      c.fillStyle = '#5aa9e6';
      c.beginPath();
      c.arc((g.vehicle.x - px) * scale, (g.vehicle.z - pz) * scale, 5 * (W / 220), 0, Math.PI * 2);
      c.fill();
    }
    // Cíl (i mimo dosah – na okraji).
    const t = g.job?.target();
    if (t) {
      let sx = (t.x - px) * scale, sy = (t.z - pz) * scale;
      const r = Math.hypot(sx, sy);
      const max = W / 2 - 10;
      if (r > max) {
        sx = (sx / r) * max;
        sy = (sy / r) * max;
      }
      c.fillStyle = '#ffd34a';
      c.strokeStyle = '#000';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(sx, sy, 7 * (W / 220), 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    c.restore();
    // Hráč.
    c.save();
    c.translate(W / 2, H / 2);
    const k = W / 220;
    c.fillStyle = '#e2483d';
    c.strokeStyle = '#fff';
    c.lineWidth = 2 * k;
    c.beginPath();
    c.moveTo(0, -10 * k);
    c.lineTo(7 * k, 8 * k);
    c.lineTo(0, 4 * k);
    c.lineTo(-7 * k, 8 * k);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
    // Sever.
    c.save();
    c.translate(W / 2, H / 2);
    c.rotate(-heading);
    c.fillStyle = '#fff';
    c.font = `bold ${13 * k}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('S', 0, -(H / 2 - 14 * k));
    c.restore();
  }
}
