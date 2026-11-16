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

  /** Jako sample, ale NaN tam, kde chybí data (nenačtená dlaždice). */
  sampleSafe(gx: number, gy: number): number {
    const x = Math.floor(gx - 0.5), y = Math.floor(gy - 0.5);
    for (const [ix, iy] of [[x, y], [x + 1, y + 1]]) {
      if (!this.tiles.get(`${Math.floor(ix / 256)}/${Math.floor(iy / 256)}`)) return NaN;
    }
    return this.sample(gx, gy);
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

const CUZK = 'https://ags.cuzk.gov.cz/arcgis2/rest/services';

/**
 * Rastr z ČÚZK (DMR 5G = terén, DMP 1G = povrch včetně vegetace) pro dlaždici.
 * Mřížka n×n má krajní body přesně v rozích dlaždice, takže sousední dlaždice navazují.
 */
/** Budovy z RÚIAN (počet podlaží, využití, konstrukce, rok dokončení) pro dlaždici. */
async function loadRuian(z: number, x: number, y: number, sizeM: number): Promise<RuianPt[]> {
  const o = Math.PI * 6378137;
  const S = (2 * o) / 2 ** z;
  const x0 = x * S - o, x1 = (x + 1) * S - o, y0 = o - (y + 1) * S, y1 = o - y * S;
  const url = 'https://ags.cuzk.gov.cz/arcgis/rest/services/RUIAN/Prohlizeci_sluzba_nad_daty_RUIAN/MapServer/3/query'
    + `?geometry=${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}&geometryType=esriGeometryEnvelope&inSR=3857`
    + '&spatialRel=esriSpatialRelIntersects&outFields=pocetpodlazi,zpusobvyuzitikod,druhkonstrukcekod,dokonceni'
    + '&returnGeometry=true&outSR=3857&maxAllowableOffset=4&geometryPrecision=0&f=json';
  try {
    let cache: Cache | null = null;
    try {
      cache = await caches.open('ruian-v1');
    } catch {
      cache = null;
    }
    let r = cache ? await cache.match(url) : undefined;
    if (!r) {
      const f = await fetchRetry(url, 2);
      if (!f) return [];
      r = f;
      if (cache) void cache.put(url, f.clone()).catch(() => {});
    }
    const j = (await r.json()) as { features?: { attributes: Record<string, number | null>; geometry?: { rings: number[][][] } }[] };
    const out: RuianPt[] = [];
    // Merkátorské metry -> lokální metry dlaždice.
    const k = sizeM / S;
    for (const f of j.features ?? []) {
      const ring = f.geometry?.rings?.[0];
      if (!ring || ring.length < 3) continue;
      let cx = 0, cy = 0;
      const n = ring.length - 1 || 1;
      for (let i = 0; i < n; i++) {
        cx += ring[i][0];
        cy += ring[i][1];
      }
      cx /= n;
      cy /= n;
      const a = f.attributes;
      const yr = a.dokonceni != null ? new Date(a.dokonceni).getUTCFullYear() : 0;
      out.push({
        x: (cx - x0) * k, z: (y1 - cy) * k,
        floors: a.pocetpodlazi ?? 0, use: a.zpusobvyuzitikod ?? 0, con: a.druhkonstrukcekod ?? 0, year: yr,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function loadCuzk(service: string, z: number, x: number, y: number, n: number): Promise<Float32Array | null> {
  const o = Math.PI * 6378137;
  const S = (2 * o) / 2 ** z;
  const p = S / (n - 1);
  const x0 = x * S - o - p / 2, x1 = (x + 1) * S - o + p / 2;
  const y0 = o - (y + 1) * S - p / 2, y1 = o - y * S + p / 2;
  const url = `${CUZK}/${service}/ImageServer/exportImage?bbox=${x0.toFixed(2)},${y0.toFixed(2)},${x1.toFixed(2)},${y1.toFixed(2)}&bboxSR=3857&imageSR=3857&size=${n},${n}&format=bip&pixelType=F32&noData=-9999&interpolation=RSP_BilinearInterpolation&f=image`;
  try {
    // Mezipaměť prohlížeče: ČÚZK neposílá cache hlavičky, ukládáme si odpovědi sami.
    let cache: Cache | null = null;
    try {
      cache = await caches.open('cuzk-v1');
    } catch {
      cache = null;
    }
    let r = cache ? await cache.match(url) : undefined;
    if (!r) {
      const f = await fetchRetry(url, 2);
      if (!f) return null;
      r = f;
      if (cache) void cache.put(url, f.clone()).catch(() => {});
    }
    const buf = await r.arrayBuffer();
    if (buf.byteLength < n * n * 4) return null;
    const f = new Float32Array(buf.slice(0, n * n * 4));
    let valid = 0;
    for (let i = 0; i < f.length; i++) {
      if (!(f[i] > -500 && f[i] < 3000)) f[i] = NaN;
      else valid++;
    }
    return valid > 0 ? f : null;
  } catch {
    return null;
  }
}

/** Leží dlaždice aspoň zčásti v Česku (hrubý obdélník)? */
function inCzBox(z: number, x: number, y: number): boolean {
  const n = 2 ** z;
  const lon0 = (x / n) * 360 - 180, lon1 = ((x + 1) / n) * 360 - 180;
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return lon1 > 12.05 && lon0 < 18.9 && lat(y + 1) < 51.08 && lat(y) > 48.54;
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
  wood: '#6d8a4c', grass: '#a2bd6c', farmland: '#cfc48a', wetland: '#8fa97c', sand: '#e2d6a6',
  rock: '#b6b0a6', ice: '#f2f6f8',
};
const FARM = ['#cfc48a', '#bcc47c', '#d9ca8f', '#b2bf72', '#cbb87c', '#c4c98a', '#a9bb6e'];
const LANDUSE_COL: Record<string, string> = {
  residential: '#b8c48e', suburb: '#b8c48e', neighbourhood: '#b8c48e', quarter: '#b8c48e',
  commercial: '#d4c8b8', retail: '#d4c8b8', industrial: '#c9c3b8', garages: '#c9c3b8', railway: '#c4bcae',
  cemetery: '#9fb27c', school: '#d6ccb4', university: '#d6ccb4', college: '#d6ccb4', kindergarten: '#d6ccb4',
  hospital: '#d8cbbf', military: '#b9b79c', quarry: '#cfc4ae', pitch: '#94bf6a', playground: '#bccb92',
  stadium: '#a6c27a', track: '#c99a7c', zoo: '#a9c07c', theme_park: '#b9c48c', dam: '#c9c3b8',
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
  ctx.fillStyle = '#a5bb70';
  ctx.fillRect(0, 0, S, S);
  // Jemné skvrny louky.
  const rnd = mulberry(seed);
  for (let i = 0; i < (detailed ? 900 : 200); i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(60,90,30,0.05)' : 'rgba(255,250,200,0.05)';
    const w = (10 + rnd() * 40) * (S / 1024);
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
      ctx.strokeStyle = '#cdc7b5';
      ctx.lineWidth = 8 * pxPerM;
      ctx.stroke();
      ctx.fillStyle = '#cdc7b5';
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
    const cls = String(f.properties.class);
    let col = LANDCOVER_COL[cls];
    if (!col) return;
    if (cls === 'farmland') {
      const g = f.loadGeometry()[0]?.[0];
      col = FARM[(g ? hashStr(`${g.x},${g.y}`) : 0) % FARM.length];
    }
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = col;
    ctx.fill('evenodd');
  });
  each('park', (f) => {
    if (f.type !== 3) return;
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = 'rgba(140,190,100,0.25)';
    ctx.fill('evenodd');
  });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  each('waterway', (f) => {
    const cls = String(f.properties.class);
    const w = cls === 'river' ? 14 : cls === 'canal' ? 8 : 3;
    drawFeature(ctx, f, s, false);
    ctx.strokeStyle = '#6aa6d6';
    ctx.lineWidth = Math.max(1, w * pxPerM);
    ctx.stroke();
  });
  each('water', (f) => {
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = '#6aa6d6';
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
    let col = '#8a93a3';
    if (cls === 'rail' || cls === 'transit') {
      w = 3.2;
      col = '#8f857a';
    } else if (cls === 'path') {
      col = '#e2d8be';
    } else if (cls === 'track') {
      col = '#c9ba92';
    }
    if (!w) continue;
    drawFeature(ctx, f, s, false);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(detailed ? 1 : 1.5, w * pxPerM * (detailed ? 1 : 1.6));
    ctx.stroke();
  }
  if (detailed) {
    // Měkký stín u paty budov.
    ctx.save();
    ctx.filter = `blur(${Math.max(1, 2.5 * pxPerM)}px)`;
    ctx.fillStyle = 'rgba(40,35,25,0.35)';
    ctx.lineWidth = 3 * pxPerM;
    ctx.strokeStyle = 'rgba(40,35,25,0.35)';
    each('building', (f) => {
      drawFeature(ctx, f, s, true);
      ctx.fill('evenodd');
      ctx.stroke();
    });
    ctx.restore();
  }
  each('building', (f) => {
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = '#b9b0a0';
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

/** sRGB hex -> lineární RGB (barvy vrcholů three.js jsou lineární). */
function lin(hex: string): number[] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => Math.pow(c / 255, 2.2));
}

const FACADES = ['#f1e6cc', '#f0d896', '#ecc6b4', '#c8d6e2', '#f4f1ea', '#e2b27a', '#d8d2c6', '#e9dcb8', '#d6e0c4', '#f2d2a8', '#e6c9d2', '#cfc9c0'].map(lin);
const ROOFS = ['#a9503a', '#9c5a42', '#b2674a', '#77513f', '#6e7179', '#575a62', '#94463a', '#a5583e'].map(lin);
const FLAT_ROOF = lin('#8f8c88');
const CHIMNEY = lin('#8a4b3a');
const ROOF_TERRACOTTA = lin('#b4573a');
const ROOF_BROWN = lin('#8e5a44');
const ROOF_COPPER = lin('#6ea58d');
const ROOF_SLATE = lin('#566170');
const HALL_COL = ['#d9dcdf', '#b9c4cf', '#e8e4dc', '#9fb3c4', '#c9cdc4'].map(lin);

const COLOUR_NAMES: Record<string, string> = {
  white: '#f4f2ec', lightgrey: '#d6d4cf', grey: '#a6a49f', gray: '#a6a49f', yellow: '#f0d88c', beige: '#e8dcbc',
  brown: '#9a7058', red: '#c46a5a', orange: '#eaa66a', pink: '#ecbcbc', blue: '#a8bcd8', green: '#a8c4a0',
};

function parseColour(c: unknown): number[] | null {
  if (typeof c !== 'string') return null;
  if (COLOUR_NAMES[c]) return lin(COLOUR_NAMES[c]);
  if (/^#([0-9a-f]{6})$/i.test(c)) {
    const v = lin(c);
    // Příliš tmavé/syté barvy z OSM zjemnit do pastelu.
    return v.map((x) => 0.25 + x * 0.75);
  }
  return null;
}

interface BuildCtx {
  s: number; // metry na jednotku dlaždice
  height: (lx: number, lz: number) => number;
  walls: MeshBuf;
  roofs: MeshBuf;
  edges: FloatBuf;
  bpts: FloatBuf;
  /** Výlohy v přízemí. */
  shops: MeshBuf;
  /** Fasády panelových domů. */
  panels: MeshBuf;
  /** Rodinné domy a haly. */
  houses: MeshBuf;
  halls: MeshBuf;
  /** Výška povrchu nad terénem (DMP − DMR) z ČÚZK, mřížka cn × cn, nebo null. */
  canopy: Float32Array | null;
  cn: number;
  size: number;
  /** Další typy fasád podle RÚIAN (historická, moderní, kancelářská, garáž, dřevo). */
  facades: Record<string, MeshBuf>;
  /** Budovy z RÚIAN (lokální souřadnice středu). */
  ruian: RuianPt[];
  /** Obchody a provozovny z OSM. */
  shopsPoi: ShopPoi[];
  signs: MeshBuf;
  atlas: SignAtlas | null;
  /** Letecký snímek ČÚZK (RGBA, n × n) pro barvy střech. */
  ortho: { data: Uint8ClampedArray; n: number } | null;
}

/** Ortofoto ČÚZK pro dlaždici (barvy střech). */
async function loadOrtho(z: number, x: number, y: number, n: number): Promise<{ data: Uint8ClampedArray; n: number; canvas: OffscreenCanvas } | null> {
  const o = Math.PI * 6378137;
  const S = (2 * o) / 2 ** z;
  const url = `https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO/MapServer/export?bbox=${(x * S - o).toFixed(1)},${(o - (y + 1) * S).toFixed(1)},${((x + 1) * S - o).toFixed(1)},${(o - y * S).toFixed(1)}&bboxSR=3857&imageSR=3857&size=${n},${n}&format=jpg&f=image`;
  try {
    let cache: Cache | null = null;
    try {
      cache = await caches.open('ortho-v1');
    } catch {
      cache = null;
    }
    let r = cache ? await cache.match(url) : undefined;
    if (!r) {
      const f = await fetchRetry(url, 2);
      if (!f || !(f.headers.get('content-type') ?? '').includes('image')) return null;
      r = f;
      if (cache) void cache.put(url, f.clone()).catch(() => {});
    }
    const bmp = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(n, n);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, n, n);
    bmp.close();
    return { data: ctx.getImageData(0, 0, n, n).data, n, canvas: c };
  } catch {
    return null;
  }
}

/**
 * Skutečná barva střechy z ortofota: medián pixelů uvnitř půdorysu (bez okrajů a stínů).
 * Vrací lineární RGB, nebo null, když snímek chybí.
 */
function orthoRoofColor(b: BuildCtx, ring: number[][], cx: number, cz: number): number[] | null {
  const o = b.ortho;
  if (!o) return null;
  const px = b.size / o.n;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  // Nejvýš ~5×5 vzorků na budovu.
  const step = Math.max(px, Math.max(x1 - x0, z1 - z0) / 5);
  const sample = (x: number, z: number) => {
    const i = Math.floor(x / px), j = Math.floor(z / px);
    if (i < 0 || j < 0 || i >= o.n || j >= o.n) return;
    const k = (j * o.n + i) * 4;
    const R = o.data[k], G = o.data[k + 1], B = o.data[k + 2];
    if (R + G + B < 90) return; // stín
    rs.push(R); gs.push(G); bs.push(B);
  };
  for (let z = z0 + step / 2; z < z1; z += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      if (!pointInRing(x, z, ring) || distToRing(x, z, ring) < px * 1.2) continue;
      sample(x, z);
    }
  }
  if (rs.length < 2) sample(cx, cz);
  if (!rs.length) return null;
  const med = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const r = med(rs), g = med(gs), bl = med(bs);
  // Snímek je zašedlý oparem: rozpoznat druh krytiny a převzít jen jas.
  const lum = (r + g + bl) / 3;
  const k = Math.max(0.7, Math.min(1.25, lum / 135));
  const scale = (c: number[]) => c.map((v) => Math.min(1, v * k));
  if (g > r * 1.06 && g > bl * 0.98 && r < 150) {
    // Zeleň: buď měděná střecha (světlejší, do modra), nebo stromy přes střechu.
    if (bl > r * 1.02) return scale(ROOF_COPPER);
    return null;
  }
  if (r > g * 1.05 && r > bl * 1.1) return scale(r > g * 1.2 ? ROOF_TERRACOTTA : ROOF_BROWN);
  if (bl > r * 1.06) return scale(ROOF_SLATE);
  const gr = Math.pow(Math.min(0.9, Math.max(0.25, lum / 255)), 2.2);
  return [gr * 1.03, gr, gr * 0.97];
}

interface RuianPt {
  x: number;
  z: number;
  floors: number;
  use: number;
  con: number;
  year: number;
}

interface ShopPoi {
  name: string;
  cls: string;
  x: number;
  z: number;
  used: boolean;
  /** Dostane ceduli (atlas má omezenou kapacitu – vybírají se nejvýznamnější). */
  sign: boolean;
  rank: number;
}

/** Atlas cedulí obchodů (jedna textura na dlaždici). */
class SignAtlas {
  static readonly W = 2048;
  static readonly H = 1024;
  static readonly CW = 204;
  static readonly CH = 40;
  canvas = new OffscreenCanvas(SignAtlas.W, SignAtlas.H);
  ctx = this.canvas.getContext('2d')!;
  n = 0;
  get full() {
    return this.n >= (SignAtlas.W / SignAtlas.CW) * Math.floor(SignAtlas.H / SignAtlas.CH);
  }

  /** Nakreslí ceduli, vrátí UV obdélník [u0, v0, u1, v1]. */
  add(name: string, cls: string): number[] {
    const cols = SignAtlas.W / SignAtlas.CW;
    const cx = (this.n % cols) * SignAtlas.CW;
    const cy = Math.floor(this.n / cols) * SignAtlas.CH;
    this.n++;
    const c = this.ctx;
    const [bg, fg] = signColors(cls);
    c.fillStyle = bg;
    c.fillRect(cx + 1, cy + 1, SignAtlas.CW - 2, SignAtlas.CH - 2);
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(cx + 1, cy + 1, SignAtlas.CW - 2, 4);
    c.fillStyle = fg;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    let fs = 26;
    c.font = `bold ${fs}px sans-serif`;
    const text = name.length > 26 ? `${name.slice(0, 25)}…` : name;
    while (c.measureText(text).width > SignAtlas.CW - 16 && fs > 12) {
      fs -= 2;
      c.font = `bold ${fs}px sans-serif`;
    }
    c.fillText(text, cx + SignAtlas.CW / 2, cy + SignAtlas.CH / 2 + 1);
    return [cx / SignAtlas.W, cy / SignAtlas.H, (cx + SignAtlas.CW) / SignAtlas.W, (cy + SignAtlas.CH) / SignAtlas.H];
  }
}

function signColors(cls: string): [string, string] {
  if (['grocery', 'supermarket', 'convenience', 'greengrocer'].includes(cls)) return ['#2f7d3b', '#ffffff'];
  if (['restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'beer', 'ice_cream', 'biergarten'].includes(cls)) return ['#7a2f24', '#fff3d6'];
  if (cls === 'pharmacy') return ['#1f9d55', '#ffffff'];
  if (cls === 'bank') return ['#1d4f8f', '#ffffff'];
  if (cls === 'bakery' || cls === 'butcher') return ['#a65a2a', '#ffffff'];
  if (cls === 'hairdresser' || cls === 'beauty') return ['#6d3a7a', '#ffffff'];
  if (cls === 'clothing_store' || cls === 'shoes') return ['#222428', '#f2f2f2'];
  if (cls === 'hotel' || cls === 'lodging') return ['#3a3f75', '#ffd977'];
  return ['#2f3a45', '#f6f1e6'];
}

/** Provozovny, které mají ceduli (OpenMapTiles poi.class). */
const SHOP_CLASSES = new Set([
  'shop', 'grocery', 'clothing_store', 'fast_food', 'restaurant', 'cafe', 'bar', 'pub', 'beer', 'bank', 'pharmacy',
  'bakery', 'butcher', 'hairdresser', 'beauty', 'ice_cream', 'alcohol_shop', 'books', 'jewelry', 'shoes', 'florist',
  'hardware', 'electronics', 'furniture', 'gift', 'optician', 'mobile_phone', 'toys', 'sports', 'pet', 'stationery',
  'hotel', 'lodging', 'post', 'cinema', 'theatre', 'supermarket', 'convenience', 'doityourself', 'car', 'bicycle',
]);

/** Typ fasády podle RÚIAN (využití, konstrukce, rok dokončení). */
function facadeFromRuian(r: RuianPt): string | null {
  const panelCon = [4, 41, 42, 43].includes(r.con);
  const woodCon = r.con === 6 || (r.con >= 61 && r.con <= 66);
  if (r.use === 18) return 'garage';
  if ([1, 12, 13, 21].includes(r.use)) return 'hall';
  if (r.use === 7 || r.use === 8 || r.use === 2) return woodCon ? 'wood' : 'house';
  if ([10, 14, 9, 20, 5, 15, 11].includes(r.use)) {
    if (r.year >= 1990) return 'office';
    if (r.year > 0 && r.year < 1945) return 'historic';
    return panelCon ? 'panel' : null;
  }
  if (r.use === 6 || r.use === 3) {
    if (panelCon) return 'panel';
    if (r.year > 0 && r.year < 1945) return 'historic';
    if (r.year >= 1995 || r.con === 11) return 'modern';
    return null;
  }
  if (woodCon) return 'wood';
  return null;
}

function pointInRing(x: number, z: number, ring: number[][]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Skutečná výška budovy z ČÚZK: horní kvantil výšky povrchu nad terénem uvnitř půdorysu. */
function measuredHeight(b: BuildCtx, ring: number[][]): number {
  if (!b.canopy) return NaN;
  const step = b.size / (b.cn - 1);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const vals: number[] = [];
  const inside = (x: number, z: number) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  for (let j = Math.max(0, Math.ceil(z0 / step)); j <= Math.min(b.cn - 1, Math.floor(z1 / step)); j++) {
    for (let i = Math.max(0, Math.ceil(x0 / step)); i <= Math.min(b.cn - 1, Math.floor(x1 / step)); i++) {
      if (!inside(i * step, j * step)) continue;
      const v = b.canopy[j * b.cn + i];
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  if (vals.length < 2) return NaN;
  vals.sort((a, c) => a - c);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.8))];
}

function addWall(
  b: BuildCtx, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, u0: number, col: number[],
  shopTop = 0,
  target?: MeshBuf,
  floorH = 3.0,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return u0;
  const nx = dz / len;
  const nz = -dx / len;
  const u1 = u0 + len / (3.3 * 4);
  const v0 = 0;
  const v1 = (y1 - y0) / (floorH * 4);
  const w = target ?? b.walls;
  // Spodní pás s jemným zatmavením u země (náhrada ambient occlusion).
  const ym = Math.min(y1, y0 + 3.2);
  const vm = (ym - y0) / (floorH * 4);
  const dark = col.map((c) => c * 0.62);
  const q = (ya: number, yb: number, va: number, vb: number, ca: number[], cb: number[]) => {
    w.vert(ax, ya, az, nx, 0, nz, u0, va, ca);
    w.vert(bx, yb, bz, nx, 0, nz, u1, vb, cb);
    w.vert(bx, ya, bz, nx, 0, nz, u1, va, ca);
    w.vert(ax, ya, az, nx, 0, nz, u0, va, ca);
    w.vert(ax, yb, az, nx, 0, nz, u0, vb, cb);
    w.vert(bx, yb, bz, nx, 0, nz, u1, vb, cb);
  };
  if (shopTop > y0 + 1 && shopTop < y1) {
    // Přízemí s výlohami (vlastní textura), nad ním běžná fasáda.
    const sc = col.map((c) => 0.35 + c * 0.65);
    const su0 = (u0 * 13.2) / 5.5, su1 = (u1 * 13.2) / 5.5;
    const S = b.shops;
    const vs = 0;
    S.vert(ax, y0, az, nx, 0, nz, su0, vs, sc);
    S.vert(bx, shopTop, bz, nx, 0, nz, su1, 1, sc);
    S.vert(bx, y0, bz, nx, 0, nz, su1, vs, sc);
    S.vert(ax, y0, az, nx, 0, nz, su0, vs, sc);
    S.vert(ax, shopTop, az, nx, 0, nz, su0, 1, sc);
    S.vert(bx, shopTop, bz, nx, 0, nz, su1, 1, sc);
    q(shopTop, y1, (shopTop - y0) / (floorH * 4), v1, col, col);
    return u1;
  }
  q(y0, ym, v0, vm, dark, col);
  if (y1 > ym + 0.01) q(ym, y1, vm, v1, col, col);
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

/** Svislý obdélník (štít, komín) se správnou normálou ven od středu cx, cz. */
function quadV(m: MeshBuf, a: number[], b: number[], y0: number, y1: number, col: number[], cx: number, cz: number) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  let nx = dz / l, nz = -dx / l;
  if ((a[0] + b[0]) / 2 - cx < 0 === nx > 0 && Math.abs(nx) > 1e-3) {
    nx = -nx;
    nz = -nz;
  } else if (Math.abs(nx) <= 1e-3 && ((a[1] + b[1]) / 2 - cz) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  m.vert(a[0], y0, a[1], nx, 0, nz, 0, 0, col);
  m.vert(b[0], y0, b[1], nx, 0, nz, 0, 0, col);
  m.vert(b[0], y1, b[1], nx, 0, nz, 0, 0, col);
  m.vert(a[0], y0, a[1], nx, 0, nz, 0, 0, col);
  m.vert(b[0], y1, b[1], nx, 0, nz, 0, 0, col);
  m.vert(a[0], y1, a[1], nx, 0, nz, 0, 0, col);
}

/** Konvexní obal (monotone chain). */
function hull(p: number[][]): number[][] {
  const pts = [...p].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = [];
  for (const q of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: number[][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Orientovaný minimální obdélník: střed, osa delší strany, poloviční rozměry. */
function obb(p: number[][]): { cx: number; cz: number; ux: number; uz: number; hl: number; hs: number; area: number } | null {
  const h = hull(p);
  if (h.length < 3) return null;
  let best: { cx: number; cz: number; ux: number; uz: number; hl: number; hs: number; area: number } | null = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-6) continue;
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l;
    let mn0 = Infinity, mx0 = -Infinity, mn1 = Infinity, mx1 = -Infinity;
    for (const q of h) {
      const s0 = q[0] * ux + q[1] * uz;
      const s1 = -q[0] * uz + q[1] * ux;
      mn0 = Math.min(mn0, s0); mx0 = Math.max(mx0, s0);
      mn1 = Math.min(mn1, s1); mx1 = Math.max(mx1, s1);
    }
    const area = (mx0 - mn0) * (mx1 - mn1);
    if (!best || area < best.area) {
      const c0 = (mn0 + mx0) / 2, c1 = (mn1 + mx1) / 2;
      let o = { cx: c0 * ux - c1 * uz, cz: c0 * uz + c1 * ux, ux, uz, hl: (mx0 - mn0) / 2, hs: (mx1 - mn1) / 2, area };
      if (o.hs > o.hl) o = { ...o, ux: -uz, uz: ux, hl: o.hs, hs: o.hl };
      best = o;
    }
  }
  return best;
}

function pitchedRoof(b: BuildCtx, o: NonNullable<ReturnType<typeof obb>>, y1: number, seed: number, wallCol: number[], roofCol: number[]) {
  const ov = 0.45; // přesah střechy
  const hl = o.hl + ov, hs = o.hs + ov;
  const { cx, cz, ux, uz } = o;
  const vx = -uz, vz = ux; // příčná osa
  const P = (a: number, c: number, y: number) => [cx + ux * a + vx * c, y, cz + uz * a + vz * c];
  const rh = Math.min(7.5, o.hs * (0.75 + (seed % 5) * 0.06));
  const yE = y1 - 0.25; // okap mírně pod korunou zdi
  const hip = o.hl / o.hs < 1.35 || (seed >>> 3) % 4 === 0;
  const rl = hip ? Math.max(0.1, o.hl - o.hs * 0.9) : hl; // polovina délky hřebene
  const c00 = P(-hl, -hs, yE), c10 = P(hl, -hs, yE), c11 = P(hl, hs, yE), c01 = P(-hl, hs, yE);
  const r0 = P(-rl, 0, y1 + rh), r1 = P(rl, 0, y1 + rh);
  const R = b.roofs;
  tri(R, c00, c10, r1, roofCol);
  tri(R, c00, r1, r0, roofCol);
  tri(R, c11, c01, r0, roofCol);
  tri(R, c11, r0, r1, roofCol);
  const roofDark = roofCol.map((v) => v * 0.82);
  if (hip) {
    tri(R, c10, c11, r1, roofDark);
    tri(R, c01, c00, r0, roofDark);
  } else {
    // Štíty ve fasádě (o kousek dovnitř, aby nepřečnívaly přesah).
    const g0a = P(-o.hl, -o.hs, y1), g0b = P(-o.hl, o.hs, y1), g0r = P(-o.hl, 0, y1 + rh * (o.hs / hs));
    const g1a = P(o.hl, -o.hs, y1), g1b = P(o.hl, o.hs, y1), g1r = P(o.hl, 0, y1 + rh * (o.hs / hs));
    for (const [p, q, r] of [[g0a, g0b, g0r], [g1a, g1b, g1r]]) {
      const n = [r[0] - cx, 0, r[2] - cz];
      const l = Math.hypot(n[0], n[2]) || 1;
      for (const v of [p, q, r]) b.walls.vert(v[0], v[1], v[2], n[0] / l, 0, n[2] / l, 0, 0, wallCol);
    }
    tri(R, c10, c11, r1, roofDark);
    tri(R, c01, c00, r0, roofDark);
  }
  // Komín.
  if ((seed >>> 5) % 5 < 3 && o.hs > 2.5) {
    const a = ((seed >>> 7) % 100) / 100 * 1.2 - 0.6;
    const sgn = (seed >>> 9) % 2 ? 1 : -1;
    const c = sgn * o.hs * 0.35;
    const yb = y1 + rh * (1 - Math.abs(c) / hs) - 0.6;
    const yt = y1 + rh + 0.9;
    const w = 0.35;
    const ax = a * Math.min(rl, o.hl * 0.8);
    const k = [P(ax - w, c - w, 0), P(ax + w, c - w, 0), P(ax + w, c + w, 0), P(ax - w, c + w, 0)].map((v) => [v[0], v[2]]);
    const mx = (k[0][0] + k[2][0]) / 2, mz = (k[0][1] + k[2][1]) / 2;
    for (let i = 0; i < 4; i++) quadV(b.walls, k[i], k[(i + 1) % 4], yb, yt, CHIMNEY, mx, mz);
    const top = k.map((v) => [v[0], yt, v[1]]);
    tri(R, top[0], top[1], top[2], CHIMNEY);
    tri(R, top[0], top[2], top[3], CHIMNEY);
  }
}

/** Posune kruh o d směrem do hmoty budovy (doleva od směru hran). Vrací null, pokud by se zvrhl. */
function insetRing(r: number[][], d: number): number[][] | null {
  const n = r.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = r[(i - 1 + n) % n], c = r[i], q = r[(i + 1) % n];
    let ax = c[0] - p[0], az = c[1] - p[1];
    let bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az, n1z = ax, n2x = -bz, n2z = bx;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) return null;
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z;
    if (cos < 0.3) return null;
    const k = d / cos;
    out.push([c[0] + mx * k, c[1] + mz * k]);
  }
  return out;
}

function polyArea(r: number[][]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

/** Mansardová střecha: šikmý pás po obvodu a plochá horní část. */
function mansardRoof(b: BuildCtx, rings: number[][][], y1: number, rh: number, col: number[], topCol: number[]): boolean {
  const d = rh * 0.95;
  const inner: number[][][] = [];
  for (const r of rings) {
    const ir = insetRing(r, d);
    if (!ir) return false;
    const a0 = polyArea(r), a1 = polyArea(ir);
    if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < Math.abs(a0) * (a0 > 0 ? 0.35 : 1.0)) return false;
    inner.push(ir);
  }
  const yt = y1 + rh;
  rings.forEach((r, k) => {
    const ir = inner[k];
    for (let i = 0; i < r.length; i++) {
      const j = (i + 1) % r.length;
      const a = [r[i][0], y1, r[i][1]], c = [r[j][0], y1, r[j][1]];
      const ai = [ir[i][0], yt, ir[i][1]], ci = [ir[j][0], yt, ir[j][1]];
      tri(b.roofs, a, c, ci, col);
      tri(b.roofs, a, ci, ai, col);
    }
  });
  const flat: number[] = [];
  const holes: number[] = [];
  inner.forEach((r, k) => {
    if (k > 0) holes.push(flat.length / 2);
    for (const p of r) flat.push(p[0], p[1]);
  });
  const idx = earcut(flat, holes);
  for (let i = 0; i < idx.length; i += 3) {
    for (const k of [idx[i], idx[i + 2], idx[i + 1]]) b.roofs.vert(flat[k * 2], yt, flat[k * 2 + 1], 0, 1, 0, 0, 0, topCol);
  }
  return true;
}

/** Kvádr na střeše natočený podle osy budovy. */
function roofBox(b: BuildCtx, cx: number, cz: number, ux: number, uz: number, hl: number, hs: number, y0: number, y1: number, col: number[]) {
  const vx = -uz, vz = ux;
  const c = [[-hl, -hs], [hl, -hs], [hl, hs], [-hl, hs]].map(([a, d]) => [cx + ux * a + vx * d, cz + uz * a + vz * d]);
  const top = c.map((p) => [p[0], y1, p[1]]);
  tri(b.roofs, top[0], top[1], top[2], col);
  tri(b.roofs, top[0], top[2], top[3], col);
  const side = col.map((v) => v * 0.85);
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    const a0 = [p[0], y0, p[1]], a1 = [q[0], y0, q[1]], b1 = [q[0], y1, q[1]], b0 = [p[0], y1, p[1]];
    tri(b.roofs, a0, a1, b1, side);
    tri(b.roofs, a0, b1, b0, side);
  }
}

function distToRing(x: number, z: number, ring: number[][]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

/** Cedule s názvem provozovny na stěně nejbližší k bodu provozovny. */
function addSign(b: BuildCtx, sp: ShopPoi, ring: number[][], y: number) {
  if (!b.atlas || b.atlas.full) return;
  let best = -1, bd = Infinity, bt = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[i + 1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    if (l2 < 9) continue; // příliš krátká stěna
    const t = Math.max(0, Math.min(1, ((sp.x - ax) * dx + (sp.z - az) * dz) / l2));
    const d = Math.hypot(ax + dx * t - sp.x, az + dz * t - sp.z);
    if (d < bd) {
      bd = d;
      best = i;
      bt = t;
    }
  }
  if (best < 0) return;
  const [ax, az] = ring[best], [bx, bz] = ring[best + 1];
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len, uz = (bz - az) / len;
  const nx = uz, nz = -ux; // ven z budovy (stejná konvence jako u zdí)
  const w = Math.min(len - 0.6, 2.2 + sp.name.length * 0.22, 7.5);
  const h = 0.75;
  let c = bt * len;
  c = Math.max(w / 2 + 0.3, Math.min(len - w / 2 - 0.3, c));
  const cx = ax + ux * c + nx * 0.14, cz = az + uz * c + nz * 0.14;
  const uv = b.atlas.add(sp.name, sp.cls);
  const m = b.signs;
  const p0 = [cx - ux * w / 2, cz - uz * w / 2], p1 = [cx + ux * w / 2, cz + uz * w / 2];
  const col = [1, 1, 1];
  // Pořadí tak, aby text nebyl zrcadlově (při pohledu zvenku).
  m.vert(p1[0], y, p1[1], nx, 0, nz, uv[0], uv[3], col);
  m.vert(p0[0], y, p0[1], nx, 0, nz, uv[2], uv[3], col);
  m.vert(p0[0], y + h, p0[1], nx, 0, nz, uv[2], uv[1], col);
  m.vert(p1[0], y, p1[1], nx, 0, nz, uv[0], uv[3], col);
  m.vert(p0[0], y + h, p0[1], nx, 0, nz, uv[2], uv[1], col);
  m.vert(p1[0], y + h, p1[1], nx, 0, nz, uv[0], uv[1], col);
}

const KIND_STATS: Record<string, number> = {};

/** Jednoduchá prostorová mřížka bodů (buňka 40 m). */
class PointGrid<T extends { x: number; z: number }> {
  private cells = new Map<number, T[]>();
  constructor(items: T[], private cs = 40) {
    for (const it of items) {
      const k = this.key(Math.floor(it.x / cs), Math.floor(it.z / cs));
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(it);
    }
  }
  private key(i: number, j: number) {
    return (i + 1000) * 4096 + (j + 1000);
  }
  /** Body v obdélníku. */
  query(x0: number, z0: number, x1: number, z1: number, out: T[] = []): T[] {
    for (let j = Math.floor(z0 / this.cs); j <= Math.floor(z1 / this.cs); j++) {
      for (let i = Math.floor(x0 / this.cs); i <= Math.floor(x1 / this.cs); i++) {
        const l = this.cells.get(this.key(i, j));
        if (l) for (const it of l) if (it.x >= x0 && it.x <= x1 && it.z >= z0 && it.z <= z1) out.push(it);
      }
    }
    return out;
  }
}

function buildBuildings(vt: VectorTile, b: BuildCtx) {
  const ruGrid = new PointGrid(b.ruian);
  const shopGrid = new PointGrid(b.shopsPoi);
  const layer = vt.layers.building;
  if (!layer) return;
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi);
    const props = f.properties;
    let hgt = Number(props.render_height) || 0;
    const minH = Number(props.render_min_height) || 0;
    if (hgt <= 2) hgt = 3.2;
    const rings = f.loadGeometry();
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
      const areaM = ringArea(o) * s * s;
      const seed = hashStr(`${Math.round(cx)},${Math.round(cy)}`);
      const col = custom ?? FACADES[seed % FACADES.length];
      let base = Infinity;
      let top = -Infinity;
      for (const p of o) {
        const h = b.height(p.x * s, p.y * s);
        base = Math.min(base, h);
        top = Math.max(top, h);
      }
      if (!Number.isFinite(base)) continue;
      const ringM = o.slice(0, -1).map((q) => [q.x * s, q.y * s]);
      // Údaje RÚIAN: budova, jejíž střed leží v půdorysu (největší počet podlaží).
      let ru: RuianPt | null = null;
      let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (const [x, z] of ringM) {
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
      }
      if (b.ruian.length) {
        for (const r of ruGrid.query(bx0, bz0, bx1, bz1)) {
          if (!pointInRing(r.x, r.z, ringM)) continue;
          if (!ru || r.floors > ru.floors) ru = r;
        }
      }
      // Výška: změřená z ČÚZK (pokud je k dispozici a dává smysl), jinak z RÚIAN nebo OSM.
      let ph = ru && ru.floors > 0 ? ru.floors * 3.1 + 0.6 : hgt;
      const meas = minH < 2.5 ? measuredHeight(b, ringM) : NaN;
      const measured = Number.isFinite(meas) && meas >= 2.2 && meas < 250;
      if (measured) ph = meas;
      // Rozhodnutí o šikmé střeše předem, aby šlo odečíst výšku střechy od zdí.
      let bbP: ReturnType<typeof obb> = null;
      if (poly.holes.length === 0 && minH < 2.5 && ph <= 26 && areaM > 12 && areaM < 3500) {
        const bb = obb(ringM);
        if (bb && areaM / bb.area > 0.78) {
          const flatChance = ph > 30 ? 0.9 : ph > 15 ? 0.45 : areaM > 1200 ? 0.6 : areaM > 500 ? 0.3 : custom ? 0.25 : 0.06;
          if ((seed % 1000) / 1000 >= flatChance) bbP = bb;
        }
      }
      const small = areaM < 30;
      let wallH = small && !measured ? Math.min(ph, 2.6) : ph;
      if (bbP && measured) wallH = Math.max(2.4, ph - Math.min(7.5, bbP.hs * 0.8));
      const hgtEff = ph;
      const y0 = minH > 0 ? top + minH : base - 0.5;
      // Skutečné provozovny z OSM v budově nebo těsně u ní.
      const myShops: ShopPoi[] = [];
      if (minH < 2.5 && ph >= 5) {
        for (const sp of shopGrid.query(bx0 - 9, bz0 - 9, bx1 + 9, bz1 + 9)) {
          if (sp.used) continue;
          if (myShops.length >= 3) break;
          if (pointInRing(sp.x, sp.z, ringM) || distToRing(sp.x, sp.z, ringM) < 9) {
            myShops.push(sp);
            sp.used = true;
          }
        }
      }
      // Výlohy: skutečné obchody, jinak náhodně u vyšších městských domů bez údajů o využití.
      const ruShop = ru ? [10, 5, 15, 20].includes(ru.use) : false;
      const shopTop = minH < 2.5 && ph >= 5 && (myShops.length > 0 || ((ruShop || !ru) && ph >= 9 && ph <= 40 && areaM > 120 && seed % 10 < (ru ? 9 : 6)))
        ? top + 4.3 : 0;
      const y1 = top + wallH;
      b.bpts.push(cx * s, cy * s, areaM * hgtEff);
      // Panelový dům: vysoký, hranatý, s plochou střechou.
      let panel = false;
      if (!bbP && shopTop === 0 && ph >= 13 && areaM > 250 && poly.holes.length === 0 && minH < 2.5) {
        const ob = obb(ringM);
        panel = !!ob && areaM / ob.area > 0.85 && ob.hl / Math.max(ob.hs, 1) > 1.6;
      }
      // Typ fasády: podle RÚIAN, jinak odhad z tvaru (hala, rodinný dům, městský dům).
      let kind = ru ? facadeFromRuian(ru) : null;
      if (kind === 'panel') panel = true;
      else if (kind) panel = false;
      if (!kind && panel) kind = 'panel';
      if (!kind && shopTop === 0 && areaM > 900 && ph < 16 && minH < 2.5) kind = 'hall';
      if (!kind && shopTop === 0 && areaM < 260 && ph < 9) kind = 'house';
      const hall = kind === 'hall';
      KIND_STATS[kind ?? (ru ? 'ru-plain' : 'plain')] = (KIND_STATS[kind ?? (ru ? 'ru-plain' : 'plain')] ?? 0) + 1;
      const house = kind === 'house';
      // Výška patra: z RÚIAN, historické domy mají vyšší patra.
      const floorH = ru && ru.floors > 0 ? Math.min(4.6, Math.max(2.5, (wallH - (shopTop ? 1.3 : 0)) / ru.floors)) : kind === 'historic' ? 3.6 : 3.0;
      const realRoof = minH < 2.5 && areaM > 25 ? orthoRoofColor(b, ringM, cx * s, cy * s) : null;
      const target = kind === 'panel' ? b.panels : hall ? b.halls : house ? b.houses : kind && b.facades[kind] ? b.facades[kind] : undefined;
      const wallCol = hall && !custom ? HALL_COL[seed % HALL_COL.length]
        : kind === 'office' || kind === 'wood' ? [1, 1, 1]
        : kind === 'garage' ? [0.8, 0.8, 0.78] : col;
      for (const ring of [o, ...poly.holes]) {
        let u = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const ax = ring[i].x * s, az = ring[i].y * s, bx = ring[i + 1].x * s, bz = ring[i + 1].y * s;
          u = addWall(b, ax, az, bx, bz, y0, y1, u, wallCol, shopTop, target, floorH);
          if (minH < 2.5) b.edges.push(ax, az, bx, bz, y1 + (bbP ? 7 : 1));
        }
      }
      // Cedule obchodů nad výlohou na nejbližší stěně.
      for (const sp of myShops) if (sp.sign) addSign(b, sp, o.map((q) => [q.x * s, q.y * s]), top + 3.55);
      // Střecha: šikmá nad téměř obdélníkovým půdorysem, jinak plochá.
      let pitched = false;
      if (bbP) {
        pitchedRoof(b, bbP, y1, seed, col, realRoof ?? ROOFS[(seed >>> 4) % ROOFS.length]);
        pitched = true;
      }
      const hgt2 = hgtEff;
      if (!pitched && minH < 2.5 && areaM > 80 && hgt2 <= 60 && hgt2 >= 7 && (seed % 100) < (hgt2 > 35 ? 35 : 92)) {
        const rings = [o, ...poly.holes].map((r) => r.slice(0, -1).map((q) => [q.x * s, q.y * s]));
        const rc = realRoof ?? ROOFS[(seed >>> 4) % ROOFS.length];
        pitched = mansardRoof(b, rings, y1, Math.min(4, 1.8 + hgt2 * 0.08), rc, rc.map((v) => v * 0.8));
      }
      if (!pitched) {
        const flat: number[] = [];
        const holeIdx: number[] = [];
        for (let i = 0; i < o.length - 1; i++) flat.push(o[i].x * s, o[i].y * s);
        for (const hole of poly.holes) {
          holeIdx.push(flat.length / 2);
          for (let i = 0; i < hole.length - 1; i++) flat.push(hole[i].x * s, hole[i].y * s);
        }
        const idx = earcut(flat, holeIdx);
        const rc = realRoof ?? FLAT_ROOF.map((v, i) => v * (0.9 + ((seed >>> (i * 3)) % 10) / 50));
        for (let i = 0; i < idx.length; i += 3) {
          for (const k of [idx[i], idx[i + 2], idx[i + 1]]) {
            b.roofs.vert(flat[k * 2], y1, flat[k * 2 + 1], 0, 1, 0, 0, 0, rc);
          }
        }
        // Atika a technika na střeše (strojovny výtahů, vzduchotechnika).
        if (areaM > 150 && minH < 2.5) {
          const ob = obb(ringM);
          if (ob) {
            const n = Math.min(4, 1 + Math.floor(areaM / 400));
            for (let k = 0; k < n; k++) {
              const r1 = ((seed >>> (k * 5)) % 100) / 100, r2 = ((seed >>> (k * 5 + 3)) % 100) / 100;
              const along = (r1 - 0.5) * ob.hl * 1.2;
              const across = (r2 - 0.5) * ob.hs * 0.8;
              const cxr = ob.cx + ob.ux * along - ob.uz * across;
              const czr = ob.cz + ob.uz * along + ob.ux * across;
              const big = k === 0 && ph > 12;
              const w2 = big ? 2.2 : 0.8 + r1 * 0.6, d2 = big ? 3 : 0.8 + r2 * 0.6, h2 = big ? 2.6 : 0.9;
              roofBox(b, cxr, czr, ob.ux, ob.uz, w2, d2, y1, y1 + h2, big ? rc.map((v) => v * 1.15) : [0.72, 0.73, 0.74]);
            }
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
  heightSafe: (lx: number, lz: number) => number;
  size: number;
  marked: MeshBuf;
  plain: MeshBuf;
  paths: MeshBuf;
  sides: MeshBuf;
  rails: MeshBuf;
  walks: MeshBuf;
  crossings: MeshBuf;
  /** Tramvajové koleje zapuštěné ve vozovce. */
  tramRails: MeshBuf;
  /** Leží bod na vozovce (jakékoli silnice)? */
  carriage?: (x: number, z: number) => boolean;
  urban: (x: number, z: number) => boolean;
  bridges: FloatBuf;
  lines: RoadLine[];
}

/** Hustota zástavby z těžišť budov – rozhoduje o chodnících a lampách. */
function makeUrban(bpts: Float32Array, sizeM: number): (x: number, z: number) => boolean {
  const G = 48;
  const cs = sizeM / G;
  const dens = new Uint16Array(G * G);
  for (let i = 0; i < bpts.length; i += 3) {
    const gx = Math.floor(bpts[i] / cs), gz = Math.floor(bpts[i + 1] / cs);
    if (gx >= 0 && gz >= 0 && gx < G && gz < G) dens[gz * G + gx]++;
  }
  return (x: number, z: number) => {
    const gx = Math.floor(x / cs), gz = Math.floor(z / cs);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = gx + dx, b = gz + dz;
      if (a >= 0 && b >= 0 && a < G && b < G) n += dens[b * G + a];
    }
    return n >= 4;
  };
}

/** Rovnoběžka s lomenou čarou ve vzdálenosti d (kladně doleva). */
function offsetLine(pts: number[][], d: number): number[][] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    let sc = 1;
    if (i > 0 && i < n - 1) {
      const d1x = p[0] - a[0], d1z = p[1] - a[1];
      const l1 = Math.hypot(d1x, d1z) || 1;
      const cos = (d1x / l1) * dx + (d1z / l1) * dz;
      sc = 1 / Math.max(0.5, Math.sqrt((1 + cos) / 2));
    }
    return [p[0] + dz * d * sc, p[1] - dx * d * sc];
  });
}

const SIDEWALK = new Set(['minor', 'tertiary', 'secondary', 'primary', 'busway']);

/** Chodníky po obou stranách ulice a obrubník směrem k vozovce. */
function sidewalks(r: RoadCtx, pts: number[][], hw: number, roadY: number) {
  const w = 2.4;
  for (const side of [1, -1]) {
    // Body chodníku na vozovce jiné ulice (křižovatky) vynechat.
    const mid = offsetLine(pts, side * (hw + w / 2));
    const keep = mid.map((p, i) => !r.carriage?.(p[0], p[1]) && !r.carriage?.(...(offsetLine(pts, side * (hw + 0.3))[i] as [number, number])));
    const runs: number[][][] = [];
    let cur: number[] = [];
    keep.forEach((k, i) => {
      if (k) cur.push(i);
      else {
        if (cur.length > 1) runs.push(cur.map((j) => [j]));
        cur = [];
      }
    });
    if (cur.length > 1) runs.push(cur.map((j) => [j]));
    for (const run of runs) {
      const idx = run.map((q) => q[0]);
      const sub = idx.map((j) => pts[j]);
      sidewalkSide(r, sub, hw, roadY, side, w);
    }
  }
}

function sidewalkSide(r: RoadCtx, pts: number[][], hw: number, roadY: number, side: number, w: number) {
  {
    const mid = offsetLine(pts, side * (hw + w / 2));
    ribbon(r.walks, mid, w, roadY + 0.16, null, r, false, false);
    // Obrubník.
    const edge = offsetLine(pts, side * hw);
    for (let i = 0; i + 1 < edge.length; i++) {
      const p = edge[i], q = edge[i + 1];
      const yp = r.height(p[0], p[1]), yq = r.height(q[0], q[1]);
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      const nx = (-dz / l) * side, nz = (dx / l) * side;
      const m = r.walks;
      m.vert(p[0], yp + roadY, p[1], nx, 0, nz, 0.02, 0);
      m.vert(q[0], yq + roadY, q[1], nx, 0, nz, 0.02, 0);
      m.vert(q[0], yq + roadY + 0.16, q[1], nx, 0, nz, 0.02, 0.02);
      m.vert(p[0], yp + roadY, p[1], nx, 0, nz, 0.02, 0);
      m.vert(q[0], yq + roadY + 0.16, q[1], nx, 0, nz, 0.02, 0.02);
      m.vert(p[0], yp + roadY + 0.16, p[1], nx, 0, nz, 0.02, 0.02);
    }
  }
}

function ribbon(
  m: MeshBuf, pts: number[][], width: number, yOff: number, heights: number[] | null,
  r: RoadCtx, sides: boolean, caps = false,
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
      // Terén pod silnicí je zarovnaný (flattenRoads), takže stačí výška osy.
      ly = ry = r.height(p[0], p[1]) + yOff;
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
    // Zábradlí a podhled jen tam, kde je mostovka znatelně nad terénem.
    const lift = sides ? Math.min(a[1] - r.height(pts[i][0], pts[i][1]), c[1] - r.height(pts[i + 1][0], pts[i + 1][1])) : 0;
    if (sides && lift > 2.5) {
      for (const [p, q] of [[a, c], [d, b]] as number[][][]) {
        const dx = q[0] - p[0], dz = q[2] - p[2];
        const l = Math.hypot(dx, dz) || 1;
        const nx = dz / l, nz = -dx / l;
        const h0 = 0.9;
        const s = r.sides;
        // Podhled mostovky.
        s.vert(p[0], p[1] - h0, p[2], nx, 0, nz);
        s.vert(q[0], q[1] - h0, q[2], nx, 0, nz);
        s.vert(q[0], q[1] + 0.6, q[2], nx, 0, nz);
        s.vert(p[0], p[1] - h0, p[2], nx, 0, nz);
        s.vert(q[0], q[1] + 0.6, q[2], nx, 0, nz);
        s.vert(p[0], p[1] + 0.6, p[2], nx, 0, nz);
      }
    }
  }
  // Zakulacené konce: silnice v křižovatkách a slepé konce navazují hladce.
  if (caps) {
    const onEdge = (q: number[]) => q[0] < 0.6 || q[1] < 0.6 || q[0] > r.size - 0.6 || q[1] > r.size - 0.6;
    const cap = (i: number, dirSign: number) => {
      const p = pts[i];
      if (onEdge(p)) return;
      const y = (L[i][1] + R[i][1]) / 2;
      const o = pts[i + (dirSign > 0 ? -1 : 1)];
      let dx = p[0] - o[0], dz = p[1] - o[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const nx = dz, nz = -dx; // levá normála
      const seg = 7;
      const v = vs[i] / 8;
      let prev = [p[0] + nx * hw, p[1] + nz * hw];
      for (let k = 1; k <= seg; k++) {
        const a = (k / seg) * Math.PI;
        const cx = Math.cos(a), sx = Math.sin(a);
        // Otáčení od levé normály přes směr ven k pravé normále.
        const q = [p[0] + (nx * cx + dx * sx) * hw, p[1] + (nz * cx + dz * sx) * hw];
        // Pořadí vrcholů tak, aby líc mířil nahoru (jinak DoubleSide otočí normálu a víčko ztmavne).
        const cr = (prev[0] - p[0]) * (q[1] - p[1]) - (prev[1] - p[1]) * (q[0] - p[0]);
        const [b1, b2] = cr < 0 ? [prev, q] : [q, prev];
        m.vert(p[0], y, p[1], 0, 1, 0, 0.36, v);
        m.vert(b1[0], y, b1[1], 0, 1, 0, 0.36, v);
        m.vert(b2[0], y, b2[1], 0, 1, 0, 0.36, v);
        prev = q;
      }
    };
    cap(0, -1);
    cap(n - 1, 1);
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

/**
 * Zarovná terén pod silnicemi (náspy a zářezy), aby silnice neplavaly nad svahem ani se nenořily.
 * Okrajové vrcholy dlaždice se nemění, aby sousední dlaždice navazovaly.
 */
function flattenRoads(vt: VectorTile, grid: HeightGrid) {
  const layer = vt.layers.transportation;
  if (!layer) return;
  const { n, size, h } = grid;
  const w = n + 1;
  const e = size / n;
  const orig = h.slice();
  const og: HeightGrid = { n, size, h: orig };
  const at = (x: number, z: number) => gridHeight(og, Math.min(size, Math.max(0, x)), Math.min(size, Math.max(0, z)));
  const weight = new Float32Array(w * w);
  const target = new Float32Array(w * w);
  const s = size / EXTENT;
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi);
    if (f.type !== 2) continue;
    const cls = String(f.properties.class);
    if (!DRIVABLE.has(cls) || f.properties.brunnel) continue;
    const hw = (ROAD_WIDTH[cls] ?? 5) / 2;
    const inner = hw + e * 0.5;
    const outer = hw + e + 2.5;
    for (const line of f.loadGeometry()) {
      const pts = resample(line.map((q) => [q.x * s, q.y * s]), 4);
      if (pts.length < 2) continue;
      // Výškový profil osy, vyhlazený klouzavým průměrem.
      const raw = pts.map((q) => at(q[0], q[1]));
      const prof = raw.map((_, i) => {
        let acc = 0;
        let c = 0;
        for (let k = Math.max(0, i - 3); k <= Math.min(raw.length - 1, i + 3); k++) {
          acc += raw[k];
          c++;
        }
        return acc / c;
      });
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[i + 1];
        if (Math.max(ax, bx) < -outer || Math.max(az, bz) < -outer || Math.min(ax, bx) > size + outer || Math.min(az, bz) > size + outer) continue;
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const i0 = Math.max(1, Math.floor((Math.min(ax, bx) - outer) / e));
        const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + outer) / e));
        const j0 = Math.max(1, Math.floor((Math.min(az, bz) - outer) / e));
        const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + outer) / e));
        for (let j = j0; j <= j1; j++) {
          for (let ii = i0; ii <= i1; ii++) {
            const x = ii * e, z = j * e;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
            const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
            if (d >= outer) continue;
            const wt = d <= inner ? 1 : 1 - (d - inner) / (outer - inner);
            const k = j * w + ii;
            if (wt > weight[k]) {
              weight[k] = wt;
              target[k] = prof[i] + (prof[i + 1] - prof[i]) * t;
            }
          }
        }
      }
    }
  }
  for (let k = 0; k < h.length; k++) {
    if (weight[k] > 0) {
      const sm = weight[k] * weight[k] * (3 - 2 * weight[k]);
      h[k] = orig[k] + (target[k] - orig[k]) * sm;
    }
  }
}

/**
 * Přechody pro chodce: na městských křižovatkách (3+ ramena) zebra přes každé
 * rameno ~ 4 m za okrajem křižující silnice.
 */
function buildCrossings(vt: VectorTile, r: RoadCtx) {
  const layer = vt.layers.transportation;
  if (!layer) return;
  const s = r.s;
  const OK = new Set(['minor', 'tertiary', 'secondary', 'primary', 'busway']);
  // Uzly: počet ramen a největší šířka silnice v uzlu.
  const nodes = new Map<string, { x: number; z: number; arms: { dx: number; dz: number; hw: number; y: number }[]; maxHw: number }>();
  const key = (x: number, z: number) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi);
    if (f.type !== 2 || f.properties.brunnel) continue;
    const cls = String(f.properties.class);
    if (!OK.has(cls)) continue;
    const hw = (ROAD_WIDTH[cls] ?? 6) / 2;
    const yOff = 0.22 + (ROAD_PRIO[cls] ?? 1) * 0.025;
    for (const line of f.loadGeometry()) {
      const pts = line.map((q) => [q.x * s, q.y * s]);
      for (let i = 0; i < pts.length; i++) {
        const [x, z] = pts[i];
        if (x < 0 || z < 0 || x > r.size || z > r.size) continue;
        const k = key(x, z);
        let n = nodes.get(k);
        if (!n) nodes.set(k, (n = { x, z, arms: [], maxHw: 0 }));
        n.maxHw = Math.max(n.maxHw, hw);
        for (const j of [i - 1, i + 1]) {
          if (j < 0 || j >= pts.length) continue;
          const dx = pts[j][0] - x, dz = pts[j][1] - z;
          const l = Math.hypot(dx, dz);
          if (l < 8) continue; // příliš krátký úsek
          n.arms.push({ dx: dx / l, dz: dz / l, hw, y: yOff });
        }
      }
    }
  }
  const m = r.crossings;
  for (const n of nodes.values()) {
    if (n.arms.length < 3 || !r.urban(n.x, n.z)) continue;
    for (const a of n.arms) {
      const d = n.maxHw + 4;
      const cx = n.x + a.dx * d, cz = n.z + a.dz * d;
      const px = -a.dz, pz = a.dx; // napříč ramenem
      const w = 1.6; // šířka přechodu podél silnice
      const hw = a.hw - 0.2;
      const y = r.height(cx, cz) + a.y + 0.03;
      const P = (u: number, v: number) => [cx + px * u + a.dx * v, cz + pz * u + a.dz * v];
      const q = [P(-hw, -w), P(hw, -w), P(hw, w), P(-hw, w)];
      const ul = (hw * 2) / 1.0; // pruhy po 0,5 m (textura: bílý + mezera = 1 m)
      const uv = [[0, 0], [ul, 0], [ul, 1], [0, 1]];
      for (const i of [0, 1, 2, 0, 2, 3]) m.vert(q[i][0], y, q[i][1], 0, 1, 0, uv[i][0], uv[i][1]);
    }
  }
}

function buildRoads(vt: VectorTile, r: RoadCtx) {
  const layer = vt.layers.transportation;
  if (!layer) return;
  const s = r.s;
  // Maska vozovek (1 px ≈ 1 m) – chodníky v křižovatkách se přes ni nekreslí.
  {
    const M = 1600;
    const c = new OffscreenCanvas(M, M);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const k = M / EXTENT;
    const pxPerM = M / r.size;
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let fi = 0; fi < layer.length; fi++) {
      const f = layer.feature(fi);
      const cls = String(f.properties.class);
      if (f.type !== 2 || !DRIVABLE.has(cls) || cls === 'track' || f.properties.brunnel === 'tunnel') continue;
      drawFeature(ctx, f, k, false);
      ctx.lineWidth = Math.max(1, (ROAD_WIDTH[cls] ?? 5) * pxPerM);
      ctx.stroke();
    }
    const d = ctx.getImageData(0, 0, M, M).data;
    r.carriage = (x: number, z: number) => {
      const i = Math.floor(x * pxPerM), j = Math.floor(z * pxPerM);
      if (i < 0 || j < 0 || i >= M || j >= M) return false;
      return d[(j * M + i) * 4] > 128;
    };
  }
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi);
    if (f.type !== 2) continue;
    const p = f.properties;
    const cls = String(p.class);
    const isRail = cls === 'rail' || (cls === 'transit' && (p.subclass === 'tram' || p.subclass === 'subway'));
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
        // Konce mostu: první/poslední bod linie, kde známe výšku terénu.
        hA = NaN;
        hB = NaN;
        for (let i = 0; i < full.length && Number.isNaN(hA); i++) hA = r.heightSafe(full[i].x * s, full[i].y * s);
        for (let i = full.length - 1; i >= 0 && Number.isNaN(hB); i--) hB = r.heightSafe(full[i].x * s, full[i].y * s);
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
            const ground = r.height(q[0], q[1]);
            if (Number.isNaN(hA) || Number.isNaN(hB)) return ground + 0.3;
            const deck = hA + (hB - hA) * t;
            // Pojistka proti nesmyslným datům: mostovka nad terénem, ale ne do nebe.
            return Math.min(Math.max(deck, ground), ground + 60);
          });
        }
        const prio = ROAD_PRIO[cls] ?? 1;
        if (!tunnel) {
          if (isRail) {
            // Tramvaj v zástavbě: kolejnice zapuštěné do vozovky (bez pražců).
            const street = cls === 'transit' && pts.length > 1 && r.urban(pts[Math.floor(pts.length / 2)][0], pts[Math.floor(pts.length / 2)][1]);
            ribbon(street ? r.tramRails : r.rails, pts, street ? 2.6 : 3.0, street ? 0.27 : 0.12, heights, r, false);
          } else {
            const m = cls === 'path' ? r.paths : MARKED.has(cls) ? r.marked : r.plain;
            ribbon(m, pts, width, 0.22 + prio * 0.025, heights, r, bridge, !bridge);
            if (!bridge && SIDEWALK.has(cls) && pts.length > 1) {
              const mid = pts[Math.floor(pts.length / 2)];
              if (r.urban(mid[0], mid[1])) sidewalks(r, pts, width / 2, 0.22 + prio * 0.025);
            }
          }
          if (bridge && heights && !isRail) {
            for (let i = 0; i + 1 < pts.length; i++) {
              r.bridges.push(pts[i][0], pts[i][1], heights[i] + 0.3, pts[i + 1][0], pts[i + 1][1], heights[i + 1] + 0.3, width / 2 + 0.5);
            }
          }
        }
        const isTram = cls === 'transit' && p.subclass === 'tram';
        const isMetro = cls === 'transit' && p.subclass === 'subway';
        if (DRIVABLE.has(cls) || cls === 'path' || isTram || isMetro) {
          const arr = new Float32Array(part.length * 3);
          part.forEach((q, i) => {
            const x = q.x * s, z = q.y * s;
            arr[i * 3] = x;
            arr[i * 3 + 1] = bridge && heights ? NaN : r.height(x, z);
            arr[i * 3 + 2] = z;
          });
          r.lines.push({ cls: isTram ? 'tram' : isMetro ? 'metro' : cls, oneway: isMetro ? 0 : oneway, bridge, tunnel, pts: arr });
        }
      }
    }
  }
}

// ---------------------------------------------------------------- stromy

/**
 * Stromy. V Česku podle skutečné vegetace z ČÚZK (výška porostu = DMP 1G − DMR 5G),
 * mimo republiku podle lesů z OSM. Na loukách řídké keře.
 */
function buildTrees(
  vt: VectorTile, sizeM: number, budget: number, seed: number, height: (x: number, z: number) => number,
  canopy: Float32Array | null, cn: number,
): { trees: Float32Array; circles: number[] } {
  const M = 512;
  const c = new OffscreenCanvas(M, M);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  // R = les (OSM), G = louka/park (keře), 0 = zakázáno.
  ctx.fillStyle = canopy ? 'rgb(0,30,0)' : '#000';
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
    let r = 0, g = 0;
    if (cls === 'wood') r = 255;
    else if (sub === 'scrub') { r = 70; g = 60; }
    else if (cls === 'grass' || sub === 'park' || sub === 'garden') { r = 25; g = 45; }
    else if (cls === 'wetland') { r = 50; g = 30; }
    if (!r && !g) return;
    drawFeature(ctx, f, s, true);
    ctx.fillStyle = `rgb(${r},${g},0)`;
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
    ctx.lineWidth = 2.5 * pxPerM;
    ctx.stroke();
  });
  each('transportation', (f) => {
    if (f.type !== 2) return;
    const w = ROAD_WIDTH[String(f.properties.class)] ?? 4;
    drawFeature(ctx, f, s, false);
    ctx.lineWidth = Math.max(1.5, (w + 3) * pxPerM);
    ctx.stroke();
  });
  each('waterway', (f) => {
    drawFeature(ctx, f, s, false);
    ctx.lineWidth = 5 * pxPerM;
    ctx.stroke();
  });
  each('aeroway', (f) => {
    drawFeature(ctx, f, s, f.type === 3);
    if (f.type === 3) ctx.fill('evenodd');
    else {
      ctx.lineWidth = 50 * pxPerM;
      ctx.stroke();
    }
  });
  const d = ctx.getImageData(0, 0, M, M).data;
  const rnd = mulberry(seed ^ 0x9e3779b9);
  const out = new FloatBuf(budget * 5);
  const circles: number[] = [];
  const canopyAt = (x: number, z: number) => {
    const i = Math.min(cn - 1, Math.max(0, Math.round((x / sizeM) * (cn - 1))));
    const j = Math.min(cn - 1, Math.max(0, Math.round((z / sizeM) * (cn - 1))));
    const v = canopy![j * cn + i];
    return Number.isFinite(v) ? v : 0;
  };
  let tries = budget * 8;
  let count = 0;
  let bushes = 0;
  while (tries-- > 0 && count < budget) {
    const px = rnd() * M;
    const py = rnd() * M;
    const k = (Math.floor(py) * M + Math.floor(px)) * 4;
    const r = d[k], g = d[k + 1];
    if (r === 0 && g === 0) continue;
    const x = (px / M) * sizeM;
    const z = (py / M) * sizeM;
    const y = height(x, z);
    let kind: number;
    let sc: number;
    if (canopy) {
      const ch = canopyAt(x, z);
      if (ch >= 3.5 && ch < 60) {
        const conProb = y > 750 ? 0.9 : y > 500 ? 0.65 : r > 200 ? 0.5 : 0.15;
        kind = rnd() < conProb ? 0 : 1;
        sc = Math.max(0.45, Math.min(2.6, ch / (kind === 0 ? 13 : 10))) * (0.85 + rnd() * 0.3);
      } else if (g > 0 && bushes < budget * 0.08 && rnd() < 0.04) {
        kind = 2;
        sc = 0.6 + rnd() * 0.6;
        bushes++;
      } else continue;
    } else {
      if (rnd() * 255 > r) {
        if (g > 0 && bushes < budget * 0.08 && rnd() < 0.05) {
          kind = 2;
          sc = 0.6 + rnd() * 0.6;
          bushes++;
        } else continue;
      } else {
        const forest = r > 200;
        kind = forest ? (rnd() < 0.62 ? 0 : 1) : rnd() < 0.25 ? 0 : 1;
        sc = forest ? 1 + rnd() * 0.7 : 0.6 + rnd() * 0.5;
      }
    }
    out.push(x, y - 0.3, z, sc, kind);
    if (kind !== 2) circles.push(x, z, 0.3 * sc + 0.15);
    count++;
  }
  return { trees: out.out(), circles };
}

/** Pouliční lampy podél silnic v zastavěném území. */
function buildLamps(vt: VectorTile, sizeM: number, bpts: Float32Array, height: (x: number, z: number) => number): Float32Array {
  const G = 48;
  const cs = sizeM / G;
  const dens = new Uint16Array(G * G);
  for (let i = 0; i < bpts.length; i += 3) {
    const gx = Math.floor(bpts[i] / cs), gz = Math.floor(bpts[i + 1] / cs);
    if (gx >= 0 && gz >= 0 && gx < G && gz < G) dens[gz * G + gx]++;
  }
  const urban = (x: number, z: number) => {
    const gx = Math.floor(x / cs), gz = Math.floor(z / cs);
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const a = gx + dx, b = gz + dz;
      if (a >= 0 && b >= 0 && a < G && b < G) n += dens[b * G + a];
    }
    return n >= 4;
  };
  const layer = vt.layers.transportation;
  const out = new FloatBuf(1024);
  if (!layer) return out.out();
  const s = sizeM / EXTENT;
  const OK = new Set(['minor', 'tertiary', 'secondary', 'primary', 'busway']);
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi);
    if (f.type !== 2 || !OK.has(String(f.properties.class)) || f.properties.brunnel) continue;
    const hw = (ROAD_WIDTH[String(f.properties.class)] ?? 6) / 2 + 1.2;
    for (const line of f.loadGeometry()) {
      for (const part of clipLine(line, EXTENT)) {
        let acc = 14;
        let side = 1;
        for (let i = 0; i + 1 < part.length; i++) {
          const ax = part[i].x * s, az = part[i].y * s, bx = part[i + 1].x * s, bz = part[i + 1].y * s;
          const l = Math.hypot(bx - ax, bz - az);
          if (l < 0.01) continue;
          const nx = (bz - az) / l, nz = -(bx - ax) / l;
          while (acc < l) {
            const t = acc / l;
            const x = ax + (bx - ax) * t + nx * hw * side;
            const z = az + (bz - az) * t + nz * hw * side;
            if (urban(x, z)) out.push(x, height(x, z), z);
            acc += 32;
            side = -side;
          }
          acc -= l;
        }
      }
    }
  }
  return out.out();
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
  for (let e = 0; e < edges.length / 5; e++) {
    add(edges[e * 5], edges[e * 5 + 1], edges[e * 5 + 2], edges[e * 5 + 3], e);
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
  const fuel: NamedPoint[] = [];
  const tram: NamedPoint[] = [];
  const addresses: NamedPoint[] = [];
  const places: PlacePoint[] = [];
  const streets: StreetLine[] = [];
  const inside = (p: Pt) => p.x >= 0 && p.y >= 0 && p.x < EXTENT && p.y < EXTENT;
  const poi = vt.layers.poi;
  if (poi) {
    for (let i = 0; i < poi.length; i++) {
      const f = poi.feature(i);
      const pc = f.properties.class;
      const tramStop = pc === 'railway' && f.properties.subclass === 'tram_stop';
      if (pc !== 'bus' && pc !== 'fuel' && !tramStop) continue;
      const g = f.loadGeometry()[0]?.[0];
      if (!g || !inside(g)) continue;
      if (tramStop) {
        tram.push({ name: String(f.properties.name ?? 'Zastávka'), x: g.x * s, z: g.y * s });
        continue;
      }
      if (pc === 'fuel') {
        fuel.push({ name: String(f.properties.name ?? 'Čerpací stanice'), x: g.x * s, z: g.y * s });
        continue;
      }
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
  return { stops, addresses, places, streets, fuel, tramStops: tram };
}

// ---------------------------------------------------------------- hlavní

/**
 * Panoramatická dlaždice: jen siluety vyšších budov (od 12 m) a velkých staveb,
 * jednoduché kvádry s plochou střechou. Výšky terénu z Terraria (bez ČÚZK).
 */
async function buildSkyline(req: TileRequest): Promise<{ data: TileData; transfer: Transferable[] }> {
  const { z, x, y } = req;
  const sizeM = TILE_M;
  const ez = 13;
  const scale = 2 ** (ez - z) * 256;
  const sampler = new ElevSampler(ez);
  const vtP = loadVector(req.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  await sampler.prepare((x - 0.05) * scale, (y - 0.05) * scale, (x + 1.05) * scale, (y + 1.05) * scale);
  const vt = await vtP;
  const height = (lx: number, lz: number) => sampler.sample((x + lx / sizeM) * scale, (y + lz / sizeM) * scale);
  const walls = new MeshBuf();
  const roofs = new MeshBuf();
  const bctx = { walls, roofs } as unknown as BuildCtx;
  const layer = vt?.layers.building;
  const s = sizeM / EXTENT;
  if (layer) {
    for (let fi = 0; fi < layer.length; fi++) {
      const f = layer.feature(fi);
      const h = Number(f.properties.render_height) || 0;
      if (Number(f.properties.render_min_height) > 2) continue;
      for (const ring of f.loadGeometry()) {
        if (ring.length < 4 || ringArea(ring) <= 0) continue;
        const areaM = ringArea(ring) * s * s;
        if (h < 12 && !(areaM > 2500 && h >= 7)) continue;
        let cx = 0, cy = 0;
        for (const p of ring) {
          cx += p.x;
          cy += p.y;
        }
        cx /= ring.length;
        cy /= ring.length;
        if (cx < 0 || cy < 0 || cx >= EXTENT || cy >= EXTENT) continue;
        let base = Infinity;
        for (const p of ring) base = Math.min(base, height(p.x * s, p.y * s));
        const seed = hashStr(`${Math.round(cx)},${Math.round(cy)}`);
        const col = FACADES[seed % FACADES.length];
        const y1 = base + h;
        let u = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          u = addWall(bctx, ring[i].x * s, ring[i].y * s, ring[i + 1].x * s, ring[i + 1].y * s, base - 1, y1, u, col);
        }
        const flat: number[] = [];
        for (let i = 0; i < ring.length - 1; i++) flat.push(ring[i].x * s, ring[i].y * s);
        const idx = earcut(flat);
        for (let i = 0; i < idx.length; i += 3) {
          for (const k of [idx[i], idx[i + 2], idx[i + 1]]) roofs.vert(flat[k * 2], y1, flat[k * 2 + 1], 0, 1, 0, 0, 0, FLAT_ROOF);
        }
      }
    }
  }
  const empty = new Float32Array(0);
  const data: TileData = {
    id: req.id, kind: 'skyline', z, x, y, size: sizeM, n: 0, heights: empty, terrain: { pos: empty, nor: empty }, texture: null,
  };
  const transfer: Transferable[] = [];
  if (!walls.empty) {
    data.walls = walls.arrays(true, true);
    transfer.push(data.walls.pos.buffer, data.walls.nor.buffer, data.walls.uv!.buffer, data.walls.col!.buffer);
  }
  if (!roofs.empty) {
    data.roofs = roofs.arrays(false, true);
    transfer.push(data.roofs.pos.buffer, data.roofs.nor.buffer, data.roofs.col!.buffer);
  }
  return { data, transfer };
}

async function build(req: TileRequest): Promise<{ data: TileData; transfer: Transferable[] }> {
  if (req.kind === 'skyline') return buildSkyline(req);
  const { z, x, y } = req;
  const sizeM = TILE_M * 2 ** (14 - z);
  const near = req.kind === 'near';
  // Měření doby jednotlivých kroků (pro ladění výkonu).
  const prof: Record<string, number> = {};
  let pt = performance.now();
  const mark = (k: string) => {
    const n = performance.now();
    prof[k] = Math.round((prof[k] ?? 0) + n - pt);
    pt = n;
  };
  const N = near ? req.n : 64;
  const ez = near ? 13 : z - 1;
  const scale = 2 ** (ez - z) * 256;
  const sampler = new ElevSampler(ez);
  const margin = 0.15;
  const vtPromise = loadVector(req.tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  const CN = 257;
  const step = 256 / N;
  const cz = near && inCzBox(z, x, y);
  const dmrP = cz ? loadCuzk('dmr5g', z, x, y, CN) : Promise.resolve(null);
  const aerial = req.aerial && inCzBox(z, x, y);
  const orthoP = (cz && req.texSize >= 512) || aerial ? loadOrtho(z, x, y, near ? Math.max(768, aerial ? req.texSize : 0) : 512) : Promise.resolve(null);
  const ruianP = cz ? loadRuian(z, x, y, TILE_M * 2 ** (14 - z)) : Promise.resolve([] as RuianPt[]);
  const dmpP = cz && req.treeBudget > 0 ? loadCuzk('dmp1g', z, x, y, CN) : Promise.resolve(null);
  await sampler.prepare((x - margin) * scale, (y - margin) * scale, (x + 1 + margin) * scale, (y + 1 + margin) * scale);
  const dmr = await dmrP;
  mark('dmr+terrarium');
  const h = new Float32Array((N + 1) * (N + 1));
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const v = dmr ? dmr[j * step * CN + i * step] : NaN;
      h[j * (N + 1) + i] = Number.isFinite(v) ? v : sampler.sample((x + i / N) * scale, (y + j / N) * scale);
    }
  }
  const dmp = await dmpP;
  mark('dmp');
  let canopy: Float32Array | null = null;
  if (dmr && dmp) {
    canopy = new Float32Array(CN * CN);
    for (let i = 0; i < canopy.length; i++) canopy[i] = dmp[i] - dmr[i];
  }
  const grid: HeightGrid = { n: N, size: sizeM, h };
  const globalHeight = (lx: number, lz: number) => sampler.sample((x + lx / sizeM) * scale, (y + lz / sizeM) * scale);
  const height = (lx: number, lz: number) => {
    const v = gridHeight(grid, lx, lz);
    return Number.isNaN(v) ? globalHeight(lx, lz) : v;
  };
  const vt = await vtPromise;
  mark('vektor');
  if (near && vt) flattenRoads(vt, grid);
  mark('srovnani');
  const seed = hashStr(`${z}/${x}/${y}`);
  let canvas = paintGround(vt, req.texSize, sizeM, seed, near);
  if (aerial) {
    // Letecký snímek místo mapových barev (silnice a budovy jsou na něm vidět).
    const ortho = await orthoP;
    if (ortho) {
      const c = new OffscreenCanvas(req.texSize, req.texSize);
      const cx = c.getContext('2d')!;
      cx.drawImage(ortho.canvas, 0, 0, req.texSize, req.texSize);
      // Mírně zesvětlit a dosytit (snímek je zašedlý).
      cx.globalCompositeOperation = 'soft-light';
      cx.fillStyle = 'rgba(255,245,225,0.35)';
      cx.fillRect(0, 0, req.texSize, req.texSize);
      cx.globalCompositeOperation = 'source-over';
      // Střechy otištěné na zemi zakrýt (budovy stojí nad nimi jako 3D modely).
      const bl = vt?.layers.building;
      if (bl && near) {
        const k = req.texSize / EXTENT;
        cx.fillStyle = '#a9a69d';
        cx.strokeStyle = '#a9a69d';
        cx.lineWidth = Math.max(1, (2 * req.texSize) / sizeM);
        for (let i = 0; i < bl.length; i++) {
          drawFeature(cx, bl.feature(i), k, true);
          cx.fill('evenodd');
          cx.stroke();
        }
      }
      canvas = c;
    }
  }
  mark('textura');
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
    const ruian = await ruianP;
    mark('ruian');
    const ortho = await orthoP;
    mark('ortofoto');
    // Provozovny z OSM (poi) pro cedule.
    const shopsPoi: ShopPoi[] = [];
    const poi = vt.layers.poi;
    if (poi) {
      for (let i = 0; i < poi.length; i++) {
        const f = poi.feature(i);
        const cls = String(f.properties.class);
        const name = f.properties.name;
        if (!name || !SHOP_CLASSES.has(cls)) continue;
        const g = f.loadGeometry()[0]?.[0];
        if (!g) continue;
        const sub = f.properties.subclass ? String(f.properties.subclass) : cls;
        shopsPoi.push({ name: String(name), cls: cls === 'shop' || cls === 'grocery' ? sub : cls, x: g.x * s, z: g.y * s, used: false, sign: false, rank: Number(f.properties.rank) || 99 });
      }
    }
    // Cedule dostanou nejvýznamnější provozovny (nižší rank), aby se vešly do atlasu.
    const cap = (SignAtlas.W / SignAtlas.CW | 0) * Math.floor(SignAtlas.H / SignAtlas.CH);
    [...shopsPoi].sort((a, b) => a.rank - b.rank).slice(0, cap).forEach((p) => (p.sign = true));
    prof.poi = shopsPoi.length;
    const bctx: BuildCtx = {
      s, height, walls: new MeshBuf(), roofs: new MeshBuf(), edges: new FloatBuf(4096), bpts: new FloatBuf(1024), shops: new MeshBuf(), panels: new MeshBuf(), houses: new MeshBuf(), halls: new MeshBuf(),
      canopy, cn: CN, size: sizeM,
      facades: { historic: new MeshBuf(), modern: new MeshBuf(), office: new MeshBuf(), garage: new MeshBuf(), wood: new MeshBuf() },
      ruian, shopsPoi, signs: new MeshBuf(), atlas: shopsPoi.length ? new SignAtlas() : null, ortho,
    };
    buildBuildings(vt, bctx);
    mark('budovy');
    const rctx: RoadCtx = {
      s, height, globalHeight, size: sizeM,
      heightSafe: (lx: number, lz: number) => {
        const v = gridHeight(grid, lx, lz);
        return Number.isNaN(v) ? sampler.sampleSafe((x + lx / sizeM) * scale, (y + lz / sizeM) * scale) : v;
      },
      marked: new MeshBuf(), plain: new MeshBuf(), paths: new MeshBuf(), sides: new MeshBuf(),
      rails: new MeshBuf(), walks: new MeshBuf(), crossings: new MeshBuf(), tramRails: new MeshBuf(), urban: makeUrban(bctx.bpts.out(), sizeM), bridges: new FloatBuf(256), lines: [],
    };
    buildRoads(vt, rctx);
    mark('silnice');
    if (!bctx.walls.empty) data.walls = bctx.walls.arrays(true, true);
    if (!bctx.roofs.empty) data.roofs = bctx.roofs.arrays(false, true);
    if (!rctx.marked.empty) data.roadsMarked = rctx.marked.arrays(true, false);
    if (!rctx.plain.empty) data.roadsPlain = rctx.plain.arrays(true, false);
    if (!rctx.paths.empty) data.paths = rctx.paths.arrays(true, false);
    if (!rctx.walks.empty) data.sidewalks = rctx.walks.arrays(true, false);
    buildCrossings(vt, rctx);
    if (!rctx.crossings.empty) data.crossings = rctx.crossings.arrays(true, false);
    if (!bctx.shops.empty) data.shops = bctx.shops.arrays(true, true);
    if (!bctx.panels.empty) data.panels = bctx.panels.arrays(true, true);
    if (!bctx.houses.empty) data.houses = bctx.houses.arrays(true, true);
    if (!bctx.halls.empty) data.halls = bctx.halls.arrays(true, true);
    if (!rctx.sides.empty) data.bridgeSides = rctx.sides.arrays(false, false);
    if (!rctx.rails.empty) data.rails = rctx.rails.arrays(true, false);
    if (!rctx.tramRails.empty) data.tramRails = rctx.tramRails.arrays(true, false);
    for (const m of [data.walls, data.roofs, data.roadsMarked, data.roadsPlain, data.paths, data.bridgeSides, data.rails, data.sidewalks, data.shops, data.panels, data.houses, data.halls, data.crossings, data.tramRails]) addMesh(m);
    prof.signs = bctx.atlas ? bctx.atlas.n : 0;
    for (const [k, v] of Object.entries(KIND_STATS)) prof[`k_${k}`] = v;
    for (const k of Object.keys(KIND_STATS)) delete KIND_STATS[k];
    data.facades = {};
    for (const [k, m] of Object.entries(bctx.facades)) {
      if (m.empty) continue;
      data.facades[k] = m.arrays(true, true);
      addMesh(data.facades[k]);
    }
    if (!bctx.signs.empty && bctx.atlas) {
      data.signs = bctx.signs.arrays(true, true);
      addMesh(data.signs);
      data.signAtlas = bctx.atlas.canvas.transferToImageBitmap();
      transfer.push(data.signAtlas);
    }
    let circles: number[] = [];
    if (req.treeBudget > 0) {
      const t = buildTrees(vt, sizeM, req.treeBudget, seed, height, canopy, CN);
      mark('stromy');
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
    data.lamps = buildLamps(vt, sizeM, data.buildings, height);
    mark('ostatni');
    transfer.push(data.lamps.buffer);
    transfer.push(data.buildings.buffer);
    Object.assign(data, points(vt, s));
    for (const st of data.streets!) transfer.push(st.pts.buffer);
  } else if (vt) {
    data.places = points(vt, sizeM / EXTENT).places;
  }
  mark('konec');
  data.prof = prof;
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
