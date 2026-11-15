import * as THREE from 'three';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

function finish(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Fasáda: jedna dlaždice textury = 1 patro (3 m) × 1 okenní osa (3,3 m). */
export function facadeTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 256;
  const tiles = 4;
  const cell = S / tiles;
  const a = canvas(S, S);
  const b = canvas(S, S);
  a.ctx.fillStyle = '#ffffff';
  a.ctx.fillRect(0, 0, S, S);
  b.ctx.fillStyle = '#000';
  b.ctx.fillRect(0, 0, S, S);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let j = 0; j < tiles; j++) {
    for (let i = 0; i < tiles; i++) {
      const x = i * cell;
      const y = j * cell;
      // Římsa mezi patry.
      a.ctx.fillStyle = 'rgba(0,0,0,0.10)';
      a.ctx.fillRect(x, y + cell - 4, cell, 4);
      // Okno.
      const wx = x + cell * 0.28;
      const wy = y + cell * 0.2;
      const ww = cell * 0.44;
      const wh = cell * 0.5;
      a.ctx.fillStyle = '#e8e4dc';
      a.ctx.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
      a.ctx.fillStyle = '#3b4652';
      a.ctx.fillRect(wx, wy, ww, wh);
      a.ctx.fillStyle = 'rgba(190,210,230,0.35)';
      a.ctx.fillRect(wx, wy, ww * 0.45, wh * 0.5);
      a.ctx.fillStyle = '#d8d4cc';
      a.ctx.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
      a.ctx.fillRect(wx, wy + wh * 0.35, ww, 3);
      if (rnd() < 0.42) {
        const warm = rnd();
        b.ctx.fillStyle = warm < 0.7 ? '#ffd58a' : warm < 0.9 ? '#fff0c8' : '#bcd4ff';
        b.ctx.fillRect(wx, wy, ww, wh);
      }
    }
  }
  return { map: finish(a.c), emissive: finish(b.c) };
}

/** Asfalt; v = délka (8 m na opakování), u = příčně 0..1. */
export function roadTexture(marked: boolean): THREE.CanvasTexture {
  const W = 128;
  const H = 256;
  const { c, ctx } = canvas(W, H);
  ctx.fillStyle = '#4a4c50';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 2500; i++) {
    const v = 60 + Math.random() * 40;
    ctx.fillStyle = `rgba(${v},${v},${v + 3},0.5)`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
  }
  // Vyjeté stopy.
  ctx.fillStyle = 'rgba(30,30,32,0.18)';
  ctx.fillRect(W * 0.18, 0, W * 0.1, H);
  ctx.fillRect(W * 0.72, 0, W * 0.1, H);
  if (marked) {
    ctx.fillStyle = '#e9e7df';
    ctx.fillRect(3, 0, 3, H);
    ctx.fillRect(W - 6, 0, 3, H);
    // Přerušovaná osa: 3 m čára / 5 m mezera.
    ctx.fillRect(W / 2 - 1.5, 0, 3, H * (3 / 8));
  }
  const t = finish(c);
  t.anisotropy = 8;
  return t;
}

export function pathTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 64);
  ctx.fillStyle = '#b8ab8e';
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 300; i++) {
    const v = 150 + Math.random() * 60;
    ctx.fillStyle = `rgba(${v},${v - 10},${v - 30},0.6)`;
    ctx.fillRect(Math.random() * 64, Math.random() * 64, 2, 2);
  }
  return finish(c);
}

export function railTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 128);
  ctx.fillStyle = '#6d6459';
  ctx.fillRect(0, 0, 64, 128);
  ctx.fillStyle = '#4a3a2c';
  for (let y = 0; y < 128; y += 16) ctx.fillRect(8, y, 48, 7);
  ctx.fillStyle = '#9a9ca0';
  ctx.fillRect(18, 0, 4, 128);
  ctx.fillRect(42, 0, 4, 128);
  return finish(c);
}
