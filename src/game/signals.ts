// Semafory na větších křižovatkách v zastavěném území. OSM data v dlaždicích semafory
// neobsahují, proto je odvozujeme: křižovatka se 4+ rameny, alespoň jedno je silnice I.–III. třídy.

import * as THREE from 'three';
import type { GEdge, GNode } from '../world/roadgraph';
import type { World } from '../world/world';

const MAJOR = new Set(['trunk', 'primary', 'secondary', 'tertiary']);
const CYCLE = 34; // s: 15 zelená A, 2 žlutá, 15 zelená B, 2 žlutá

type Light = 'green' | 'yellow' | 'red';

interface SignalNode {
  node: GNode;
  axis: number; // úhel hlavní osy
  offset: number;
  group: THREE.Group;
  lamps: { mesh: THREE.Mesh; angle: number }[];
}

const MAT = {
  red: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
  yellow: new THREE.MeshBasicMaterial({ color: 0xffb21a }),
  green: new THREE.MeshBasicMaterial({ color: 0x2aff6a }),
  pole: new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6 }),
  box: new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.5 }),
};
const POLE = new THREE.CylinderGeometry(0.07, 0.09, 3.4, 6).translate(0, 1.7, 0);
const BOX = new THREE.BoxGeometry(0.32, 0.9, 0.25).translate(0, 3.2, 0);
const LAMP = new THREE.SphereGeometry(0.14, 8, 6);

function angleOf(n: GNode, e: GEdge): number {
  const o = e.a === n ? e.b : e.a;
  return Math.atan2(o.x - n.x, -(o.z - n.z));
}

function axisDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

export class Signals {
  readonly group = new THREE.Group();
  private active = new Map<GNode, SignalNode>();
  private checked = new WeakMap<GNode, boolean>();
  private scanT = 0;
  time = 0;

  constructor(private world: World) {}

  private isSignal(n: GNode): boolean {
    const c = this.checked.get(n);
    if (c !== undefined) return c;
    const edges = [...n.out, ...n.inn].filter((e) => e.cls !== 'path' && e.cls !== 'track');
    const neigh = new Set(edges.map((e) => (e.a === n ? e.b : e.a)));
    let res = neigh.size >= 4 && edges.some((e) => MAJOR.has(e.cls));
    if (res) res = this.world.buildingVolume(n.x, n.z, 200) > 50000;
    this.checked.set(n, res);
    return res;
  }

  /** Světlo pro vozidlo přijíždějící k uzlu po hraně e. */
  lightFor(n: GNode, e: GEdge): Light | null {
    const s = this.active.get(n);
    if (!s) return null;
    return this.light(s, angleOf(n, e));
  }

  private light(s: SignalNode, approach: number): Light {
    const t = (this.time + s.offset) % CYCLE;
    const main = axisDiff(approach, s.axis) < Math.PI / 4;
    const tt = main ? t : (t + CYCLE / 2) % CYCLE;
    return tt < 15 ? 'green' : tt < 17 ? 'yellow' : 'red';
  }

  /** Nejbližší semafor před vozidlem (do 40 m) – pro hráče. */
  ahead(x: number, z: number, heading: number): { node: GNode; dist: number; light: Light } | null {
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    let best: { node: GNode; dist: number; light: Light } | null = null;
    for (const s of this.active.values()) {
      const dx = s.node.x - x, dz = s.node.z - z;
      const along = dx * fx + dz * fz;
      const side = Math.abs(dx * -fz + dz * fx);
      if (along < -2 || along > 40 || side > 8) continue;
      // Úhel příjezdu = směr od uzlu zpět k vozidlu.
      const approach = Math.atan2(-fx, fz);
      const l = this.light(s, approach);
      if (!best || along < best.dist) best = { node: s.node, dist: along, light: l };
    }
    return best;
  }

  update(dt: number, px: number, pz: number) {
    this.time += dt;
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 1.5;
      const keep = new Set<GNode>();
      for (const n of this.world.graph.nodes.values()) {
        if (Math.abs(n.x - px) > 350 || Math.abs(n.z - pz) > 350) continue;
        if (!this.isSignal(n)) continue;
        keep.add(n);
        if (!this.active.has(n)) this.create(n);
      }
      for (const [n, s] of this.active) {
        if (!keep.has(n)) {
          this.group.remove(s.group);
          this.active.delete(n);
        }
      }
    }
    for (const s of this.active.values()) {
      const g = this.world.groundHeight(s.node.x, s.node.z, 9999);
      this.world.toScene(s.node.x, s.node.z, s.group.position, Number.isNaN(g) ? 0 : g);
      for (const l of s.lamps) {
        const c = this.light(s, l.angle);
        l.mesh.material = MAT[c];
        l.mesh.position.y = c === 'red' ? 3.45 : c === 'yellow' ? 3.2 : 2.95;
      }
    }
  }

  private create(n: GNode) {
    const edges = [...n.out, ...n.inn].filter((e) => e.cls !== 'path' && e.cls !== 'track');
    const major = edges.reduce((a, b) => (MAJOR.has(b.cls) && !MAJOR.has(a.cls) ? b : a), edges[0]);
    const axis = angleOf(n, major);
    const group = new THREE.Group();
    const lamps: SignalNode['lamps'] = [];
    const seen: number[] = [];
    for (const e of edges) {
      const ang = angleOf(n, e);
      if (seen.some((a) => Math.abs(((ang - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > Math.PI - 0.4)) continue;
      seen.push(ang);
      // Sloup vpravo od příjezdu: ve směru ramene, posunutý doprava (z pohledu přijíždějícího).
      const dx = Math.sin(ang), dz = -Math.cos(ang);
      const off = (e.width ?? 6) / 2 + 1.2;
      const x = dx * 7 + -dz * -off;
      const z = dz * 7 + dx * -off;
      const pole = new THREE.Mesh(POLE, MAT.pole);
      const box = new THREE.Mesh(BOX, MAT.box);
      const lamp = new THREE.Mesh(LAMP, MAT.red);
      for (const m of [pole, box, lamp]) {
        m.position.x += x;
        m.position.z += z;
      }
      // Krabice natočená k přijíždějícím.
      box.rotation.y = -ang;
      lamp.position.x += dx * 0.14;
      lamp.position.z += dz * 0.14;
      group.add(pole, box, lamp);
      lamps.push({ mesh: lamp, angle: ang });
    }
    this.group.add(group);
    this.active.set(n, { node: n, axis, offset: (n.id * 7.3) % CYCLE, group, lamps });
  }

  clear() {
    for (const s of this.active.values()) this.group.remove(s.group);
    this.active.clear();
  }
}
