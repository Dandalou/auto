// Chodci: lidé se procházejí po chodnících a pěšinách v okolí hráče.

import * as THREE from 'three';
import type { GEdge, GNode } from '../world/roadgraph';
import { ROAD_HALF_WIDTH } from '../world/roadgraph';
import type { World } from '../world/world';
import { buildPerson } from './models';

interface Walker {
  mesh: THREE.Object3D;
  edge: GEdge;
  forward: boolean;
  s: number;
  side: number;
  speed: number;
  x: number;
  z: number;
  heading: number;
  phase: number;
  wait: number;
}

const SHIRTS = [0x3a6ea5, 0xa53a3a, 0x3aa56e, 0x806040, 0x555555, 0xd9a441, 0x7a4fa0, 0xe0e0e0, 0x2f4f4f, 0xc76b8f];
const WALKABLE = new Set(['path', 'minor', 'service', 'tertiary', 'secondary', 'primary']);

export class Pedestrians {
  readonly group = new THREE.Group();
  people: Walker[] = [];
  max = 30;
  enabled = true;
  private spawnT = 0;

  constructor(private world: World) {}

  private spawn(px: number, pz: number) {
    const ang = Math.random() * Math.PI * 2;
    const d = 40 + Math.random() * 220;
    const n = this.world.graph.nearest(px + Math.cos(ang) * d, pz + Math.sin(ang) * d, 60, (e) => WALKABLE.has(e.cls));
    if (!n) return;
    // Chodci hlavně tam, kde je zástavba.
    if (n.e.cls !== 'path' && this.world.buildingVolume(n.e.a.x, n.e.a.z, 60) < 3000) return;
    const mesh = buildPerson(SHIRTS[Math.floor(Math.random() * SHIRTS.length)]);
    const w: Walker = {
      mesh, edge: n.e, forward: Math.random() < 0.5, s: n.t * n.e.len, side: Math.random() < 0.5 ? 1 : -1,
      speed: 1.1 + Math.random() * 0.5, x: 0, z: 0, heading: 0, phase: Math.random() * 6, wait: 0,
    };
    if (!w.forward) w.s = n.e.len - w.s;
    w.x = n.e.a.x + (n.e.b.x - n.e.a.x) * n.t;
    w.z = n.e.a.z + (n.e.b.z - n.e.a.z) * n.t;
    this.group.add(mesh);
    this.people.push(w);
  }

  private remove(w: Walker) {
    this.group.remove(w.mesh);
    const i = this.people.indexOf(w);
    if (i >= 0) this.people.splice(i, 1);
  }

  private next(w: Walker): boolean {
    const node: GNode = w.forward ? w.edge.b : w.edge.a;
    const opts = [...node.out, ...node.inn].filter((e) => e !== w.edge && WALKABLE.has(e.cls));
    if (!opts.length) return false;
    const e = opts[Math.floor(Math.random() * opts.length)];
    w.edge = e;
    w.forward = e.a === node;
    w.s = 0;
    return true;
  }

  update(dt: number, px: number, pz: number, avoid: { x: number; z: number; speed: number } | null) {
    if (!this.enabled) {
      for (const w of [...this.people]) this.remove(w);
      return;
    }
    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.people.length < this.max) {
      this.spawnT = 0.3;
      const n = this.people.length < this.max / 2 ? 6 : 1;
      for (let i = 0; i < n; i++) this.spawn(px, pz);
    }
    for (const w of [...this.people]) {
      const e = w.edge;
      if (Math.hypot(w.x - px, w.z - pz) > 400 || !e.a.out.includes(e)) {
        this.remove(w);
        continue;
      }
      // Uhnout před blížícím se autem.
      let sp = w.speed;
      if (avoid && avoid.speed > 2 && Math.hypot(avoid.x - w.x, avoid.z - w.z) < 8) sp = 0;
      if (w.wait > 0) {
        w.wait -= dt;
        sp = 0;
      }
      w.s += sp * dt;
      if (w.s > w.edge.len) {
        if (!this.next(w)) {
          w.forward = !w.forward;
          w.s = 0;
          w.wait = 1 + Math.random() * 3;
        }
      }
      const a = w.forward ? w.edge.a : w.edge.b;
      const b = w.forward ? w.edge.b : w.edge.a;
      const l = w.edge.len || 1;
      const t = Math.min(1, w.s / l);
      const dx = (b.x - a.x) / l, dz = (b.z - a.z) / l;
      const off = w.edge.cls === 'path' ? 0.5 * w.side : ((ROAD_HALF_WIDTH[w.edge.cls] ?? 3) + 1.2) * w.side;
      const tx = a.x + (b.x - a.x) * t - dz * off;
      const tz = a.z + (b.z - a.z) * t + dx * off;
      const k = Math.min(1, dt * 6);
      w.x += (tx - w.x) * k;
      w.z += (tz - w.z) * k;
      const h = Math.atan2(dx, -dz);
      let dh = h - w.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      w.heading += dh * Math.min(1, dt * 5);
      w.phase += sp * dt * 4;
      const y = this.world.groundHeight(w.x, w.z, 9999);
      this.world.toScene(w.x, w.z, w.mesh.position, (Number.isNaN(y) ? 0 : y) + Math.abs(Math.sin(w.phase)) * 0.04);
      w.mesh.rotation.y = -w.heading;
    }
  }

  obstacles(): { x: number; z: number; r: number }[] {
    return this.people.map((w) => ({ x: w.x, z: w.z, r: 0.35 }));
  }

  clear() {
    for (const w of [...this.people]) this.remove(w);
  }
}
