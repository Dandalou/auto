/// <reference lib="webworker" />
// Worker, který z reálných dat postaví jednu dlaždici světa:
//  - výšky terénu z AWS Terrain Tiles (Terrarium PNG),
//  - budovy, silnice, lesy, vodu, zastávky a adresy z OpenFreeMap (OpenStreetMap, schéma OpenMapTiles).
// Vše těžké (dekódování, triangulace, kreslení textury) běží tady, hlavní vlákno jen vytvoří meshe.

import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';
import { gridHeight, type HeightGrid } from './heightgrid';
import type {
  Colliders, MeshArrays, NamedPoint, PlacePoint, RoadLine, StreetLine, TileData, TileRequest,
} from './types';
import { TILE_M } from '../geo';

declare const self: DedicatedWorkerGlobalScope;

const EXTENT = 4096;
const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// ---------------------------------------------------------------- stahování

async function fetchRetry(url: string, tries = 3): Promise<Response | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      if (r.status === 404 || r.status === 204) return null;
    } catch {
      /* zkusit znovu */
    }
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  return null;
}

const elevCache = new Map<string, Promise<Float32Array | null>>();

function loadElevation(z: number, x: number, y: number): Promise<Float32Array | null> {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  let p = elevCache.get(key);
  if (p) {
    elevCache.delete(key);
    elevCache.set(key, p);
    return p;
  }
  p = (async () => {
    const r = await fetchRetry(`${TERRAIN_URL}/${key}.png`);
    if (!r) return null;
    const bmp = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(256, 256);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(256 * 256);
    for (let i = 0; i < out.length; i++) {
      out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
    }
    return out;
  })();
  elevCache.set(key, p);
  while (elevCache.size > 96) elevCache.delete(elevCache.keys().next().value!);
  return p;
}

/** Vzorkovač nadmořské výšky v globálních pixelech zvolené úrovně zoomu. */
class ElevSampler {
  tiles = new Map<string, Float32Array | null>();
  constructor(public ez: number) {}

  async prepare(x0: number, y0: number, x1: number, y1: number) {
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) {
      for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) {
        const k = `${tx}/${ty}`;
        if (this.tiles.has(k)) continue;
        jobs.push(loadElevation(this.ez, tx, ty).then((t) => void this.tiles.set(k, t)));
      }
    }
    await Promise.all(jobs);
  }

  px(ix: number, iy: number): number {
    const tx = Math.floor(ix / 256);
    const ty = Math.floor(iy / 256);
    const t = this.tiles.get(`${tx}/${ty}`);
    if (!t) return 0;
    const h = t[(iy - ty * 256) * 256 + (ix - tx * 256)];
    // Moře a díry v datech.
    return h < -100 ? 0 : h;
  }

  sample(gx: number, gy: number): number {
    const x = gx - 0.5;
    const y = gy - 0.5;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const a = this.px(ix, iy);
    const b = this.px(ix + 1, iy);
    const c = this.px(ix, iy + 1);
    const d = this.px(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
}

async function loadVector(url: string): Promise<VectorTile | null> {
  const r = await fetchRetry(url);
  if (!r) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  return new VectorTile(new PbfReader(buf));
}

// ---------------------------------------------------------------- pomocné

class FloatBuf {
  a: Float32Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Float32Array(cap);
  }
  push(...v: number[]) {
    if (this.n + v.length > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + v.length));
      b.set(this.a);
      this.a = b;
    }
    for (let i = 0; i < v.length; i++) this.a[this.n++] = v[i];
  }
  out(): Float32Array {
    return this.a.slice(0, this.n);
  }
}

class MeshBuf {
  pos = new FloatBuf(4096);
  nor = new FloatBuf(4096);
  uv = new FloatBuf(2048);
  col = new FloatBuf(4096);
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0, c?: number[]) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    if (c) this.col.push(c[0], c[1], c[2]);
  }
  get empty() {
    return this.pos.n === 0;
  }
  arrays(withUv: boolean, withCol: boolean): MeshArrays {
    const m: MeshArrays = { pos: this.pos.out(), nor: this.nor.out() };
    if (withUv) m.uv = this.uv.out();
    if (withCol) m.col = this.col.out();
    return m;
  }
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Pt = { x: number; y: number };

function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].y - r[i].x * r[j].y;
  return a / 2;
}

/** Ořízne lomenou čáru obdélníkem [0, E]² (Liang–Barsky), vrátí souvislé úseky. */
function clipLine(line: Pt[], E: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x, E - a.x, a.y, E - a.y];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) ok = false;
      } else {
        const t = q[k] / p[k];
        if (p[k] < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const pa = { x: a.x + dx * t0, y: a.y + dy * t0 };
    const pb = { x: a.x + dx * t1, y: a.y + dy * t1 };
    if (cur.length === 0) cur.push(pa);
    else {
      const l = cur[cur.length - 1];
      if (Math.abs(l.x - pa.x) > 1e-6 || Math.abs(l.y - pa.y) > 1e-6) {
        if (cur.length > 1) out.push(cur);
        cur = [pa];
      }
    }
    cur.push(pb);
    if (t1 < 1) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- styl

const ROAD_WIDTH: Record<string, number> = {
  motorway: 9, trunk: 8.5, primary: 8, secondary: 7.2, tertiary: 6.5, minor: 5.6, service: 3.8,
  busway: 6.5, raceway: 9, track: 3, path: 1.8,
};
const ROAD_PRIO: Record<string, number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5, busway: 4, minor: 4, raceway: 4,
  service: 3, track: 2, path: 1,
};
export const DRIVABLE = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'busway', 'raceway', 'track',
]);
const MARKED = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'busway']);

const LANDCOVER_COL: Record<string, string> = {
  wood: '#3d6331', grass: '#86ab55', farmland: '#b9b06a', wetland: '#6f8f63', sand: '#d8cc9a',
  rock: '#9c968c', ice: '#eef4f6',
};
const LANDUSE_COL: Record<string, string> = {
  residential: '#b7b19f', suburb: '#b7b19f', neighbourhood: '#b7b19f', quarter: '#b7b19f',
  commercial: '#b9ada0', retail: '#b9ada0', industrial: '#a9a49a', garages: '#a9a49a', railway: '#a69f92',
  cemetery: '#7f9a62', school: '#bdb39c', university: '#bdb39c', college: '#bdb39c', kindergarten: '#bdb39c',
  hospital: '#c0b2a6', military: '#a2a088', quarry: '#b8ad98', pitch: '#7bab55', playground: '#a8b77e',
  stadium: '#8fb067', track: '#b98f72', zoo: '#93ad6a', theme_park: '#a3b07a', dam: '#a9a49a',
};

function drawFeature(
  ctx: OffscreenCanvasRenderingContext2D, f: VectorTileFeature, s: number, closePath: boolean,
) {
  ctx.beginPath();
  for (const ring of f.loadGeometry()) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (i === 0) ctx.moveTo(p.x * s, p.y * s);
      else ctx.lineTo(p.x * s, p.y * s);
    }
    if (closePath) ctx.closePath();
  }
}

function paintGround(vt: VectorTile | null, S: number, sizeM: number, seed: number, detailed: boolean): OffscreenCanvas {
  const c = new OffscreenCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const s = S / EXTENT;
  const pxPerM = S / sizeM;
  ctx.fillStyle = '#8eaa5c';
  ctx.fillRect(0, 0, S, S);
  // Jemný šum, aby plochy nebyly ploché.
  const rnd = mulberry(seed);
  for (let i = 0; i < (detailed ? 2600 : 600); i++) {
    const r = rnd();
    ctx.fillStyle = r < 0.5 ? 'rgba(40,60,20,0.07)' : 'rgba(255,255,220,0.06)';
    const w = (2 + rnd() * 10) * (S / 1024);
    ctx.fillRect(rnd() * S, rnd() * S, w, w);
  }
  if (!vt) return c;
  const L = vt.layers;
  const each = (name: string, fn: (f: VectorTileFeature) => void) => {
    const l = L[name];
    if (!l) return;
    for (let i = 0; i < l.length; i++) fn(l.feature(i));
  };
  // Zastavěné území: kolem budov zpevněné plochy (dvory, chodníky), i kde OSM nemá landuse.
  if (detailed) {
    ctx.lineJoin = 'round';
    each('building', (f) => {
      drawFeature(ctx, f, s, true);
      ctx.strokeStyle = '#aaa597';
      ctx.lineWidth = 16 * pxPerM;
      ctx.stroke();
      ctx.fillStyle = '#aaa597';
      ctx.fill('evenodd');
    });
  }
  each('landuse', (f) => {
    const col = LANDUSE_COL[String(f.properties.class)];
    if (!col) return;
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = col;
    ctx.fill('evenodd');
  });
  each('landcover', (f) => {
    const col = LANDCOVER_COL[String(f.properties.class)];
    if (!col) return;
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = col;
    ctx.fill('evenodd');
  });
  each('park', (f) => {
    if (f.type !== 3) return;
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = 'rgba(120,170,80,0.25)';
    ctx.fill('evenodd');
  });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  each('waterway', (f) => {
    const cls = String(f.properties.class);
    const w = cls === 'river' ? 14 : cls === 'canal' ? 8 : 3;
    drawFeature(ctx, f, s, false);
    ctx.strokeStyle = '#4b7aa6';
    ctx.lineWidth = Math.max(1, w * pxPerM);
    ctx.stroke();
  });
  each('water', (f) => {
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = '#4b7aa6';
    ctx.fill('evenodd');
  });
  each('aeroway', (f) => {
    drawFeature(ctx, f, s, f.type === 3);
    if (f.type === 3) {
      ctx.fillStyle = '#9a9a96';
      ctx.fill('evenodd');
    } else {
      ctx.strokeStyle = '#8c8c88';
      ctx.lineWidth = 40 * pxPerM;
      ctx.stroke();
    }
  });
  // Silnice: nejdřív nižší třídy.
  const roads: VectorTileFeature[] = [];
  each('transportation', (f) => {
    if (f.type === 2) roads.push(f);
  });
  roads.sort((a, b) => (ROAD_PRIO[String(a.properties.class)] ?? 0) - (ROAD_PRIO[String(b.properties.class)] ?? 0));
  for (const f of roads) {
    const cls = String(f.properties.class);
    if (f.properties.brunnel === 'tunnel') continue;
    let w = ROAD_WIDTH[cls];
    let col = '#55575a';
    if (cls === 'rail' || cls === 'transit') {
      w = 3.2;
      col = '#6b6157';
    } else if (cls === 'path') {
      col = '#c9bea4';
    } else if (cls === 'track') {
      col = '#a89a76';
    }
    if (!w) continue;
    drawFeature(ctx, f, s, false);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(detailed ? 1 : 1.5, w * pxPerM * (detailed ? 1 : 1.6));
    ctx.stroke();
  }
  each('building', (f) => {
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = '#8e857a';
    ctx.fill('evenodd');
  });
  return c;
}

// ---------------------------------------------------------------- terén

function buildTerrain(grid: HeightGrid): MeshArrays {
  const { n, size, h } = grid;
  const w = n + 1;
  const pos = new Float32Array(w * w * 3);
  const nor = new Float32Array(w * w * 3);
  const uv = new Float32Array(w * w * 2);
  const e = size / n;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * w + i;
      pos[k * 3] = i * e;
      pos[k * 3 + 1] = h[k];
      pos[k * 3 + 2] = j * e;
      const hl = h[j * w + Math.max(0, i - 1)];
      const hr = h[j * w + Math.min(n, i + 1)];
      const hu = h[Math.max(0, j - 1) * w + i];
      const hd = h[Math.min(n, j + 1) * w + i];
      const sx = (i > 0 && i < n ? 2 : 1) * e;
      const sz = (j > 0 && j < n ? 2 : 1) * e;
      let nx = -(hr - hl) / sx;
      let nz = -(hd - hu) / sz;
      const l = Math.hypot(nx, 1, nz);
      nx /= l;
      nz /= l;
      nor[k * 3] = nx;
      nor[k * 3 + 1] = 1 / l;
      nor[k * 3 + 2] = nz;
      uv[k * 2] = i / n;
      uv[k * 2 + 1] = j / n;
    }
  }
  return { pos, nor, uv };
}

// ---------------------------------------------------------------- budovy

const FACADES = [
  [0.93, 0.89, 0.8], [0.9, 0.86, 0.74], [0.85, 0.82, 0.78], [0.95, 0.93, 0.88], [0.86, 0.76, 0.62],
  [0.8, 0.84, 0.82], [0.93, 0.84, 0.72], [0.78, 0.76, 0.74], [0.9, 0.8, 0.66], [0.82, 0.86, 0.9],
];
const ROOFS = [
  [0.62, 0.27, 0.2], [0.55, 0.24, 0.18], [0.45, 0.42, 0.4], [0.36, 0.33, 0.33], [0.6, 0.35, 0.25],
];
const FLAT_ROOF = [0.5, 0.49, 0.47];

const COLOUR_NAMES: Record<string, number[]> = {
  white: [0.95, 0.95, 0.93], lightgrey: [0.82, 0.82, 0.8], grey: [0.62, 0.62, 0.6], gray: [0.62, 0.62, 0.6],
  yellow: [0.94, 0.87, 0.55], beige: [0.9, 0.85, 0.72], brown: [0.55, 0.4, 0.3], red: [0.75, 0.35, 0.3],
  orange: [0.92, 0.65, 0.4], pink: [0.92, 0.75, 0.75], blue: [0.6, 0.7, 0.85], green: [0.6, 0.75, 0.6],
};

function parseColour(c: unknown): number[] | null {
  if (typeof c !== 'string') return null;
  if (COLOUR_NAMES[c]) return COLOUR_NAMES[c];
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

interface BuildCtx {
  s: number; // metry na jednotku dlaždice
  height: (lx: number, lz: number) => number;
  walls: MeshBuf;
  roofs: MeshBuf;
  edges: FloatBuf;
  bpts: FloatBuf;
}

function addWall(
  b: BuildCtx, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, u0: number, col: number[],
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return u0;
  const nx = dz / len;
  const nz = -dx / len;
  const u1 = u0 + len / (3.3 * 4);
  const v0 = 0;
  const v1 = (y1 - y0) / (3.0 * 4);
  const w = b.walls;
  // Dva trojúhelníky, CCW při pohledu zvenčí.
  w.vert(ax, y0, az, nx, 0, nz, u0, v0, col);
  w.vert(bx, y1, bz, nx, 0, nz, u1, v1, col);
  w.vert(bx, y0, bz, nx, 0, nz, u1, v0, col);
  w.vert(ax, y0, az, nx, 0, nz, u0, v0, col);
  w.vert(ax, y1, az, nx, 0, nz, u0, v1, col);
  w.vert(bx, y1, bz, nx, 0, nz, u1, v1, col);
  return u1;
}

function tri(m: MeshBuf, a: number[], b: number[], c: number[], col: number[]) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
    [b, c] = [c, b];
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  m.vert(a[0], a[1], a[2], nx / l, ny / l, nz / l, 0, 0, col);
  m.vert(b[0], b[1], b[2], nx / l, ny / l, nz / l, 0, 0, col);
  m.vert(c[0], c[1], c[2], nx / l, ny / l, nz / l, 0, 0, col);
}

function buildBuildings(vt: VectorTile, b: BuildCtx) {
  const layer = vt.layers.building;
  if (!layer) return;
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi);
    const props = f.properties;
    let hgt = Number(props.render_height) || 0;
    const minH = Number(props.render_min_height) || 0;
    if (hgt <= 2) hgt = 3.2;
    const rings = f.loadGeometry();
    // Rozdělit na polygony: vnější kruh (kladná plocha) + díry.
    const polys: { outer: Pt[]; holes: Pt[][] }[] = [];
    for (const r of rings) {
      if (r.length < 4) continue;
      const a = ringArea(r);
      if (a > 0) polys.push({ outer: r, holes: [] });
      else if (polys.length) polys[polys.length - 1].holes.push(r);
    }
    const custom = parseColour(props.colour);
    for (const poly of polys) {
      const o = poly.outer;
      // Těžiště a ořez: budovu vlastní dlaždice, ve které leží její těžiště.
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < o.length - 1; i++) {
        cx += o[i].x;
        cy += o[i].y;
      }
      cx /= o.length - 1;
      cy /= o.length - 1;
      if (cx < 0 || cy < 0 || cx >= EXTENT || cy >= EXTENT) continue;
      const s = b.s;
      const areaM = (ringArea(o) * s * s);
      const seed = hashStr(`${Math.round(cx)},${Math.round(cy)}`);
      const col = custom ?? FACADES[seed % FACADES.length];
      // Základna = nejnižší bod terénu pod půdorysem.
      let base = Infinity;
      let top = -Infinity;
      for (const p of o) {
        const h = b.height(p.x * s, p.y * s);
        base = Math.min(base, h);
        top = Math.max(top, h);
      }
      if (!Number.isFinite(base)) continue;
      const y0 = minH > 0 ? top + minH : base - 0.5;
      const y1 = top + hgt;
      b.bpts.push(cx * s, cy * s, areaM * hgt);
      for (const ring of [o, ...poly.holes]) {
        let u = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const ax = ring[i].x * s, az = ring[i].y * s, bx = ring[i + 1].x * s, bz = ring[i + 1].y * s;
          u = addWall(b, ax, az, bx, bz, y0, y1, u, col);
          if (minH < 2.5) b.edges.push(ax, az, bx, bz);
        }
      }
      // Střecha.
      const simple = poly.holes.length === 0 && o.length === 5 && hgt <= 13 && areaM > 30 && areaM < 450;
      if (simple && seed % 7 !== 0) {
        // Sedlová střecha nad čtyřúhelníkem – hřeben podél delší strany.
        const p = o.slice(0, 4).map((q) => [q.x * s, q.y * s]);
        const l01 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
        const l12 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
        const q = l01 >= l12 ? p : [p[1], p[2], p[3], p[0]];
        const shortSide = Math.min(l01, l12);
        const rh = Math.min(6, shortSide * 0.42);
        const rc = ROOFS[(seed >> 4) % ROOFS.length];
        const r0 = [(q[0][0] + q[3][0]) / 2, y1 + rh, (q[0][1] + q[3][1]) / 2];
        const r1 = [(q[1][0] + q[2][0]) / 2, y1 + rh, (q[1][1] + q[2][1]) / 2];
        const c = q.map((v) => [v[0], y1, v[1]]);
        tri(b.roofs, c[0], c[1], r1, rc);
        tri(b.roofs, c[0], r1, r0, rc);
        tri(b.roofs, c[2], c[3], r0, rc);
        tri(b.roofs, c[2], r0, r1, rc);
        // Štíty jsou fasáda.
        const gc = col.map((v) => v * 0.92);
        tri(b.roofs, c[1], c[2], r1, gc);
        tri(b.roofs, c[3], c[0], r0, gc);
      } else {
        const flat: number[] = [];
        const holeIdx: number[] = [];
        for (let i = 0; i < o.length - 1; i++) flat.push(o[i].x * s, o[i].y * s);
        for (const hole of poly.holes) {
          holeIdx.push(flat.length / 2);
          for (let i = 0; i < hole.length - 1; i++) flat.push(hole[i].x * s, hole[i].y * s);
        }
        const idx = earcut(flat, holeIdx);
        const rc = hgt > 13 || custom ? FLAT_ROOF : areaM > 450 ? FLAT_ROOF : ROOFS[(seed >> 4) % ROOFS.length];
        for (let i = 0; i < idx.length; i += 3) {
          for (const k of [idx[i], idx[i + 2], idx[i + 1]]) {
            b.roofs.vert(flat[k * 2], y1, flat[k * 2 + 1], 0, 1, 0, 0, 0, rc);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- silnice

interface RoadCtx {
  s: number;
  height: (lx: number, lz: number) => number;
  globalHeight: (lx: number, lz: number) => number;
  marked: MeshBuf;
  plain: MeshBuf;
  paths: MeshBuf;
  sides: MeshBuf;
  rails: MeshBuf;
  bridges: FloatBuf;
  lines: RoadLine[];
}

function ribbon(
  m: MeshBuf, pts: number[][], width: number, yOff: number, heights: number[] | null,
  r: RoadCtx, sides: boolean,
) {
  // pts: [x, z] v metrech, už převzorkované.
  const n = pts.length;
  if (n < 2) return;
  const hw = width / 2;
  const L: number[][] = [];
  const R: number[][] = [];
  let dist = 0;
  const vs: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    // Normála doleva (při pohledu ve směru jízdy, osa Z na jih).
    let nx = dz;
    let nz = -dx;
    // Miter u vnitřních vrcholů.
    if (i > 0 && i < n - 1) {
      const d1x = p[0] - a[0], d1z = p[1] - a[1];
      const l1 = Math.hypot(d1x, d1z) || 1;
      const cos = (d1x / l1) * dx + (d1z / l1) * dz;
      const sc = 1 / Math.max(0.5, Math.sqrt((1 + cos) / 2));
      nx *= sc;
      nz *= sc;
    }
    if (i > 0) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    vs.push(dist);
    const lx = p[0] + nx * hw, lz = p[1] + nz * hw;
    const rx = p[0] - nx * hw, rz = p[1] - nz * hw;
    let ly: number;
    let ry: number;
    if (heights) {
      ly = ry = heights[i] + yOff;
    } else {
      const hc = r.height(p[0], p[1]);
      ly = Math.max(r.height(lx, lz), hc) + yOff;
      ry = Math.max(r.height(rx, rz), hc) + yOff;
    }
    L.push([lx, ly, lz]);
    R.push([rx, ry, rz]);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = L[i], b = R[i], c = L[i + 1], d = R[i + 1];
    const va = vs[i] / 8, vc = vs[i + 1] / 8;
    // CCW shora: a(levý) -> c -> b ... osa Z na jih, pohled shora, ověřeno normálou nahoru.
    m.vert(a[0], a[1], a[2], 0, 1, 0, 0, va);
    m.vert(b[0], b[1], b[2], 0, 1, 0, 1, va);
    m.vert(c[0], c[1], c[2], 0, 1, 0, 0, vc);
    m.vert(c[0], c[1], c[2], 0, 1, 0, 0, vc);
    m.vert(b[0], b[1], b[2], 0, 1, 0, 1, va);
    m.vert(d[0], d[1], d[2], 0, 1, 0, 1, vc);
    if (sides) {
      for (const [p, q] of [[a, c], [d, b]] as number[][][]) {
        const dx = q[0] - p[0], dz = q[2] - p[2];
        const l = Math.hypot(dx, dz) || 1;
        const nx = dz / l, nz = -dx / l;
        const h0 = 1.4;
        const s = r.sides;
        // Podhled mostovky.
        s.vert(p[0], p[1] - h0, p[2], nx, 0, nz);
        s.vert(q[0], q[1] - h0, q[2], nx, 0, nz);
        s.vert(q[0], q[1] + 0.9, q[2], nx, 0, nz);
        s.vert(p[0], p[1] - h0, p[2], nx, 0, nz);
        s.vert(q[0], q[1] + 0.9, q[2], nx, 0, nz);
        s.vert(p[0], p[1] + 0.9, p[2], nx, 0, nz);
      }
    }
  }
}

function resample(pts: number[][], step: number): number[][] {
  const out: number[][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(l / step));
    for (let j = 1; j <= k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

function buildRoads(vt: VectorTile, r: RoadCtx) {
  const layer = vt.layers.transportation;
  if (!layer) return;
  const s = r.s;
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi);
    if (f.type !== 2) continue;
    const p = f.properties;
    const cls = String(p.class);
    const isRail = cls === 'rail' || (cls === 'transit' && p.subclass === 'tram');
    const width = ROAD_WIDTH[cls];
    if (!width && !isRail) continue;
    const bridge = p.brunnel === 'bridge';
    const tunnel = p.brunnel === 'tunnel';
    const oneway = Number(p.oneway) || 0;
    for (const full of f.loadGeometry()) {
      if (full.length < 2) continue;
      // Výšky konců mostu z neoříznuté geometrie (konce leží na opěrách).
      let hA = 0;
      let hB = 0;
      let fullLen = 0;
      if (bridge) {
        hA = r.globalHeight(full[0].x * s, full[0].y * s);
        hB = r.globalHeight(full[full.length - 1].x * s, full[full.length - 1].y * s);
        for (let i = 1; i < full.length; i++) fullLen += Math.hypot(full[i].x - full[i - 1].x, full[i].y - full[i - 1].y) * s;
      }
      for (const part of clipLine(full, EXTENT)) {
        const pts = resample(part.map((q) => [q.x * s, q.y * s]), 5);
        let heights: number[] | null = null;
        if (bridge && fullLen > 0) {
          // Poloha každého bodu podél celého mostu.
          heights = pts.map((q) => {
            let best = Infinity;
            let along = 0;
            let acc = 0;
            for (let i = 1; i < full.length; i++) {
              const ax = full[i - 1].x * s, az = full[i - 1].y * s;
              const bx = full[i].x * s, bz = full[i].y * s;
              const dx = bx - ax, dz = bz - az;
              const l2 = dx * dx + dz * dz || 1;
              const t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - az) * dz) / l2));
              const d = Math.hypot(ax + dx * t - q[0], az + dz * t - q[1]);
              const l = Math.sqrt(l2);
              if (d < best) {
                best = d;
                along = acc + t * l;
              }
              acc += l;
            }
            const t = along / fullLen;
            const deck = hA + (hB - hA) * t;
            return Math.max(deck, r.height(q[0], q[1]) + 0.3);
          });
        }
        const prio = ROAD_PRIO[cls] ?? 1;
        if (!tunnel) {
          if (isRail) {
            ribbon(r.rails, pts, 3.0, 0.12, heights, r, false);
          } else {
            const m = cls === 'path' ? r.paths : MARKED.has(cls) ? r.marked : r.plain;
            ribbon(m, pts, width, 0.2 + prio * 0.025 + (bridge ? 0.1 : 0), heights, r, bridge);
          }
          if (bridge && heights && !isRail) {
            for (let i = 0; i + 1 < pts.length; i++) {
              r.bridges.push(pts[i][0], pts[i][1], heights[i] + 0.3, pts[i + 1][0], pts[i + 1][1], heights[i + 1] + 0.3, width / 2 + 0.5);
            }
          }
        }
        if (DRIVABLE.has(cls) || cls === 'path') {
          const arr = new Float32Array(part.length * 3);
          part.forEach((q, i) => {
            const x = q.x * s, z = q.y * s;
            arr[i * 3] = x;
            arr[i * 3 + 1] = bridge && heights ? NaN : r.height(x, z);
            arr[i * 3 + 2] = z;
          });
          r.lines.push({ cls: p.ramp ? `${cls}` : cls, oneway, bridge, tunnel, pts: arr });
        }
      }
    }
  }
}

// ---------------------------------------------------------------- stromy

function buildTrees(vt: VectorTile, sizeM: number, budget: number, seed: number, height: (x: number, z: number) => number): { trees: Float32Array; circles: number[] } {
  const M = 256;
  const c = new OffscreenCanvas(M, M);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, M, M);
  const s = M / EXTENT;
  const pxPerM = M / sizeM;
  const L = vt.layers;
  const each = (name: string, fn: (f: VectorTileFeature) => void) => {
    const l = L[name];
    if (l) for (let i = 0; i < l.length; i++) fn(l.feature(i));
  };
  each('landcover', (f) => {
    const cls = String(f.properties.class);
    const sub = String(f.properties.subclass);
    let v = 0;
    if (cls === 'wood') v = 255;
    else if (sub === 'park' || sub === 'garden' || sub === 'village_green') v = 40;
    else if (cls === 'wetland') v = 60;
    else if (sub === 'scrub') v = 90;
    if (!v) return;
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fill('evenodd');
  });
  each('park', (f) => {
    if (f.type !== 3) return;
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill('evenodd');
  });
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  each('water', (f) => {
    drawFeature(ctx, f, s, true);
    ctx.fill('evenodd');
  });
  each('building', (f) => {
    drawFeature(ctx, f, s, true);
    ctx.fill('evenodd');
    ctx.lineWidth = 3 * pxPerM;
    ctx.stroke();
  });
  each('transportation', (f) => {
    if (f.type !== 2) return;
    const w = ROAD_WIDTH[String(f.properties.class)] ?? 4;
    drawFeature(ctx, f, s, false);
    ctx.lineWidth = Math.max(1.5, (w + 5) * pxPerM);
    ctx.stroke();
  });
  each('waterway', (f) => {
    drawFeature(ctx, f, s, false);
    ctx.lineWidth = 6 * pxPerM;
    ctx.stroke();
  });
  const d = ctx.getImageData(0, 0, M, M).data;
  const rnd = mulberry(seed ^ 0x9e3779b9);
  const out = new FloatBuf(budget * 5);
  const circles: number[] = [];
  let tries = budget * 4;
  let count = 0;
  while (tries-- > 0 && count < budget) {
    const px = rnd() * M;
    const py = rnd() * M;
    const v = d[(Math.floor(py) * M + Math.floor(px)) * 4];
    if (v === 0 || rnd() * 255 > v) continue;
    const x = (px / M) * sizeM;
    const z = (py / M) * sizeM;
    const forest = v > 200;
    const kind = forest ? (rnd() < 0.62 ? 0 : 1) : rnd() < 0.25 ? 0 : 1;
    const sc = forest ? 0.9 + rnd() * 0.6 : 0.6 + rnd() * 0.5;
    out.push(x, height(x, z) - 0.3, z, sc, kind);
    circles.push(x, z, 0.35 * sc + 0.15);
    count++;
  }
  return { trees: out.out(), circles };
}

// ---------------------------------------------------------------- kolize

function buildColliders(edges: Float32Array, circles: Float32Array, sizeM: number): Colliders {
  const cells = 64;
  const cs = sizeM / cells;
  const lists: number[][] = Array.from({ length: cells * cells }, () => []);
  const add = (x0: number, z0: number, x1: number, z1: number, item: number) => {
    const i0 = Math.max(0, Math.floor(Math.min(x0, x1) / cs));
    const i1 = Math.min(cells - 1, Math.floor(Math.max(x0, x1) / cs));
    const j0 = Math.max(0, Math.floor(Math.min(z0, z1) / cs));
    const j1 = Math.min(cells - 1, Math.floor(Math.max(z0, z1) / cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * cells + i].push(item);
  };
  for (let e = 0; e < edges.length / 4; e++) {
    add(edges[e * 4], edges[e * 4 + 1], edges[e * 4 + 2], edges[e * 4 + 3], e);
  }
  for (let c = 0; c < circles.length / 3; c++) {
    const x = circles[c * 3], z = circles[c * 3 + 1], r = circles[c * 3 + 2];
    add(x - r, z - r, x + r, z + r, -1 - c);
  }
  const cellStart = new Int32Array(cells * cells + 1);
  let total = 0;
  for (let i = 0; i < lists.length; i++) {
    cellStart[i] = total;
    total += lists[i].length;
  }
  cellStart[lists.length] = total;
  const cellItems = new Int32Array(total);
  let k = 0;
  for (const l of lists) for (const v of l) cellItems[k++] = v;
  return { edges, circles, cells, cellStart, cellItems };
}

// ---------------------------------------------------------------- body

function points(vt: VectorTile, s: number) {
  const stops: NamedPoint[] = [];
  const addresses: NamedPoint[] = [];
  const places: PlacePoint[] = [];
  const streets: StreetLine[] = [];
  const inside = (p: Pt) => p.x >= 0 && p.y >= 0 && p.x < EXTENT && p.y < EXTENT;
  const poi = vt.layers.poi;
  if (poi) {
    for (let i = 0; i < poi.length; i++) {
      const f = poi.feature(i);
      if (f.properties.class !== 'bus') continue;
      const g = f.loadGeometry()[0]?.[0];
      if (!g || !inside(g)) continue;
      stops.push({ name: String(f.properties.name ?? 'Zastávka'), x: g.x * s, z: g.y * s });
    }
  }
  const hn = vt.layers.housenumber;
  if (hn) {
    for (let i = 0; i < hn.length && addresses.length < 5000; i++) {
      const f = hn.feature(i);
      const g = f.loadGeometry()[0]?.[0];
      if (!g || !inside(g)) continue;
      addresses.push({ name: String(f.properties.housenumber), x: g.x * s, z: g.y * s });
    }
  }
  const pl = vt.layers.place;
  if (pl) {
    for (let i = 0; i < pl.length; i++) {
      const f = pl.feature(i);
      const g = f.loadGeometry()[0]?.[0];
      if (!g || !inside(g) || !f.properties.name) continue;
      places.push({ name: String(f.properties['name:cs'] ?? f.properties.name), cls: String(f.properties.class), x: g.x * s, z: g.y * s });
    }
  }
  const tn = vt.layers.transportation_name;
  if (tn) {
    for (let i = 0; i < tn.length; i++) {
      const f = tn.feature(i);
      const name = f.properties.name;
      if (!name || f.type !== 2) continue;
      for (const line of f.loadGeometry()) {
        for (const part of clipLine(line, EXTENT)) {
          const arr = new Float32Array(part.length * 2);
          part.forEach((q, k) => {
            arr[k * 2] = q.x * s;
            arr[k * 2 + 1] = q.y * s;
          });
          streets.push({ name: String(name), pts: arr });
        }
      }
    }
  }
  return { stops, addresses, places, streets };
}

// ---------------------------------------------------------------- hlavní

async function build(req: TileRequest): Promise<{ data: TileData; transfer: Transferable[] }> {
  const { z, x, y } = req;
  const sizeM = TILE_M * 2 ** (14 - z);
  const near = req.kind === 'near';
  const N = near ? 128 : 64;
  const ez = near ? 13 : z - 1;
  const scale = 2 ** (ez - z) * 256;
  const sampler = new ElevSampler(ez);
  const margin = 0.15;
  const vtPromise = loadVector(req.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  await sampler.prepare((x - margin) * scale, (y - margin) * scale, (x + 1 + margin) * scale, (y + 1 + margin) * scale);
  const h = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      h[j * (N + 1) + i] = sampler.sample((x + i / N) * scale, (y + j / N) * scale);
    }
  }
  const grid: HeightGrid = { n: N, size: sizeM, h };
  const globalHeight = (lx: number, lz: number) => sampler.sample((x + lx / sizeM) * scale, (y + lz / sizeM) * scale);
  const height = (lx: number, lz: number) => {
    const v = gridHeight(grid, lx, lz);
    return Number.isNaN(v) ? globalHeight(lx, lz) : v;
  };
  const vt = await vtPromise;
  const seed = hashStr(`${z}/${x}/${y}`);
  const canvas = paintGround(vt, req.texSize, sizeM, seed, near);
  const texture = canvas.transferToImageBitmap();
  const terrain = buildTerrain(grid);
  const data: TileData = { id: req.id, kind: req.kind, z, x, y, size: sizeM, n: N, heights: h, terrain, texture };
  const transfer: Transferable[] = [h.buffer, terrain.pos.buffer, terrain.nor.buffer, terrain.uv!.buffer, texture];
  const addMesh = (m: MeshArrays | undefined) => {
    if (!m) return;
    transfer.push(m.pos.buffer, m.nor.buffer);
    if (m.uv) transfer.push(m.uv.buffer);
    if (m.col) transfer.push(m.col.buffer);
  };
  if (near && vt) {
    const s = sizeM / EXTENT;
    const bctx: BuildCtx = {
      s, height, walls: new MeshBuf(), roofs: new MeshBuf(), edges: new FloatBuf(4096), bpts: new FloatBuf(1024),
    };
    buildBuildings(vt, bctx);
    const rctx: RoadCtx = {
      s, height, globalHeight, marked: new MeshBuf(), plain: new MeshBuf(), paths: new MeshBuf(), sides: new MeshBuf(),
      rails: new MeshBuf(), bridges: new FloatBuf(256), lines: [],
    };
    buildRoads(vt, rctx);
    if (!bctx.walls.empty) data.walls = bctx.walls.arrays(true, true);
    if (!bctx.roofs.empty) data.roofs = bctx.roofs.arrays(false, true);
    if (!rctx.marked.empty) data.roadsMarked = rctx.marked.arrays(true, false);
    if (!rctx.plain.empty) data.roadsPlain = rctx.plain.arrays(true, false);
    if (!rctx.paths.empty) data.paths = rctx.paths.arrays(true, false);
    if (!rctx.sides.empty) data.bridgeSides = rctx.sides.arrays(false, false);
    if (!rctx.rails.empty) data.rails = rctx.rails.arrays(true, false);
    for (const m of [data.walls, data.roofs, data.roadsMarked, data.roadsPlain, data.paths, data.bridgeSides, data.rails]) addMesh(m);
    let circles: number[] = [];
    if (req.treeBudget > 0) {
      const t = buildTrees(vt, sizeM, req.treeBudget, seed, height);
      data.trees = t.trees;
      circles = t.circles;
      transfer.push(t.trees.buffer);
    }
    const col = buildColliders(bctx.edges.out(), new Float32Array(circles), sizeM);
    data.colliders = col;
    transfer.push(col.edges.buffer, col.circles.buffer, col.cellStart.buffer, col.cellItems.buffer);
    data.bridges = rctx.bridges.out();
    transfer.push(data.bridges.buffer);
    data.roadLines = rctx.lines;
    for (const l of rctx.lines) transfer.push(l.pts.buffer);
    data.buildings = bctx.bpts.out();
    transfer.push(data.buildings.buffer);
    Object.assign(data, points(vt, s));
    for (const st of data.streets!) transfer.push(st.pts.buffer);
  }
  return { data, transfer };
}

self.onmessage = async (e: MessageEvent<TileRequest>) => {
  const req = e.data;
  try {
    const { data, transfer } = await build(req);
    self.postMessage(data, transfer);
  } catch (err) {
    const data = { id: req.id, kind: req.kind, z: req.z, x: req.x, y: req.y, error: String(err) } as TileData;
    self.postMessage(data);
  }
};
