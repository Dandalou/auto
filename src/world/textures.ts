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
  ctx.fillStyle = '#868d99';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) {
    const v = 120 + Math.random() * 30;
    ctx.fillStyle = `rgba(${v},${v + 4},${v + 12},0.35)`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  // Krajnice: světlejší okraj.
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.18)');
  g.addColorStop(0.06, 'rgba(255,255,255,0)');
  g.addColorStop(0.94, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0.18)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (marked) {
    ctx.fillStyle = 'rgba(248,248,242,0.9)';
    ctx.fillRect(5, 0, 3, H);
    ctx.fillRect(W - 8, 0, 3, H);
    ctx.fillRect(W / 2 - 1.5, 0, 3, H * (3 / 8));
  }
  const t = finish(c);
  t.anisotropy = 8;
  return t;
}

/** Panelový dům: 4 patra × 4 sekce na dlaždici textury (stejné měřítko jako fasády). */
export function panelTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 256;
  const cell = S / 4;
  const a = canvas(S, S);
  const b = canvas(S, S);
  a.ctx.fillStyle = '#ffffff';
  a.ctx.fillRect(0, 0, S, S);
  b.ctx.fillStyle = '#000';
  b.ctx.fillRect(0, 0, S, S);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const x = i * cell, y = j * cell;
      // Spáry mezi panely.
      a.ctx.fillStyle = 'rgba(0,0,0,0.12)';
      a.ctx.fillRect(x, y + cell - 2, cell, 2);
      a.ctx.fillRect(x + cell - 2, y, 2, cell);
      const loggia = (i + j * 3) % 4 === 1;
      if (loggia) {
        // Lodžie: tmavý zapuštěný prostor se zábradlím.
        a.ctx.fillStyle = '#4a4f55';
        a.ctx.fillRect(x + 6, y + 8, cell - 12, cell - 18);
        a.ctx.fillStyle = 'rgba(255,255,255,0.85)';
        a.ctx.fillRect(x + 6, y + cell * 0.55, cell - 12, cell * 0.25);
      } else {
        a.ctx.fillStyle = '#e6e2da';
        a.ctx.fillRect(x + 8, y + 14, cell - 16, cell * 0.42 + 4);
        a.ctx.fillStyle = '#3d4854';
        a.ctx.fillRect(x + 10, y + 16, cell - 20, cell * 0.42);
        a.ctx.fillStyle = 'rgba(200,220,235,0.3)';
        a.ctx.fillRect(x + 10, y + 16, (cell - 20) * 0.4, cell * 0.42);
        a.ctx.fillStyle = '#e6e2da';
        a.ctx.fillRect(x + cell / 2 - 1, y + 16, 2, cell * 0.42);
      }
      if (((i * 7 + j * 5) % 10) < 4) {
        b.ctx.fillStyle = (i + j) % 3 ? '#ffd58a' : '#fff0c8';
        b.ctx.fillRect(x + 10, y + 16, cell - 20, cell * 0.42);
      }
    }
  }
  return { map: finish(a.c), emissive: finish(b.c) };
}

/** Rodinný dům: menší okna s okenicemi, 4 × 4 buňky na dlaždici textury. */
export function houseTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 256, cell = 64;
  const a = canvas(S, S);
  const b = canvas(S, S);
  a.ctx.fillStyle = '#ffffff';
  a.ctx.fillRect(0, 0, S, S);
  b.ctx.fillStyle = '#000';
  b.ctx.fillRect(0, 0, S, S);
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const x = i * cell, y = j * cell;
      if ((i + j) % 3 === 2) continue; // místy holá zeď
      const ww = 22, wh = 26;
      const wx = x + (cell - ww) / 2, wy = y + 16;
      // Okenice.
      a.ctx.fillStyle = (i + j) % 2 ? '#6b4a32' : '#3f5a3c';
      a.ctx.fillRect(wx - 9, wy, 8, wh);
      a.ctx.fillRect(wx + ww + 1, wy, 8, wh);
      a.ctx.fillStyle = '#f2efe8';
      a.ctx.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
      a.ctx.fillStyle = '#3d4652';
      a.ctx.fillRect(wx, wy, ww, wh);
      a.ctx.fillStyle = '#f2efe8';
      a.ctx.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      a.ctx.fillRect(wx, wy + wh / 2 - 1, ww, 2);
      if ((i * 3 + j) % 4 === 0) {
        b.ctx.fillStyle = '#ffd08a';
        b.ctx.fillRect(wx, wy, ww, wh);
      }
    }
  }
  return { map: finish(a.c), emissive: finish(b.c) };
}

/** Hala: trapézový plech s pásem oken nahoře. */
export function hallTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const S = 256;
  const a = canvas(S, S);
  const b = canvas(S, S);
  a.ctx.fillStyle = '#ffffff';
  a.ctx.fillRect(0, 0, S, S);
  for (let x = 0; x < S; x += 8) {
    a.ctx.fillStyle = 'rgba(0,0,0,0.10)';
    a.ctx.fillRect(x, 0, 3, S);
    a.ctx.fillStyle = 'rgba(255,255,255,0.25)';
    a.ctx.fillRect(x + 4, 0, 1, S);
  }
  b.ctx.fillStyle = '#000';
  b.ctx.fillRect(0, 0, S, S);
  // Pás oken v horní části každého 12m bloku (textura = 12 m výšky).
  a.ctx.fillStyle = '#4a5866';
  a.ctx.fillRect(0, 20, S, 22);
  a.ctx.fillStyle = 'rgba(200,220,235,0.35)';
  for (let x = 0; x < S; x += 32) a.ctx.fillRect(x + 2, 22, 14, 18);
  a.ctx.fillStyle = '#d9d9d9';
  for (let x = 0; x < S; x += 32) a.ctx.fillRect(x, 20, 2, 22);
  b.ctx.fillStyle = '#e8f0ff';
  b.ctx.fillRect(0, 20, S, 22);
  // Sokl.
  a.ctx.fillStyle = 'rgba(0,0,0,0.18)';
  a.ctx.fillRect(0, S - 18, S, 18);
  return { map: finish(a.c), emissive: finish(b.c) };
}

/** Pomocník: mřížka 4 × 4 buněk (1 buňka = 1 patro × 1 okenní osa). */
function cells(draw: (ctx: CanvasRenderingContext2D, e: CanvasRenderingContext2D, x: number, y: number, c: number, i: number, j: number) => void, base = '#ffffff') {
  const S = 256, c = 64;
  const a = canvas(S, S);
  const b = canvas(S, S);
  a.ctx.fillStyle = base;
  a.ctx.fillRect(0, 0, S, S);
  b.ctx.fillStyle = '#000';
  b.ctx.fillRect(0, 0, S, S);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) draw(a.ctx, b.ctx, i * c, j * c, c, i, j);
  return { map: finish(a.c), emissive: finish(b.c) };
}

function lit(e: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, k: number) {
  if (k % 10 < 4) {
    e.fillStyle = k % 3 ? '#ffd58a' : '#fff0c8';
    e.fillRect(x, y, w, h);
  }
}

/** Historický činžák: vysoká okna s šambránou a nadokenní římsou, kordonové římsy. */
export function historicTextures() {
  return cells((a, e, x, y, c, i, j) => {
    a.fillStyle = 'rgba(255,255,255,0.35)';
    a.fillRect(x, y + c - 7, c, 4); // římsa
    a.fillStyle = 'rgba(0,0,0,0.12)';
    a.fillRect(x, y + c - 3, c, 3);
    const ww = 22, wh = 36, wx = x + (c - ww) / 2, wy = y + 12;
    a.fillStyle = 'rgba(255,255,255,0.55)';
    a.fillRect(wx - 5, wy - 9, ww + 10, 6); // nadokenní římsa
    a.fillRect(wx - 4, wy - 3, ww + 8, wh + 6); // šambrána
    a.fillStyle = 'rgba(0,0,0,0.18)';
    a.fillRect(wx - 5, wy - 3, ww + 10, 2);
    a.fillStyle = '#34404c';
    a.fillRect(wx, wy, ww, wh);
    a.fillStyle = 'rgba(200,215,230,0.3)';
    a.fillRect(wx, wy, ww * 0.45, wh * 0.5);
    a.fillStyle = '#efe9dc';
    a.fillRect(wx + ww / 2 - 1, wy, 2, wh);
    a.fillRect(wx, wy + wh * 0.62, ww, 2);
    a.fillStyle = 'rgba(255,255,255,0.5)';
    a.fillRect(wx - 3, wy + wh + 2, ww + 6, 4); // parapet
    lit(e, wx, wy, ww, wh, i * 7 + j * 3);
  });
}

/** Moderní bytový dům: velká okna, šedé rámy, balkony místy. */
export function modernTextures() {
  return cells((a, e, x, y, c, i, j) => {
    a.fillStyle = 'rgba(0,0,0,0.06)';
    a.fillRect(x, y + c - 2, c, 2);
    const ww = 46, wh = 38, wx = x + (c - ww) / 2, wy = y + 10;
    a.fillStyle = '#4a4f55';
    a.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
    a.fillStyle = '#5f7486';
    a.fillRect(wx, wy, ww, wh);
    a.fillStyle = 'rgba(220,235,245,0.35)';
    a.fillRect(wx, wy, ww * 0.4, wh);
    a.fillStyle = '#4a4f55';
    a.fillRect(wx + ww * 0.6, wy, 2, wh);
    if ((i + j * 2) % 3 === 0) {
      a.fillStyle = 'rgba(40,40,45,0.55)';
      a.fillRect(wx - 4, wy + wh * 0.55, ww + 8, 3);
      a.fillStyle = 'rgba(220,225,230,0.5)';
      a.fillRect(wx - 4, wy + wh * 0.58, ww + 8, wh * 0.42);
    }
    lit(e, wx, wy, ww, wh, i * 5 + j * 7);
  });
}

/** Kancelářská budova: prosklená fasáda s rastrem. */
export function officeTextures() {
  return cells((a, e, x, y, c, i, j) => {
    a.fillStyle = '#8f9ea9';
    a.fillRect(x, y, c, c);
    const g = a.createLinearGradient(x, y, x + c, y + c);
    g.addColorStop(0, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0.12)');
    a.fillStyle = g;
    a.fillRect(x, y, c, c);
    // Parapetní pás mezi patry (beton/kamenný obklad).
    a.fillStyle = '#d6d8d6';
    a.fillRect(x, y + c - 14, c, 14);
    a.fillRect(x, y, 2, c);
    a.fillRect(x + c / 2 - 1, y, 2, c - 6);
    if ((i * 3 + j * 5) % 10 < 3) {
      e.fillStyle = '#f2f6ff';
      e.fillRect(x + 2, y, c - 2, c - 6);
    }
  }, '#8f9ea9');
}

/** Garáže: plechová vrata. */
export function garageTextures() {
  return cells((a, _e, x, y, c) => {
    a.fillStyle = 'rgba(0,0,0,0.08)';
    a.fillRect(x, y, c, c);
    a.fillStyle = '#c9ccce';
    a.fillRect(x + 6, y + 14, c - 12, c - 14);
    a.fillStyle = 'rgba(0,0,0,0.15)';
    for (let k = y + 18; k < y + c; k += 6) a.fillRect(x + 6, k, c - 12, 2);
  });
}

/** Dřevostavba / roubenka: vodorovné trámy a malá okna. */
export function woodTextures() {
  return cells((a, e, x, y, c, i, j) => {
    for (let k = 0; k < c; k += 8) {
      a.fillStyle = k % 16 ? '#8a6243' : '#7a5538';
      a.fillRect(x, y + k, c, 7);
      a.fillStyle = 'rgba(0,0,0,0.25)';
      a.fillRect(x, y + k + 7, c, 1);
    }
    if ((i + j) % 2 === 0) {
      const wx = x + 20, wy = y + 18;
      a.fillStyle = '#f3efe6';
      a.fillRect(wx - 2, wy - 2, 28, 28);
      a.fillStyle = '#34404c';
      a.fillRect(wx, wy, 24, 24);
      a.fillStyle = '#f3efe6';
      a.fillRect(wx + 11, wy, 2, 24);
      a.fillRect(wx, wy + 11, 24, 2);
      lit(e, wx, wy, 24, 24, i * 3 + j);
    }
  }, '#8a6243');
}

/** Dlažba chodníku: u = příčně (2,4 m), v = délka (8 m na opakování). */
export function sidewalkTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 256);
  ctx.fillStyle = '#c4c0b6';
  ctx.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 600; i++) {
    const v = 175 + Math.random() * 35;
    ctx.fillStyle = `rgba(${v},${v - 3},${v - 10},0.5)`;
    ctx.fillRect(Math.random() * 64, Math.random() * 256, 2, 2);
  }
  ctx.strokeStyle = 'rgba(120,115,105,0.35)';
  ctx.lineWidth = 1;
  for (let y = 0; y < 256; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(64, y + 0.5);
    ctx.stroke();
  }
  for (const x of [21, 42]) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, 256);
    ctx.stroke();
  }
  // Světlejší obrubník u kraje.
  ctx.fillStyle = '#dcd8cf';
  ctx.fillRect(0, 0, 3, 256);
  ctx.fillRect(61, 0, 3, 256);
  return finish(c);
}

/** Výlohy v přízemí: jedna dlaždice = 5,5 m šířky × celé přízemí. */
export function shopTexture(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const W = 256, H = 192;
  const { c, ctx } = canvas(W, H);
  const e = canvas(W, H);
  e.ctx.fillStyle = '#000';
  e.ctx.fillRect(0, 0, W, H);
  e.ctx.fillStyle = '#ffe2a8';
  e.ctx.fillRect(22, 62, 138, H - 70);
  e.ctx.fillStyle = '#fff6e0';
  e.ctx.fillRect(10, 18, W - 20, 26);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Pás pro nápis.
  const signs = ['#7a2f2a', '#2f4f6f', '#3f5f3a', '#6a5a2a', '#4a3a5a'];
  ctx.fillStyle = signs[Math.floor(Math.random() * signs.length)];
  ctx.fillRect(10, 18, W - 20, 26);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (let i = 0; i < 8; i++) ctx.fillRect(24 + i * 26, 27, 16, 8);
  // Výloha.
  ctx.fillStyle = '#3a3f46';
  ctx.fillRect(16, 56, 150, H - 56);
  ctx.fillStyle = '#5d6f80';
  ctx.fillRect(22, 62, 138, H - 70);
  ctx.fillStyle = 'rgba(220,235,245,0.35)';
  ctx.fillRect(22, 62, 60, H - 70);
  ctx.fillStyle = '#3a3f46';
  ctx.fillRect(89, 62, 4, H - 70);
  // Dveře.
  ctx.fillStyle = '#3a3f46';
  ctx.fillRect(180, 56, 60, H - 56);
  ctx.fillStyle = '#6a5040';
  ctx.fillRect(186, 62, 48, H - 62);
  ctx.fillStyle = '#d9c9a0';
  ctx.fillRect(226, 120, 4, 10);
  // Sokl.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(0, H - 6, W, 6);
  return { map: finish(c), emissive: finish(e.c) };
}

/** Zebra: u = napříč silnicí (1 opakování = 1 m: 0,5 m bílá, 0,5 m mezera), průhledné mezery. */
export function zebraTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 64);
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = 'rgba(245,245,238,0.95)';
  ctx.fillRect(4, 0, 28, 64);
  for (let i = 0; i < 80; i++) {
    ctx.clearRect(4 + Math.random() * 28, Math.random() * 64, 1.5, 1.5);
  }
  return finish(c);
}

export function pathTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 64);
  ctx.fillStyle = '#ddd2b6';
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 300; i++) {
    const v = 150 + Math.random() * 60;
    ctx.fillStyle = `rgba(${v},${v - 10},${v - 30},0.6)`;
    ctx.fillRect(Math.random() * 64, Math.random() * 64, 2, 2);
  }
  return finish(c);
}

/** Tramvajová trať ve vozovce: dvě žlábkové kolejnice v asfaltu/dlažbě, průhledné okraje. */
export function tramRailTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 64);
  ctx.clearRect(0, 0, 64, 64);
  // Pás kolem kolejnic (tmavší, vyspravovaný asfalt).
  ctx.fillStyle = 'rgba(95,98,104,0.55)';
  ctx.fillRect(8, 0, 48, 64);
  for (const x of [17, 45]) {
    ctx.fillStyle = '#3a3c40';
    ctx.fillRect(x - 3, 0, 6, 64);
    ctx.fillStyle = '#b8bcc2';
    ctx.fillRect(x - 1.5, 0, 2, 64);
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
