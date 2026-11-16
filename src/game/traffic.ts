// AI doprava: auta jezdí po skutečné silniční síti kolem hráče,
// firemní autobusy jezdí po linkách, které hráč vytvořil.

import * as THREE from 'three';
import type { GEdge, GNode } from '../world/roadgraph';
import { ROAD_HALF_WIDTH, SPEED_LIMIT } from '../world/roadgraph';
import type { World } from '../world/world';
import { buildVehicleModel, updateSign, type VehicleModel } from './models';
import { SPECS, type VehicleSpec, type VehicleType } from './vehicle';
import type { CompanyLine } from './state';
import type { Signals } from './signals';

interface AICar {
  spec: VehicleSpec;
  model: VehicleModel;
  // Režim po síti.
  edge: GEdge | null;
  forward: boolean;
  s: number;
  prev: GEdge | null;
  // Režim po lince.
  line?: CompanyLine;
  pathIdx: number;
  pathS: number;
  dwell: number;
  speed: number;
  x: number;
  z: number;
  y: number;
  heading: number;
  r: number;
}

const COLORS = [0xd8d8d8, 0x2a2a2a, 0x8a1c1c, 0x1f3f7a, 0x6b6e72, 0xf0f0f0, 0x3b5e3b, 0xb8a27a, 0x5a2f6b, 0xc46a1a];

export class Traffic {
  cars: AICar[] = [];
  readonly group = new THREE.Group();
  max = 28;
  enabled = true;
  private spawnT = 0;
  private tramT = 0;
  private lineCars = new Map<string, AICar>();
  signals: Signals | null = null;

  constructor(private world: World) {}

  private nodeOf(c: AICar): GNode {
    return c.forward ? c.edge!.b : c.edge!.a;
  }

  private canUse(e: GEdge, fromNode: GNode, tram = false): boolean {
    if (tram !== (e.cls === 'tram')) return false;
    if (e.cls === 'metro') return false;
    if (e.cls === 'path' || e.cls === 'track') return false;
    return e.a === fromNode ? e.fwd : e.back;
  }

  private spawn(px: number, pz: number, tram = false) {
    const ang = Math.random() * Math.PI * 2;
    const d = 180 + Math.random() * 450;
    const flt = tram ? (e: GEdge) => e.cls === 'tram' : (e: GEdge) => e.cls !== 'path' && e.cls !== 'track' && e.cls !== 'service' && e.cls !== 'tram' && e.cls !== 'metro';
    const near = this.world.graph.nearest(px + Math.cos(ang) * d, pz + Math.sin(ang) * d, 120, flt);
    if (!near) return;
    const e = near.e;
    const forward = e.fwd && (!e.back || Math.random() < 0.5);
    if (!forward && !e.back) return;
    const r = Math.random();
    const type: VehicleType = tram ? 'tramvaj' : r < 0.82 ? 'auto' : r < 0.9 ? 'dodávka' : r < 0.95 ? 'kamion' : 'taxi';
    const spec = SPECS[type];
    const model = buildVehicleModel(spec, tram ? 0xc8202a : type === 'taxi' ? 0xf3d23a : COLORS[Math.floor(Math.random() * COLORS.length)], false);
    if (tram) updateSign(model, String(1 + Math.floor(Math.random() * 26)), '');
    this.group.add(model.root);
    const s = (forward ? near.t : 1 - near.t) * e.len;
    const car: AICar = {
      spec, model, edge: e, forward, s, prev: null, pathIdx: 0, pathS: 0, dwell: 0,
      speed: 8, x: 0, z: 0, y: 0, heading: 0, r: spec.width / 2,
    };
    this.place(car);
    // Nezačínat v kolizi s jiným autem.
    if (this.cars.some((o) => Math.hypot(o.x - car.x, o.z - car.z) < (tram ? 40 : 12))) {
      this.remove(car);
      return;
    }
    this.cars.push(car);
  }

  private remove(c: AICar) {
    this.group.remove(c.model.root);
    c.model.root.traverse((o) => {
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
    });
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
  }

  private place(c: AICar) {
    const e = c.edge!;
    const a = c.forward ? e.a : e.b;
    const b = c.forward ? e.b : e.a;
    const t = e.len > 0 ? c.s / e.len : 0;
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const twoWay = e.fwd && e.back && e.cls !== 'tram';
    const off = twoWay ? (ROAD_HALF_WIDTH[e.cls] ?? 2.5) * 0.5 : 0;
    // Vpravo od směru jízdy (Z na jih): (−dz, dx).
    c.x = a.x + dx * t + (-dz / l) * off;
    c.z = a.z + dz * t + (dx / l) * off;
    const h = Math.atan2(dx, -dz);
    let dh = h - c.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    c.heading += Math.abs(dh) > 1.2 ? dh : dh * 0.25;
  }

  private nextEdge(c: AICar): boolean {
    const node = this.nodeOf(c);
    const opts: GEdge[] = [];
    for (const e of [...node.out, ...node.inn]) {
      if (e === c.edge) continue;
      if (this.canUse(e, node, c.spec.type === 'tramvaj')) opts.push(e);
    }
    if (!opts.length) return false;
    // Preferovat pokračování rovně a vyšší třídu.
    const cur = c.edge!;
    const from = c.forward ? cur.a : cur.b;
    const hx = node.x - from.x, hz = node.z - from.z;
    const hl = Math.hypot(hx, hz) || 1;
    let best = opts[0];
    let bw = -Infinity;
    for (const e of opts) {
      const to = e.a === node ? e.b : e.a;
      const dx = to.x - node.x, dz = to.z - node.z;
      const dl = Math.hypot(dx, dz) || 1;
      const straight = (dx * hx + dz * hz) / (dl * hl);
      const w = straight * 1.2 + (e.cls === cur.cls ? 0.8 : 0) + Math.random() * 1.4;
      if (w > bw) {
        bw = w;
        best = e;
      }
    }
    c.prev = cur;
    c.edge = best;
    c.forward = best.a === node;
    c.s = 0;
    return true;
  }

  /** Úhel zatáčky na konci aktuální hrany (0 = rovně). */
  private turnAhead(c: AICar): number {
    const node = this.nodeOf(c);
    if (node.out.length + node.inn.length <= 2) {
      const e = [...node.out, ...node.inn].find((x) => x !== c.edge);
      if (!e) return 1;
      const cur = c.edge!;
      const from = c.forward ? cur.a : cur.b;
      const to = e.a === node ? e.b : e.a;
      const ax = node.x - from.x, az = node.z - from.z, bx = to.x - node.x, bz = to.z - node.z;
      const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) || 1) * (Math.hypot(bx, bz) || 1));
      return Math.acos(Math.max(-1, Math.min(1, cos)));
    }
    return 0.9; // křižovatka – zpomalit
  }

  update(dt: number, px: number, pz: number, player: { x: number; z: number; heading: number; speed: number } | null, lines: CompanyLine[], night: number) {
    if (!this.enabled) {
      for (const c of [...this.cars]) this.remove(c);
      return;
    }
    this.spawnT -= dt;
    const netCars = this.cars.filter((c) => !c.line && c.spec.type !== 'tramvaj').length;
    if (this.spawnT <= 0 && netCars < this.max) {
      this.spawnT = 0.25;
      const n = netCars < this.max / 2 ? 5 : 1;
      for (let i = 0; i < n; i++) this.spawn(px, pz);
    }
    // Tramvaje mají vlastní limit, aby je auta nevytlačila.
    this.tramT -= dt;
    if (this.tramT <= 0) {
      this.tramT = 1;
      if (this.cars.filter((c) => c.spec.type === 'tramvaj').length < 4) this.spawn(px, pz, true);
    }
    this.updateLineCars(px, pz, lines);
    for (const c of [...this.cars]) {
      if (Math.hypot(c.x - px, c.z - pz) > 1100) {
        this.remove(c);
        if (c.line) this.lineCars.delete(`${c.line.id}`);
        continue;
      }
      if (c.line) {
        this.stepLine(c, dt);
      } else {
        const e = c.edge!;
        if (!e.a.out.includes(e)) {
          this.remove(c);
          continue;
        }
        if (e.urban === undefined) e.urban = this.world.buildingVolume((e.a.x + e.b.x) / 2, (e.a.z + e.b.z) / 2, 220) > 50000;
        const lim = e.urban && e.cls !== 'motorway' && e.cls !== 'trunk' ? Math.min(50, SPEED_LIMIT[e.cls] ?? 50) : SPEED_LIMIT[e.cls] ?? 50;
        const limit = Math.min(lim / 3.6, c.spec.vmax * 0.9);
        const remain = e.len - c.s;
        const turn = this.turnAhead(c);
        const cornerV = turn < 0.25 ? limit : Math.max(4, 14 - turn * 7);
        let target = remain < 25 ? Math.min(limit, cornerV + remain * 0.35) : limit;
        // Semafor na konci hrany.
        if (this.signals && remain < 45) {
          const light = this.signals.lightFor(this.nodeOf(c), e);
          if (light === 'red' || (light === 'yellow' && remain > 14)) target = Math.min(target, Math.max(0, (remain - 9) * 0.55));
        }
        // Odstup od vozidel před sebou.
        const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
        const ahead = (ox: number, oz: number) => {
          const dx = ox - c.x, dz = oz - c.z;
          const along = dx * fx + dz * fz;
          const side = Math.abs(dx * -fz + dz * fx);
          return along > 0 && along < 45 && side < 2.6 ? along : Infinity;
        };
        let gap = Infinity;
        for (const o of this.cars) if (o !== c) gap = Math.min(gap, ahead(o.x, o.z));
        if (player) gap = Math.min(gap, ahead(player.x, player.z));
        if (gap < 45) target = Math.min(target, Math.max(0, (gap - c.spec.length - 3) * 0.7));
        const acc = target > c.speed ? 2.2 : -6;
        c.speed = Math.max(0, c.speed + Math.max(-8 * dt, Math.min(acc * dt, target - c.speed)));
        c.s += c.speed * dt;
        while (c.edge && c.s > c.edge.len) {
          const over = c.s - c.edge.len;
          if (!this.nextEdge(c)) {
            c.forward = !c.forward;
            c.s = 0;
            c.speed = 0;
            break;
          }
          c.s = over;
        }
        this.place(c);
      }
      const g = this.world.groundHeight(c.x, c.z, c.y + 1);
      if (!Number.isNaN(g)) c.y = g;
      const root = c.model.root;
      this.world.toScene(c.x, c.z, root.position, c.y);
      root.rotation.set(0, -c.heading, 0);
      for (const w of c.model.wheels) w.children.forEach((m) => (m.rotation.x -= (c.speed * dt) / 0.35));
      for (const m of c.model.lightMats) m.emissiveIntensity = night > 0.5 ? 2 : 0.2;
      c.model.brakeMat.emissiveIntensity = night > 0.5 ? 1 : 0.3;
    }
  }

  // ------------------------------------------------------- firemní linky

  private updateLineCars(px: number, pz: number, lines: CompanyLine[]) {
    for (const l of lines) {
      if (l.kind !== 'bus' || !l.vehicles.length || l.path.length < 2) continue;
      const key = `${l.id}`;
      if (this.lineCars.has(key)) continue;
      // Najít bod linky v dosahu hráče.
      let bi = -1;
      let bd = 700;
      for (let i = 0; i < l.path.length; i++) {
        const d = Math.hypot(l.path[i][0] - px, l.path[i][1] - pz);
        if (d < bd && d > 150) {
          bd = d;
          bi = i;
        }
      }
      if (bi < 0) continue;
      const spec = SPECS.autobus;
      const model = buildVehicleModel(spec, 0xc8202a, false);
      updateSign(model, l.number, l.stops[l.stops.length - 1]?.name ?? '');
      this.group.add(model.root);
      const c: AICar = {
        spec, model, edge: null, forward: true, s: 0, prev: null, line: l, pathIdx: bi, pathS: 0, dwell: 0,
        speed: 0, x: l.path[bi][0], z: l.path[bi][1], y: 0, heading: 0, r: spec.width / 2,
      };
      this.cars.push(c);
      this.lineCars.set(key, c);
    }
  }

  private stepLine(c: AICar, dt: number) {
    const p = c.line!.path;
    if (c.dwell > 0) {
      c.dwell -= dt;
      c.speed = 0;
      for (const d of c.model.doors) d.position.x = c.spec.width / 2 + (c.dwell > 1 ? 0.25 : 0.02);
      return;
    }
    for (const d of c.model.doors) d.position.x = c.spec.width / 2 + 0.02;
    c.speed = Math.min(11, c.speed + dt * 1.5);
    let move = c.speed * dt;
    while (move > 0) {
      const a = p[c.pathIdx];
      const b = p[(c.pathIdx + 1) % p.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (c.pathS + move < l) {
        c.pathS += move;
        move = 0;
      } else {
        move -= l - c.pathS;
        c.pathS = 0;
        c.pathIdx = (c.pathIdx + 1) % p.length;
        // Zastávka?
        const nb = p[c.pathIdx];
        if (c.line!.stops.some((s) => Math.hypot(s.x - nb[0], s.z - nb[1]) < 12)) {
          c.dwell = 8;
          c.speed = 0;
          break;
        }
      }
    }
    const a = p[c.pathIdx];
    const b = p[(c.pathIdx + 1) % p.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / l, dz = (b[1] - a[1]) / l;
    c.x = a[0] + dx * c.pathS - dz * 1.6;
    c.z = a[1] + dz * c.pathS + dx * 1.6;
    const h = Math.atan2(dx, -dz);
    let dh = h - c.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    c.heading += dh * Math.min(1, dt * 4);
  }

  obstacles(): { x: number; z: number; r: number }[] {
    const out: { x: number; z: number; r: number }[] = [];
    for (const c of this.cars) {
      const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
      const n = Math.max(2, Math.ceil(c.spec.length / c.spec.width));
      for (let i = 0; i < n; i++) {
        const t = (i / (n - 1) - 0.5) * (c.spec.length - c.spec.width);
        out.push({ x: c.x + fx * t, z: c.z + fz * t, r: c.r });
      }
    }
    return out;
  }

  clear() {
    for (const c of [...this.cars]) this.remove(c);
    this.lineCars.clear();
  }
}
