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
  nízká: { radius: 1, texSize: 512, trees: 600, farRadius: 1, shadows: false },
  střední: { radius: 2, texSize: 1024, trees: 1500, farRadius: 2, shadows: true },
  vysoká: { radius: 2, texSize: 1024, trees: 3200, farRadius: 3, shadows: true },
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
};

function addSnow(mat: THREE.MeshStandardMaterial, vegetation: boolean, key: string) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnowLine = envUniforms.uSnowLine;
    sh.uniforms.uSnowAmount = envUniforms.uSnowAmount;
    sh.uniforms.uSeasonTint = envUniforms.uSeasonTint;
    sh.uniforms.uWet = envUniforms.uWet;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;\nvarying float vUp;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWY = (modelMatrix * vec4(transformed, 1.0)).y;\nvUp = normalize(mat3(modelMatrix) * objectNormal).y;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vWY;\nvarying float vUp;\nuniform float uSnowLine;\nuniform float uSnowAmount;\nuniform float uWet;\nuniform vec3 uSeasonTint;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${vegetation ? 'diffuseColor.rgb *= uSeasonTint;' : ''}
float snowK = uSnowAmount * smoothstep(uSnowLine - 60.0, uSnowLine + 60.0, vWY) * smoothstep(0.55, 0.85, vUp);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), snowK);
diffuseColor.rgb *= 1.0 - uWet * 0.25;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, uWet * (1.0 - snowK));',
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
  const colorize = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      a[i * 3] = c.r;
      a[i * 3 + 1] = c.g;
      a[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const trunk = () => colorize(new THREE.CylinderGeometry(0.18, 0.28, 3, 5).translate(0, 1.5, 0), new THREE.Color(0.32, 0.23, 0.16));
  const conifer = mergeGeometries([
    trunk(),
    colorize(new THREE.ConeGeometry(2.4, 7, 7).translate(0, 5.5, 0), new THREE.Color(0.16, 0.3, 0.17)),
    colorize(new THREE.ConeGeometry(1.7, 5, 7).translate(0, 9, 0), new THREE.Color(0.18, 0.33, 0.18)),
  ].map((g) => g.toNonIndexed()))!;
  const crown = new THREE.IcosahedronGeometry(3, 0);
  const pos = crown.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * 0.85);
  const deciduous = mergeGeometries([
    trunk(),
    colorize(crown.translate(0, 5.6, 0), new THREE.Color(0.27, 0.42, 0.18)),
  ].map((g) => g.toNonIndexed()))!;
  conifer.computeVertexNormals();
  deciduous.computeVertexNormals();
  return [conifer, deciduous];
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
  };
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
      tree: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    };
    addSnow(this.mats.roofs, false, 'roof');
    addSnow(this.mats.tree, true, 'tree');
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
    const m = new THREE.MeshStandardMaterial({ map, roughness: 0.97, metalness: 0 });
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
      const byKind: number[][] = [[], []];
      for (let i = 0; i < count; i++) byKind[t[i * 5 + 4]].push(i);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      byKind.forEach((list, kind) => {
        if (!list.length) return;
        const im = new THREE.InstancedMesh(this.treeGeo[kind], this.mats.tree, list.length);
        list.forEach((i, k) => {
          const sc = t[i * 5 + 3];
          q.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
          s.set(sc, sc * (0.85 + ((i * 7) % 5) * 0.08), sc);
          p.set(t[i * 5], t[i * 5 + 1], t[i * 5 + 2]);
          im.setMatrixAt(k, m.compose(p, q, s));
        });
        im.castShadow = true;
        im.receiveShadow = false;
        im.computeBoundingSphere();
        im.name = 'trees';
        disposables.push({ dispose: () => im.dispose() });
        group.add(im);
      });
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
    this.far.set(key, { key, ox, oz, group, grid: { n: d.n, size: d.size, h: d.heights }, texture: d.texture, disposables });
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
    for (const t of this.near.values()) for (const s of t.places) out.push({ ...s, x: s.x + t.ox, z: s.z + t.oz });
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
