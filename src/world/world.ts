// Správce světa: rozhoduje, které dlaždice načíst kolem hráče, vytváří z dat meshe,
// odpovídá na dotazy na výšku terénu, kolize a silnice.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TILE_M, tileKey } from '../geo';
import { gridHeight, type HeightGrid } from './heightgrid';
import { RoadGraph } from './roadgraph';
import { facadeTextures, pathTexture, railTexture, roadTexture } from './textures';
import type { Colliders, MeshArrays, NamedPoint, PlacePoint, StreetLine, TileData, TileKind, TileRequest } from './types';
import TileWorker from './tileWorker?worker';

export interface Quality {
  radius: number;
  texSize: number;
  trees: number;
  farRadius: number;
  shadows: boolean;
}

export const QUALITY: Record<string, Quality> = {
  nízká: { radius: 1, texSize: 512, trees: 4500, farRadius: 1, shadows: false },
  střední: { radius: 2, texSize: 1024, trees: 8000, farRadius: 2, shadows: true },
  vysoká: { radius: 2, texSize: 1024, trees: 12000, farRadius: 3, shadows: true },
};

interface NearTile {
  key: string;
  x: number;
  y: number;
  ox: number;
  oz: number;
  group: THREE.Group;
  grid: HeightGrid;
  colliders?: Colliders;
  bridges?: Float32Array;
  stops: NamedPoint[];
  addresses: NamedPoint[];
  places: PlacePoint[];
  streets: StreetLine[];
  buildings?: Float32Array;
  texture: ImageBitmap | null;
  disposables: { dispose(): void }[];
}

interface FarTile {
  key: string;
  places: PlacePoint[];
  ox: number;
  oz: number;
  group: THREE.Group;
  grid: HeightGrid;
  texture: ImageBitmap | null;
  disposables: { dispose(): void }[];
}

/** Sdílené uniformy pro sníh a roční období. */
export const envUniforms = {
  uSnowLine: { value: 5000 },
  uSnowAmount: { value: 0 },
  uWet: { value: 0 },
  uSeasonTint: { value: new THREE.Color(1, 1, 1) },
  uOrigin: { value: new THREE.Vector2(0, 0) },
};

function addSnow(mat: THREE.MeshStandardMaterial, vegetation: boolean, key: string) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnowLine = envUniforms.uSnowLine;
    sh.uniforms.uSnowAmount = envUniforms.uSnowAmount;
    sh.uniforms.uSeasonTint = envUniforms.uSeasonTint;
    sh.uniforms.uWet = envUniforms.uWet;
    sh.uniforms.uOrigin = envUniforms.uOrigin;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;\nvarying float vUp;\nvarying vec2 vWXZ;\nuniform vec2 uOrigin;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvec4 wpS = modelMatrix * vec4(transformed, 1.0);\nvWY = wpS.y;\nvWXZ = wpS.xz + uOrigin;\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vWY;
varying float vUp;
varying vec2 vWXZ;
uniform float uSnowLine;
uniform float uSnowAmount;
uniform float uWet;
uniform vec3 uSeasonTint;
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1.0, 0.0)), f.x), mix(hsh(i + vec2(0.0, 1.0)), hsh(i + vec2(1.0, 1.0)), f.x), f.y);
}
float isWater = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${vegetation ? `
isWater = step(0.42, diffuseColor.b) * step(diffuseColor.r * 2.2, diffuseColor.b) * step(diffuseColor.g * 1.25, diffuseColor.b);
diffuseColor.rgb *= mix(uSeasonTint, vec3(1.0), isWater);
// Jemná struktura trávy a polí zblízka.
float dn = vnoise(vWXZ * 0.45) * 0.55 + vnoise(vWXZ * 0.09) * 0.45;
diffuseColor.rgb *= mix(0.9 + dn * 0.2, 1.0, isWater);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.75, 0.88, 1.0), isWater * 0.4);` : ''}
float snowK = uSnowAmount * smoothstep(uSnowLine - 60.0, uSnowLine + 60.0, vWY) * smoothstep(0.55, 0.85, vUp);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), snowK);
diffuseColor.rgb *= 1.0 - uWet * 0.25;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, uWet * (1.0 - snowK));\nroughnessFactor = mix(roughnessFactor, 0.12, isWater);',
      );
  };
  mat.customProgramCacheKey = () => `snow-${key}`;
}

function geometry(m: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  if (m.col) g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
  g.computeBoundingSphere();
  return g;
}

function gridIndex(n: number): THREE.BufferAttribute {
  const w = n + 1;
  const idx = new Uint32Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      // Stejná úhlopříčka b–c jako v heightgrid.ts, CCW při pohledu shora.
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  return new THREE.BufferAttribute(idx, 1);
}

function treeGeometries(): THREE.BufferGeometry[] {
  const colorize = (g: THREE.BufferGeometry, c: number[]) => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const W = [1, 1, 1];
  // Koruny: dole tmavší, nahoře světlejší.
  const shade = (g: THREE.BufferGeometry, y0: number, y1: number) => {
    const p = g.getAttribute('position');
    const c = g.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      const k = 0.62 + 0.5 * Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0)));
      c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
    }
    return g;
  };
  const trunk = (h: number, r: number) => colorize(new THREE.CylinderGeometry(r * 0.7, r, h, 5).translate(0, h / 2, 0), [0.32, 0.22, 0.15]);
  const merge = (gs: THREE.BufferGeometry[]) => {
    const m = mergeGeometries(gs.map((g) => (g.index ? g.toNonIndexed() : g)))!;
    m.computeVertexNormals();
    return m;
  };
  const conifer = merge([
    trunk(2.2, 0.16),
    shade(colorize(new THREE.ConeGeometry(2.3, 5.2, 6).translate(0, 4.2, 0), W), 1.6, 9.9),
    shade(colorize(new THREE.ConeGeometry(1.6, 4.6, 6).translate(0, 7.6, 0), W), 1.6, 9.9),
  ]);
  const crown = new THREE.IcosahedronGeometry(2.9, 0);
  crown.scale(1, 0.9, 1);
  const deciduous = merge([trunk(3.2, 0.17), shade(colorize(crown.translate(0, 5.6, 0), W), 3.2, 8.2)]);
  const bush = merge([shade(colorize(new THREE.IcosahedronGeometry(1.0, 0).scale(1.2, 0.8, 1.2).translate(0, 0.6, 0), W), -0.2, 1.4)]);
  return [conifer, deciduous, bush];
}

/** Barva koruny podle druhu, náhody a ročního období. */
export function treeColor(kind: number, r: number, season: string, out: THREE.Color): THREE.Color {
  const pick = (list: string[]) => out.set(list[Math.floor(r * list.length) % list.length]);
  if (kind === 0) pick(season === 'zima' ? ['#2d4a3a', '#34503c', '#2a4436'] : ['#2f5a3c', '#3a6a42', '#2c5236', '#41704a', '#356240']);
  else if (season === 'podzim') pick(['#d9772a', '#c4462c', '#e2b23a', '#a8572a', '#8c9a3a', '#e08f2f', '#b8352a', '#c9a03a']);
  else if (season === 'zima') pick(['#7a6a5a', '#6e6052', '#857565']);
  else if (season === 'jaro') pick(['#7fb24a', '#93c25a', '#6fa444', '#f0d6e0', '#a6cc66']);
  else pick(kind === 2 ? ['#557d36', '#4d7432', '#62893c'] : ['#5e8f3a', '#6f9c40', '#527f34', '#7aa648', '#4f7a30']);
  return out;
}

function lampGeometry(): THREE.BufferGeometry {
  const col = (g: THREE.BufferGeometry, c: number[]) => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g.index ? g.toNonIndexed() : g;
  };
  const g = mergeGeometries([
    col(new THREE.CylinderGeometry(0.07, 0.1, 5, 5).translate(0, 2.5, 0), [0.18, 0.2, 0.22]),
    col(new THREE.BoxGeometry(0.35, 0.18, 0.35).translate(0, 5.05, 0), [1, 0.92, 0.7]),
  ])!;
  g.computeVertexNormals();
  return g;
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,240,200,1)');
  gr.addColorStop(0.25, 'rgba(255,215,140,0.55)');
  gr.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class World {
  readonly root = new THREE.Group();
  origin = { x: 0, z: 0 };
  near = new Map<string, NearTile>();
  far = new Map<string, FarTile>();
  pending = new Map<string, number>();
  graph = new RoadGraph();
  tileUrl = '';
  quality: Quality = QUALITY['střední'];
  onTileLoaded: ((key: string) => void) | null = null;
  stats = { nearLoaded: 0, farLoaded: 0, pending: 0, errors: 0 };

  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private queue: TileRequest[] = [];
  private reqId = 1;
  private reqs = new Map<number, TileRequest>();
  private nearIndex: Record<number, THREE.BufferAttribute> = {};
  private center = { x: 0, z: 0 };

  readonly mats: {
    walls: THREE.MeshStandardMaterial;
    roofs: THREE.MeshStandardMaterial;
    marked: THREE.MeshStandardMaterial;
    plain: THREE.MeshStandardMaterial;
    path: THREE.MeshStandardMaterial;
    rail: THREE.MeshStandardMaterial;
    bridge: THREE.MeshStandardMaterial;
    tree: THREE.MeshStandardMaterial;
    lamp: THREE.MeshStandardMaterial;
    glow: THREE.PointsMaterial;
  };
  season = 'léto';
  private lampGeo = lampGeometry();
  private treeMeshes = new Set<THREE.InstancedMesh>();
  private treeGeo = treeGeometries();

  constructor(private renderer: THREE.WebGLRenderer) {
    const f = facadeTextures();
    const roadMat = (map: THREE.Texture, key: string, offset: number) => {
      const m = new THREE.MeshStandardMaterial({
        map, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -offset, polygonOffsetUnits: -offset * 2,
      });
      addSnow(m, false, key);
      return m;
    };
    this.mats = {
      walls: new THREE.MeshStandardMaterial({
        vertexColors: true, map: f.map, emissiveMap: f.emissive, emissive: new THREE.Color(1, 0.85, 0.6),
        emissiveIntensity: 0, roughness: 0.85, side: THREE.DoubleSide,
      }),
      roofs: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }),
      marked: roadMat(roadTexture(true), 'road1', 3),
      plain: roadMat(roadTexture(false), 'road2', 2),
      path: roadMat(pathTexture(), 'path', 1),
      rail: roadMat(railTexture(), 'rail', 1),
      bridge: new THREE.MeshStandardMaterial({ color: 0x9a9893, roughness: 0.9, side: THREE.DoubleSide }),
      tree: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
      lamp: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: new THREE.Color(1, 0.85, 0.5), emissiveIntensity: 0 }),
      glow: new THREE.PointsMaterial({
        map: glowTexture(), size: 9, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }),
    };
    addSnow(this.mats.roofs, false, 'roof');
    addSnow(this.mats.tree, false, 'tree');
    const n = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new TileWorker();
      w.onmessage = (e: MessageEvent<TileData>) => this.onTile(i, e.data);
      w.onerror = (e) => {
        console.error('worker', e);
        this.busy[i] = false;
        this.pump();
      };
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  async init() {
    const r = await fetch('https://tiles.openfreemap.org/planet');
    const j = await r.json();
    this.tileUrl = j.tiles[0];
  }

  setQuality(q: Quality) {
    this.quality = q;
    for (const k of [...this.near.keys()]) this.unloadNear(k);
    for (const k of [...this.far.keys()]) this.unloadFar(k);
    this.queue = [];
    this.pending.clear();
  }

  // ------------------------------------------------------------ souřadnice

  toScene(x: number, z: number, out = new THREE.Vector3(), y = 0): THREE.Vector3 {
    return out.set(x - this.origin.x, y, z - this.origin.z);
  }

  /** Přesune počátek scény k hráči, aby se zachovala přesnost float32 ve shaderech. */
  rebase(x: number, z: number): boolean {
    if (Math.hypot(x - this.origin.x, z - this.origin.z) < 2000) return false;
    this.origin = { x: Math.round(x), z: Math.round(z) };
    envUniforms.uOrigin.value.set(this.origin.x % 8192, this.origin.z % 8192);
    for (const t of this.near.values()) t.group.position.set(t.ox - this.origin.x, 0, t.oz - this.origin.z);
    for (const t of this.far.values()) t.group.position.set(t.ox - this.origin.x, -3, t.oz - this.origin.z);
    return true;
  }

  // ------------------------------------------------------------ streamování

  update(px: number, pz: number) {
    if (!this.tileUrl) return;
    this.center = { x: px, z: pz };
    const R = this.quality.radius;
    const tx = Math.floor(px / TILE_M);
    const ty = Math.floor(pz / TILE_M);
    const want = new Set<string>();
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (Math.hypot(dx, dy) > R + 0.5) continue;
        const k = tileKey(14, tx + dx, ty + dy);
        want.add(k);
        if (!this.near.has(k) && !this.pending.has(k)) this.request('near', 14, tx + dx, ty + dy);
      }
    }
    for (const k of [...this.near.keys()]) {
      const t = this.near.get(k)!;
      if (Math.max(Math.abs(t.x - tx), Math.abs(t.y - ty)) > R + 1) this.unloadNear(k);
    }
    const F = this.quality.farRadius;
    const fx = Math.floor(px / (TILE_M * 4));
    const fy = Math.floor(pz / (TILE_M * 4));
    for (let dy = -F; dy <= F; dy++) {
      for (let dx = -F; dx <= F; dx++) {
        const k = tileKey(12, fx + dx, fy + dy);
        if (!this.far.has(k) && !this.pending.has(k)) this.request('far', 12, fx + dx, fy + dy);
      }
    }
    for (const k of [...this.far.keys()]) {
      const [, x, y] = k.split('/').map(Number);
      if (Math.max(Math.abs(x - fx), Math.abs(y - fy)) > F + 1) this.unloadFar(k);
    }
    // Zahodit požadavky, které už nejsou potřeba.
    this.queue = this.queue.filter((r) => {
      const k = tileKey(r.z, r.x, r.y);
      const keep = r.kind === 'far'
        ? Math.max(Math.abs(r.x - fx), Math.abs(r.y - fy)) <= F + 1
        : Math.max(Math.abs(r.x - tx), Math.abs(r.y - ty)) <= R + 1;
      if (!keep) this.pending.delete(k);
      return keep;
    });
    this.sortQueue();
    this.stats.pending = this.pending.size;
    this.pump();
  }

  private sortQueue() {
    const d = (r: TileRequest) => {
      const s = TILE_M * 2 ** (14 - r.z);
      const cx = (r.x + 0.5) * s;
      const cz = (r.y + 0.5) * s;
      // Blízké dlaždice mají přednost, vzdálený terén se dotahuje průběžně.
      return Math.hypot(cx - this.center.x, cz - this.center.z) / (r.kind === 'near' ? 1 : 2.5);
    };
    this.queue.sort((a, b) => d(a) - d(b));
  }

  private request(kind: TileKind, z: number, x: number, y: number) {
    const id = this.reqId++;
    const req: TileRequest = {
      id, kind, z, x, y, tileUrl: this.tileUrl,
      texSize: kind === 'near' ? this.quality.texSize : 512,
      treeBudget: kind === 'near' ? this.quality.trees : 0,
    };
    // Vzdálené dlaždice z12 berou vektorová data ze z12.
    this.pending.set(tileKey(z, x, y), id);
    this.queue.push(req);
  }

  private pump() {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i] || !this.queue.length) continue;
      const r = this.queue.shift()!;
      this.busy[i] = true;
      this.reqs.set(r.id, r);
      this.workers[i].postMessage(r);
    }
  }

  private onTile(worker: number, d: TileData) {
    this.busy[worker] = false;
    this.reqs.delete(d.id);
    const key = tileKey(d.z, d.x, d.y);
    if (this.pending.get(key) !== d.id) {
      // Mezitím zrušeno.
      d.texture?.close();
      this.pump();
      return;
    }
    this.pending.delete(key);
    if (d.error) {
      this.stats.errors++;
      console.warn('Dlaždice selhala', key, d.error);
      this.pump();
      return;
    }
    if (d.kind === 'near') this.addNear(key, d);
    else this.addFar(key, d);
    this.stats.pending = this.pending.size;
    this.pump();
    this.onTileLoaded?.(key);
  }

  private terrainMaterial(tex: ImageBitmap | null, key: string, far: boolean): THREE.MeshStandardMaterial {
    let map: THREE.Texture | null = null;
    if (tex) {
      map = new THREE.Texture(tex);
      map.flipY = false;
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      map.generateMipmaps = true;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.needsUpdate = true;
    }
    const m = new THREE.MeshStandardMaterial({ map, roughness: 0.97, metalness: 0, flatShading: true });
    addSnow(m, true, far ? 'far' : 'terrain');
    void key;
    return m;
  }

  private addNear(key: string, d: TileData) {
    const ox = d.x * TILE_M;
    const oz = d.y * TILE_M;
    const group = new THREE.Group();
    group.position.set(ox - this.origin.x, 0, oz - this.origin.z);
    const disposables: { dispose(): void }[] = [];
    const tg = geometry(d.terrain);
    tg.setIndex(this.nearIndex[d.n] ??= gridIndex(d.n));
    const tm = this.terrainMaterial(d.texture, key, false);
    disposables.push(tg, tm);
    if (tm.map) disposables.push(tm.map);
    const terrain = new THREE.Mesh(tg, tm);
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    group.add(terrain);
    const add = (m: MeshArrays | undefined, mat: THREE.Material, cast: boolean, recv: boolean, name: string) => {
      if (!m) return;
      const g = geometry(m);
      disposables.push(g);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
      mesh.name = name;
      group.add(mesh);
    };
    add(d.walls, this.mats.walls, true, true, 'walls');
    add(d.roofs, this.mats.roofs, true, true, 'roofs');
    add(d.roadsMarked, this.mats.marked, false, true, 'roads');
    add(d.roadsPlain, this.mats.plain, false, true, 'roads');
    add(d.paths, this.mats.path, false, true, 'paths');
    add(d.rails, this.mats.rail, false, true, 'rails');
    add(d.bridgeSides, this.mats.bridge, true, true, 'bridges');
    if (d.trees && d.trees.length) {
      const t = d.trees;
      const count = t.length / 5;
      const byKind: number[][] = [[], [], []];
      for (let i = 0; i < count; i++) byKind[t[i * 5 + 4]]?.push(i);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc3 = new THREE.Vector3();
      const p = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const color = new THREE.Color();
      byKind.forEach((list, kind) => {
        if (!list.length) return;
        const im = new THREE.InstancedMesh(this.treeGeo[kind], this.mats.tree, list.length);
        const rnds = new Float32Array(list.length);
        list.forEach((i, k) => {
          const sc = t[i * 5 + 3];
          const r = ((i * 2654435761) % 1000) / 1000;
          rnds[k] = r;
          q.setFromAxisAngle(up, r * Math.PI * 2);
          sc3.set(sc, sc * (0.85 + r * 0.35), sc);
          p.set(t[i * 5], t[i * 5 + 1], t[i * 5 + 2]);
          im.setMatrixAt(k, m.compose(p, q, sc3));
          im.setColorAt(k, treeColor(kind, r, this.season, color));
        });
        im.userData = { kind, rnds };
        im.castShadow = kind !== 2;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        im.name = 'trees';
        this.treeMeshes.add(im);
        disposables.push({ dispose: () => { im.dispose(); this.treeMeshes.delete(im); } });
        group.add(im);
      });
    }
    if (d.lamps && d.lamps.length) {
      const l = d.lamps;
      const n = l.length / 3;
      const im = new THREE.InstancedMesh(this.lampGeo, this.mats.lamp, n);
      const m = new THREE.Matrix4();
      const gp = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        im.setMatrixAt(i, m.makeTranslation(l[i * 3], l[i * 3 + 1], l[i * 3 + 2]));
        gp.set([l[i * 3], l[i * 3 + 1] + 5.0, l[i * 3 + 2]], i * 3);
      }
      im.computeBoundingSphere();
      im.castShadow = false;
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(gp, 3));
      gg.computeBoundingSphere();
      const pts = new THREE.Points(gg, this.mats.glow);
      pts.name = 'glow';
      group.add(im, pts);
      disposables.push({ dispose: () => im.dispose() }, gg);
    }
    this.root.add(group);
    const tile: NearTile = {
      key, x: d.x, y: d.y, ox, oz, group, grid: { n: d.n, size: d.size, h: d.heights },
      colliders: d.colliders, bridges: d.bridges, stops: d.stops ?? [], addresses: d.addresses ?? [],
      places: d.places ?? [], streets: d.streets ?? [], buildings: d.buildings, texture: d.texture, disposables,
    };
    this.near.set(key, tile);
    if (d.roadLines) this.graph.addTile(key, ox, oz, d.size, d.roadLines);
    this.stats.nearLoaded = this.near.size;
  }

  private addFar(key: string, d: TileData) {
    const ox = d.x * d.size;
    const oz = d.y * d.size;
    const group = new THREE.Group();
    // O kousek níž, aby detailní terén vždy vyhrál.
    group.position.set(ox - this.origin.x, -3, oz - this.origin.z);
    const tg = geometry(d.terrain);
    tg.setIndex(this.nearIndex[d.n] ??= gridIndex(d.n));
    const tm = this.terrainMaterial(d.texture, key, true);
    const mesh = new THREE.Mesh(tg, tm);
    mesh.receiveShadow = false;
    mesh.name = 'far';
    group.add(mesh);
    this.root.add(group);
    const disposables: { dispose(): void }[] = [tg, tm];
    if (tm.map) disposables.push(tm.map);
    this.far.set(key, { key, places: d.places ?? [], ox, oz, group, grid: { n: d.n, size: d.size, h: d.heights }, texture: d.texture, disposables });
    this.stats.farLoaded = this.far.size;
  }

  private unloadNear(k: string) {
    const t = this.near.get(k);
    if (!t) return;
    this.root.remove(t.group);
    for (const d of t.disposables) d.dispose();
    t.texture?.close();
    this.graph.removeTile(k);
    this.near.delete(k);
    this.stats.nearLoaded = this.near.size;
  }

  private unloadFar(k: string) {
    const t = this.far.get(k);
    if (!t) return;
    this.root.remove(t.group);
    for (const d of t.disposables) d.dispose();
    t.texture?.close();
    this.far.delete(k);
  }

  setSeason(season: string) {
    if (season === this.season) return;
    this.season = season;
    const c = new THREE.Color();
    for (const im of this.treeMeshes) {
      const { kind, rnds } = im.userData as { kind: number; rnds: Float32Array };
      for (let k = 0; k < rnds.length; k++) im.setColorAt(k, treeColor(kind, rnds[k], season, c));
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ dotazy

  tileAt(x: number, z: number): NearTile | undefined {
    return this.near.get(tileKey(14, Math.floor(x / TILE_M), Math.floor(z / TILE_M)));
  }

  isReady(x: number, z: number): boolean {
    return !!this.tileAt(x, z);
  }

  /** Výška terénu (bez mostů). */
  terrainHeight(x: number, z: number): number {
    const t = this.tileAt(x, z);
    if (t) {
      const h = gridHeight(t.grid, x - t.ox, z - t.oz);
      if (!Number.isNaN(h)) return h;
    }
    const s = TILE_M * 4;
    const f = this.far.get(tileKey(12, Math.floor(x / s), Math.floor(z / s)));
    if (f) {
      const h = gridHeight(f.grid, x - f.ox, z - f.oz);
      if (!Number.isNaN(h)) return h - 3;
    }
    return NaN;
  }

  /** Výška povrchu, po kterém se jede: terén nebo mostovka (pokud je blízko nad/pod yHint). */
  groundHeight(x: number, z: number, yHint: number): number {
    let h = this.terrainHeight(x, z);
    const t = this.tileAt(x, z);
    if (t?.bridges && t.bridges.length) {
      const b = t.bridges;
      const lx = x - t.ox, lz = z - t.oz;
      for (let i = 0; i < b.length; i += 7) {
        const ax = b[i], az = b[i + 1], ay = b[i + 2], bx = b[i + 3], bz = b[i + 4], by = b[i + 5], hw = b[i + 6];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const s = ((lx - ax) * dx + (lz - az) * dz) / l2;
        if (s < -0.05 || s > 1.05) continue;
        const sc = Math.max(0, Math.min(1, s));
        const d = Math.hypot(ax + dx * sc - lx, az + dz * sc - lz);
        if (d > hw) continue;
        const y = ay + (by - ay) * sc;
        if (y > h && y < yHint + 2.5) h = y;
      }
    }
    return h;
  }

  /**
   * Kolize kruhu s budovami a stromy. Vrací vektor vytlačení a normálu nejhlubšího kontaktu.
   */
  collide(x: number, z: number, r: number): { px: number; pz: number; nx: number; nz: number; depth: number } | null {
    const t = this.tileAt(x, z);
    if (!t?.colliders) return null;
    const c = t.colliders;
    const cs = t.grid.size / c.cells;
    const lx = x - t.ox;
    const lz = z - t.oz;
    let px = 0;
    let pz = 0;
    let best = 0;
    let bnx = 0;
    let bnz = 0;
    const i0 = Math.max(0, Math.floor((lx - r) / cs)), i1 = Math.min(c.cells - 1, Math.floor((lx + r) / cs));
    const j0 = Math.max(0, Math.floor((lz - r) / cs)), j1 = Math.min(c.cells - 1, Math.floor((lz + r) / cs));
    const seen = new Set<number>();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * c.cells + i;
        for (let k = c.cellStart[cell]; k < c.cellStart[cell + 1]; k++) {
          const it = c.cellItems[k];
          if (seen.has(it)) continue;
          seen.add(it);
          let cx: number;
          let cz: number;
          let rr = r;
          if (it >= 0) {
            const e = c.edges;
            const ax = e[it * 4], az = e[it * 4 + 1], bx = e[it * 4 + 2], bz = e[it * 4 + 3];
            const dx = bx - ax, dz = bz - az;
            const l2 = dx * dx + dz * dz || 1;
            const s = Math.max(0, Math.min(1, ((lx - ax) * dx + (lz - az) * dz) / l2));
            cx = ax + dx * s;
            cz = az + dz * s;
          } else {
            const ci = -1 - it;
            cx = c.circles[ci * 3];
            cz = c.circles[ci * 3 + 1];
            rr = r + c.circles[ci * 3 + 2];
          }
          const ddx = lx - cx, ddz = lz - cz;
          const d = Math.hypot(ddx, ddz);
          if (d >= rr) continue;
          const depth = rr - d;
          const nx = d > 1e-4 ? ddx / d : 1;
          const nz = d > 1e-4 ? ddz / d : 0;
          px += nx * depth;
          pz += nz * depth;
          if (depth > best) {
            best = depth;
            bnx = nx;
            bnz = nz;
          }
        }
      }
    }
    if (best === 0) return null;
    // Omezit součet, aby rohy nevystřelovaly.
    const pl = Math.hypot(px, pz);
    if (pl > best * 1.5) {
      px = (px / pl) * best * 1.5;
      pz = (pz / pl) * best * 1.5;
    }
    return { px, pz, nx: bnx, nz: bnz, depth: best };
  }

  /** První průsečík úsečky se zdí budovy (0..1), nebo 1, když je volno. */
  segmentHit(ax: number, az: number, bx: number, bz: number): number {
    const t = this.tileAt(ax, az);
    if (!t?.colliders) return 1;
    const c = t.colliders;
    const cs = t.grid.size / c.cells;
    const x0 = ax - t.ox, z0 = az - t.oz, x1 = bx - t.ox, z1 = bz - t.oz;
    const i0 = Math.max(0, Math.floor(Math.min(x0, x1) / cs)), i1 = Math.min(c.cells - 1, Math.floor(Math.max(x0, x1) / cs));
    const j0 = Math.max(0, Math.floor(Math.min(z0, z1) / cs)), j1 = Math.min(c.cells - 1, Math.floor(Math.max(z0, z1) / cs));
    let best = 1;
    const dx = x1 - x0, dz = z1 - z0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * c.cells + i;
        for (let k = c.cellStart[cell]; k < c.cellStart[cell + 1]; k++) {
          const it = c.cellItems[k];
          if (it < 0) continue;
          const e = c.edges;
          const ex = e[it * 4 + 2] - e[it * 4], ez = e[it * 4 + 3] - e[it * 4 + 1];
          const den = dx * ez - dz * ex;
          if (Math.abs(den) < 1e-9) continue;
          const wx = e[it * 4] - x0, wz = e[it * 4 + 1] - z0;
          const ta = (wx * ez - wz * ex) / den;
          const tb = (wx * dz - wz * dx) / den;
          if (ta >= 0 && ta < best && tb >= 0 && tb <= 1) best = ta;
        }
      }
    }
    return best;
  }

  /** Všechny zastávky v načtených dlaždicích (světové souřadnice). */
  allStops(): NamedPoint[] {
    const out: NamedPoint[] = [];
    for (const t of this.near.values()) for (const s of t.stops) out.push({ name: s.name, x: s.x + t.ox, z: s.z + t.oz });
    return out;
  }

  allAddresses(): NamedPoint[] {
    const out: NamedPoint[] = [];
    for (const t of this.near.values()) for (const s of t.addresses) out.push({ name: s.name, x: s.x + t.ox, z: s.z + t.oz });
    return out;
  }

  allPlaces(): PlacePoint[] {
    const out: PlacePoint[] = [];
    const seen = new Set<string>();
    const add = (s: PlacePoint, ox: number, oz: number) => {
      const x = s.x + ox, z = s.z + oz;
      const k = `${s.name}|${Math.round(x / 300)}|${Math.round(z / 300)}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ ...s, x, z });
    };
    for (const t of this.near.values()) for (const s of t.places) add(s, t.ox, t.oz);
    for (const t of this.far.values()) for (const s of t.places) add(s, t.ox, t.oz);
    return out;
  }

  /** Nejbližší pojmenovaná ulice k bodu. */
  streetName(x: number, z: number): string | null {
    const t = this.tileAt(x, z);
    if (!t) return null;
    const lx = x - t.ox, lz = z - t.oz;
    let best: string | null = null;
    let bd = 60;
    for (const s of t.streets) {
      const p = s.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((lx - ax) * dx + (lz - az) * dz) / l2));
        const d = Math.hypot(ax + dx * u - lx, az + dz * u - lz);
        if (d < bd) {
          bd = d;
          best = s.name;
        }
      }
    }
    return best;
  }

  /** Obestavěný prostor budov v okruhu – odhad poptávky u zastávky. */
  buildingVolume(x: number, z: number, r: number): number {
    let v = 0;
    for (const t of this.near.values()) {
      const b = t.buildings;
      if (!b) continue;
      if (x + r < t.ox || x - r > t.ox + TILE_M || z + r < t.oz || z - r > t.oz + TILE_M) continue;
      for (let i = 0; i < b.length; i += 3) {
        if (Math.hypot(b[i] + t.ox - x, b[i + 1] + t.oz - z) < r) v += b[i + 2];
      }
    }
    return v;
  }

  /** Textury dlaždic pro minimapu. */
  minimapTiles(): { ox: number; oz: number; size: number; img: ImageBitmap }[] {
    const out: { ox: number; oz: number; size: number; img: ImageBitmap }[] = [];
    for (const t of this.far.values()) if (t.texture) out.push({ ox: t.ox, oz: t.oz, size: t.grid.size, img: t.texture });
    for (const t of this.near.values()) if (t.texture) out.push({ ox: t.ox, oz: t.oz, size: t.grid.size, img: t.texture });
    return out;
  }
}
