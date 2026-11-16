// Trsy trávy v okolí hráče. Rozmisťují se podle barvy povrchu dlaždice (jen zelené plochy),
// generují se znovu, když se hráč posune, a vlní se ve větru.

import * as THREE from 'three';
import { TILE_M, tileKey } from '../geo';
import type { World } from './world';

const RADIUS = 70;
const STEP = 1.1;

function bladeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  for (let i = 0; i < 14; i++) {
    const x = 6 + Math.random() * 52;
    const h = 28 + Math.random() * 34;
    const lean = (Math.random() - 0.5) * 16;
    const g = 150 + Math.random() * 80;
    ctx.fillStyle = `rgb(${g * 0.75},${g},${g * 0.55})`;
    ctx.beginPath();
    ctx.moveTo(x - 2.2, 64);
    ctx.quadraticCurveTo(x + lean * 0.3, 64 - h * 0.6, x + lean, 64 - h);
    ctx.quadraticCurveTo(x + lean * 0.3 + 1, 64 - h * 0.6, x + 2.2, 64);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function clumpGeometry(): THREE.BufferGeometry {
  // Dva zkřížené čtverce.
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  for (const a of [0, Math.PI / 2]) {
    const cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
    const quad = [
      [-cx, 0, -cz, 0, 0], [cx, 0, cz, 1, 0], [cx, 0.42, cz, 1, 1],
      [-cx, 0, -cz, 0, 0], [cx, 0.42, cz, 1, 1], [-cx, 0.42, -cz, 0, 1],
    ];
    for (const [x, y, z, u, v] of quad) {
      pos.push(x, y, z);
      uv.push(u, v);
      nor.push(0, 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

export class Grass {
  readonly mesh: THREE.InstancedMesh;
  private pixels = new Map<string, { data: Uint8ClampedArray; size: number }>();
  private center: { x: number; z: number } | null = null;
  private anchor = { x: 0, z: 0 };
  private uTime = { value: 0 };
  enabled = true;
  season = 'léto';

  constructor(private world: World, max = 14000) {
    const mat = new THREE.MeshStandardMaterial({
      map: bladeTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
// Vítr: houpání špiček podle polohy instance.
vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
float sway = sin(uTime * 1.7 + ip.x * 0.35 + ip.z * 0.27) * 0.08 + sin(uTime * 3.1 + ip.x) * 0.03;
transformed.x += sway * position.y;
transformed.z += sway * 0.6 * position.y;`,
        );
      // Osvětlení jako louka: normála vždy nahoru (obě strany stébel stejně světlé).
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);',
      );
    };
    mat.customProgramCacheKey = () => 'grass';
    this.mesh = new THREE.InstancedMesh(clumpGeometry(), mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  }

  /** Pixely textury povrchu dlaždice (z ImageBitmap; jednou za dlaždici). */
  private tilePixels(tx: number, ty: number) {
    const k = tileKey(14, tx, ty);
    const hit = this.pixels.get(k);
    if (hit) return hit;
    const t = this.world.near.get(k);
    if (!t?.texture) return null;
    const size = Math.min(256, t.texture.width);
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(t.texture, 0, 0, size, size);
    const res = { data: ctx.getImageData(0, 0, size, size).data, size };
    this.pixels.set(k, res);
    while (this.pixels.size > 12) this.pixels.delete(this.pixels.keys().next().value!);
    return res;
  }

  update(dt: number, px: number, pz: number, season: string) {
    this.uTime.value += dt;
    const winter = season === 'zima';
    this.mesh.visible = this.enabled && !winter;
    if (!this.mesh.visible) return;
    if (this.center && Math.hypot(px - this.center.x, pz - this.center.z) < 20 && season === this.season) {
      this.place();
      return;
    }
    if (!this.world.isReady(px, pz)) return;
    this.center = { x: px, z: pz };
    this.anchor = { x: Math.round(px), z: Math.round(pz) };
    this.season = season;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const tint = season === 'podzim' ? [1.15, 0.95, 0.65] : season === 'jaro' ? [0.95, 1.08, 0.9] : [1, 1, 1];
    let n = 0;
    const max = this.mesh.instanceMatrix.count;
    const gx0 = Math.floor((px - RADIUS) / STEP), gx1 = Math.ceil((px + RADIUS) / STEP);
    const gz0 = Math.floor((pz - RADIUS) / STEP), gz1 = Math.ceil((pz + RADIUS) / STEP);
    for (let gz = gz0; gz <= gz1 && n < max; gz++) {
      for (let gx = gx0; gx <= gx1 && n < max; gx++) {
        // Deterministický rozptyl v mřížce (stejné trsy při návratu).
        const hsh = Math.sin(gx * 12.9898 + gz * 78.233) * 43758.5453;
        const r1 = hsh - Math.floor(hsh);
        const r2 = (r1 * 7.13) % 1;
        const x = (gx + r1) * STEP, z = (gz + r2) * STEP;
        const d = Math.hypot(x - px, z - pz);
        if (d > RADIUS) continue;
        const tx = Math.floor(x / TILE_M), ty = Math.floor(z / TILE_M);
        const pix = this.tilePixels(tx, ty);
        if (!pix) continue;
        const u = Math.min(pix.size - 1, Math.floor(((x - tx * TILE_M) / TILE_M) * pix.size));
        const v = Math.min(pix.size - 1, Math.floor(((z - ty * TILE_M) / TILE_M) * pix.size));
        const i = (v * pix.size + u) * 4;
        const R = pix.data[i], G = pix.data[i + 1], B = pix.data[i + 2];
        // Jen zelené plochy (louky, parky, zahrady), ne silnice, voda ani dlažba.
        if (!(G > R + 8 && G > B + 25)) continue;
        const y = this.world.terrainHeight(x, z);
        if (Number.isNaN(y)) continue;
        const s = 0.6 + r1 * 0.6;
        // Na okraji oblasti menší, aby hranice nebyla vidět.
        const fade = Math.min(1, (RADIUS - d) / 15);
        q.setFromAxisAngle(up, r2 * Math.PI * 2);
        sc.set(s * 1.3, s * (0.8 + r2 * 0.6) * fade, s * 1.3);
        p.set(x - this.anchor.x, y - 0.05, z - this.anchor.z);
        this.mesh.setMatrixAt(n, m.compose(p, q, sc));
        col.setRGB((R / 255) * 0.98 * tint[0], (G / 255) * 1.02 * tint[1], (B / 255) * 0.92 * tint[2]).convertSRGBToLinear();
        this.mesh.setColorAt(n, col);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.place();
  }

  /** Instance jsou ve světových souřadnicích; mesh posuneme o počátek scény. */
  private place() {
    this.mesh.position.set(this.anchor.x - this.world.origin.x, 0, this.anchor.z - this.world.origin.z);
  }
}
