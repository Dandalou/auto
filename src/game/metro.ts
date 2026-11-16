// Tunel metra podél skutečné trasy linky (osy z OSM, stanice z PID GTFS).
// Hloubka se odvozuje z terénu (ČÚZK) a vyhlazuje, ve stanicích se tunel rozšiřuje
// na halu s nástupištěm, světly a cedulemi s názvem stanice.

import * as THREE from 'three';
import type { World } from '../world/world';

const DEPTH = 22;
const STEP = 4;
const HW = 3.0; // polovina šířky traťového tunelu
const HW_ST = 9; // polovina šířky stanice
const HEIGHT = 5.6;
const ST_LEN = 70; // polovina délky stanice

export interface MetroStop {
  name: string;
  x: number;
  z: number;
}

export class MetroTunnel {
  readonly group = new THREE.Group();
  /** Převzorkovaná trasa: x, z, y (úroveň kolejí), kumulativní délka. */
  pts: { x: number; z: number; y: number; s: number }[] = [];
  private anchor: { x: number; z: number };

  constructor(private world: World, path: [number, number][], stops: MetroStop[]) {
    // Převzorkování po 4 m.
    const raw: [number, number][] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const [ax, az] = path[i - 1];
      const [bx, bz] = path[i];
      const l = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(l / STEP));
      for (let k = 1; k <= n; k++) raw.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    // Hloubka pod terénem, silně vyhlazená (koleje nesmí kopírovat kopečky).
    const ground = raw.map(([x, z]) => {
      const h = world.terrainHeight(x, z);
      return Number.isNaN(h) ? 0 : h;
    });
    const W = 40;
    let s = 0;
    for (let i = 0; i < raw.length; i++) {
      let acc = 0;
      let c = 0;
      for (let k = Math.max(0, i - W); k <= Math.min(raw.length - 1, i + W); k++) {
        acc += ground[k];
        c++;
      }
      if (i > 0) s += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
      this.pts.push({ x: raw[i][0], z: raw[i][1], y: acc / c - DEPTH, s });
    }
    this.anchor = { x: Math.round(raw[0][0]), z: Math.round(raw[0][1]) };
    // Polohy stanic podél trasy.
    const stationS = stops.map((st) => {
      let best = 0;
      let bd = Infinity;
      for (const p of this.pts) {
        const d = Math.hypot(p.x - st.x, p.z - st.z);
        if (d < bd) {
          bd = d;
          best = p.s;
        }
      }
      return { name: st.name, s: best };
    });
    this.build(stationS);
  }

  /** Úroveň kolejí v daném místě trasy (podle vzdálenosti s). */
  yAtS(s: number): number {
    const p = this.pts;
    if (s <= 0) return p[0].y;
    if (s >= p[p.length - 1].s) return p[p.length - 1].y;
    const i = Math.min(p.length - 2, Math.floor(s / STEP));
    let k = Math.max(0, i - 2);
    while (k < p.length - 2 && p[k + 1].s < s) k++;
    const t = (s - p[k].s) / (p[k + 1].s - p[k].s || 1);
    return p[k].y + (p[k + 1].y - p[k].y) * t;
  }

  /** Výška nástupiště u bodu (pro cestující). */
  platformY(x: number, z: number): number {
    let bd = Infinity;
    let y = 0;
    for (let i = 0; i < this.pts.length; i += 3) {
      const p = this.pts[i];
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        y = p.y;
      }
    }
    return y + 1.1;
  }

  update() {
    this.group.position.set(this.anchor.x - this.world.origin.x, 0, this.anchor.z - this.world.origin.z);
  }

  private build(stations: { name: string; s: number }[]) {
    const ax = this.anchor.x, az = this.anchor.z;
    const pos: number[] = [];
    const col: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], ca: number[], cb: number[] = ca) => {
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      col.push(...ca, ...ca, ...cb, ...ca, ...cb, ...cb);
    };
    const stAt = (s: number) => stations.find((st) => Math.abs(st.s - s) < ST_LEN);
    const P = this.pts;
    // Normály trasy.
    const side = P.map((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      return [-dz / l, dx / l]; // vpravo
    });
    const wall = [0.7, 0.68, 0.64];
    const floor = [0.32, 0.31, 0.3];
    const ceil = [0.58, 0.57, 0.55];
    const stWall = [0.86, 0.83, 0.74];
    const stFloor = [0.62, 0.6, 0.58];
    const platform = [0.75, 0.73, 0.7];
    for (let i = 0; i + 1 < P.length; i++) {
      const p = P[i], q = P[i + 1];
      const st = stAt(p.s);
      const stq = stAt(q.s);
      const hwp = st ? HW_ST : HW, hwq = stq ? HW_ST : HW;
      // Osvětlení: světla každých 24 m v tunelu, ve stanici jasno.
      const lamp = (s: number) => 0.6 + 0.5 * Math.max(0, 1 - Math.abs(((s + 12) % 24) - 12) / 6);
      const lp = st ? 1 : lamp(p.s), lq = stq ? 1 : lamp(q.s);
      const sc = (c: number[], k: number) => c.map((v) => v * k);
      const L = (pt: typeof p, n: number[], hw: number, y: number) => [pt.x + n[0] * -hw - ax, y, pt.z + n[1] * -hw - az];
      const R = (pt: typeof p, n: number[], hw: number, y: number) => [pt.x + n[0] * hw - ax, y, pt.z + n[1] * hw - az];
      const np = side[i], nq = side[i + 1];
      const fy = p.y - 0.3, fyq = q.y - 0.3;
      const ty = p.y + HEIGHT + (st ? 1.5 : 0), tyq = q.y + HEIGHT + (stq ? 1.5 : 0);
      // Podlaha, stěny, strop.
      quad(L(p, np, hwp, fy), R(p, np, hwp, fy), R(q, nq, hwq, fyq), L(q, nq, hwq, fyq), sc(st ? stFloor : floor, lp), sc(stq ? stFloor : floor, lq));
      quad(L(p, np, hwp, fy), L(q, nq, hwq, fyq), L(q, nq, hwq, tyq), L(p, np, hwp, ty), sc(st ? stWall : wall, lp), sc(stq ? stWall : wall, lq));
      quad(R(p, np, hwp, fy), R(p, np, hwp, ty), R(q, nq, hwq, tyq), R(q, nq, hwq, fyq), sc(st ? stWall : wall, lp), sc(stq ? stWall : wall, lq));
      quad(L(p, np, hwp, ty), L(q, nq, hwq, tyq), R(q, nq, hwq, tyq), R(p, np, hwp, ty), sc(ceil, lp * 0.9), sc(ceil, lq * 0.9));
      // Nástupiště vpravo (strana dveří).
      if (st && stq) {
        const a = R(p, np, 1.75, p.y + 1.1), b = R(q, nq, 1.75, q.y + 1.1);
        const c = R(q, nq, HW_ST, q.y + 1.1), d = R(p, np, HW_ST, p.y + 1.1);
        quad(a, b, c, d, platform);
        quad(R(p, np, 1.75, fy), R(q, nq, 1.75, fyq), b, a, sc(platform, 0.7));
        // Bezpečnostní pás.
        quad(a, b, R(q, nq, 2.15, q.y + 1.11), R(p, np, 2.15, p.y + 1.11), [0.95, 0.8, 0.2]);
      }
      // Kolejnice.
      for (const off of [-0.72, 0.72]) {
        quad(R(p, np, off - 0.04, p.y + 0.02), R(q, nq, off - 0.04, q.y + 0.02), R(q, nq, off + 0.04, q.y + 0.02), R(p, np, off + 0.04, p.y + 0.02), [0.55, 0.55, 0.58]);
      }
    }
    // Uzavřít konce tunelu.
    for (const i of [0, P.length - 1]) {
      const p = P[i], n = side[i];
      const L0 = [p.x - n[0] * HW - ax, p.y - 0.3, p.z - n[1] * HW - az], R0 = [p.x + n[0] * HW - ax, p.y - 0.3, p.z + n[1] * HW - az];
      quad(L0, R0, [R0[0], p.y + HEIGHT, R0[2]], [L0[0], p.y + HEIGHT, L0[2]], [0.3, 0.3, 0.3]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: true }));
    mesh.frustumCulled = false;
    this.group.add(mesh);
    // Cedule s názvy stanic a světla ve stanicích.
    for (const st of stations) {
      const tex = signTexture(st.name);
      for (const ds of [-45, -15, 15, 45]) {
        const s = st.s + ds;
        const i = Math.max(0, Math.min(P.length - 2, Math.round(s / STEP)));
        const p = P[i], q = P[i + 1], n = side[i];
        const m = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.9), new THREE.MeshBasicMaterial({ map: tex }));
        m.position.set(p.x + n[0] * (HW_ST - 0.05) - ax, p.y + 3.6, p.z + n[1] * (HW_ST - 0.05) - az);
        m.lookAt(p.x - ax, p.y + 3.6, p.z - az);
        void q;
        this.group.add(m);
        const m2 = m.clone();
        m2.position.set(p.x - n[0] * (HW_ST - 0.05) - ax, p.y + 3.6, p.z - n[1] * (HW_ST - 0.05) - az);
        m2.lookAt(p.x - ax, p.y + 3.6, p.z - az);
        this.group.add(m2);
      }
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
    this.group.parent?.remove(this.group);
  }
}

function signTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 92;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1d4f8f';
  ctx.fillRect(0, 0, 512, 92);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 54px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 18), 256, 48);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
