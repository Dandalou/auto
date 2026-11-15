// Silniční síť poskládaná z načtených dlaždic. Slouží pro navigaci (A*),
// AI dopravu, autobusové linky a zjištění, jestli auto jede po silnici.

import type { RoadLine } from './types';

export interface GNode {
  id: number;
  x: number;
  z: number;
  y: number;
  out: GEdge[];
  inn: GEdge[];
}

export interface GEdge {
  a: GNode;
  b: GNode;
  len: number;
  cls: string;
  /** Lze jet z a do b. */
  fwd: boolean;
  /** Lze jet z b do a. */
  back: boolean;
  tile: string;
  width: number;
}

export const ROAD_HALF_WIDTH: Record<string, number> = {
  motorway: 4.5, trunk: 4.3, primary: 4, secondary: 3.6, tertiary: 3.3, minor: 2.8, service: 1.9,
  busway: 3.3, raceway: 4.5, track: 1.5, path: 0.9,
};

export const SPEED_LIMIT: Record<string, number> = {
  motorway: 130, trunk: 110, primary: 90, secondary: 80, tertiary: 70, minor: 50, service: 30,
  busway: 50, raceway: 120, track: 30, path: 10,
};

export type RouteProfile = 'car' | 'bus' | 'walk';

const CELL = 40;

export class RoadGraph {
  nodes = new Map<string, GNode>();
  private nodeCells = new Map<string, GNode[]>();
  private edgeCells = new Map<string, GEdge[]>();
  edgesByTile = new Map<string, GEdge[]>();
  private nextId = 1;
  version = 0;

  private cellKey(cx: number, cz: number) {
    return `${cx},${cz}`;
  }

  private findNode(x: number, z: number, tol: number): GNode | null {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: GNode | null = null;
    let bd = tol;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const l = this.nodeCells.get(this.cellKey(cx + dx, cz + dz));
        if (!l) continue;
        for (const n of l) {
          const d = Math.hypot(n.x - x, n.z - z);
          if (d <= bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return best;
  }

  private node(x: number, z: number, y: number, edgePoint: boolean): GNode {
    const tol = edgePoint ? 1.5 : 0.05;
    const f = this.findNode(x, z, tol);
    if (f) {
      if (Number.isNaN(f.y) && !Number.isNaN(y)) f.y = y;
      return f;
    }
    const n: GNode = { id: this.nextId++, x, z, y, out: [], inn: [] };
    const k = this.cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
    let l = this.nodeCells.get(k);
    if (!l) this.nodeCells.set(k, (l = []));
    l.push(n);
    this.nodes.set(String(n.id), n);
    return n;
  }

  addTile(key: string, ox: number, oz: number, size: number, lines: RoadLine[]) {
    const edges: GEdge[] = [];
    const isEdge = (lx: number, lz: number) => lx < 0.01 || lz < 0.01 || lx > size - 0.01 || lz > size - 0.01;
    for (const l of lines) {
      const p = l.pts;
      const n = p.length / 3;
      let prev: GNode | null = null;
      for (let i = 0; i < n; i++) {
        const lx = p[i * 3], y = p[i * 3 + 1], lz = p[i * 3 + 2];
        const nd = this.node(ox + lx, oz + lz, y, isEdge(lx, lz));
        if (prev && prev !== nd) {
          const len = Math.hypot(nd.x - prev.x, nd.z - prev.z);
          const e: GEdge = {
            a: prev, b: nd, len, cls: l.cls, fwd: l.oneway !== -1, back: l.oneway !== 1, tile: key,
            width: (ROAD_HALF_WIDTH[l.cls] ?? 2) * 2,
          };
          prev.out.push(e);
          nd.inn.push(e);
          edges.push(e);
          this.indexEdge(e);
        }
        prev = nd;
      }
    }
    this.edgesByTile.set(key, edges);
    this.version++;
  }

  private edgeCellsOf(e: GEdge): string[] {
    const keys: string[] = [];
    const x0 = Math.floor(Math.min(e.a.x, e.b.x) / CELL), x1 = Math.floor(Math.max(e.a.x, e.b.x) / CELL);
    const z0 = Math.floor(Math.min(e.a.z, e.b.z) / CELL), z1 = Math.floor(Math.max(e.a.z, e.b.z) / CELL);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) keys.push(this.cellKey(cx, cz));
    return keys;
  }

  private indexEdge(e: GEdge) {
    for (const k of this.edgeCellsOf(e)) {
      let l = this.edgeCells.get(k);
      if (!l) this.edgeCells.set(k, (l = []));
      l.push(e);
    }
  }

  removeTile(key: string) {
    const edges = this.edgesByTile.get(key);
    if (!edges) return;
    const touched = new Set<GNode>();
    for (const e of edges) {
      e.a.out = e.a.out.filter((x) => x !== e);
      e.b.inn = e.b.inn.filter((x) => x !== e);
      touched.add(e.a);
      touched.add(e.b);
      for (const k of this.edgeCellsOf(e)) {
        const l = this.edgeCells.get(k);
        if (!l) continue;
        const i = l.indexOf(e);
        if (i >= 0) l.splice(i, 1);
        if (!l.length) this.edgeCells.delete(k);
      }
    }
    for (const n of touched) {
      if (n.out.length || n.inn.length) continue;
      this.nodes.delete(String(n.id));
      const k = this.cellKey(Math.floor(n.x / CELL), Math.floor(n.z / CELL));
      const l = this.nodeCells.get(k);
      if (l) {
        const i = l.indexOf(n);
        if (i >= 0) l.splice(i, 1);
        if (!l.length) this.nodeCells.delete(k);
      }
    }
    this.edgesByTile.delete(key);
    this.version++;
  }

  /** Nejbližší hrana k bodu. */
  nearest(x: number, z: number, maxDist: number, filter?: (e: GEdge) => boolean): { e: GEdge; t: number; d: number } | null {
    const r = Math.ceil(maxDist / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: { e: GEdge; t: number; d: number } | null = null;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const l = this.edgeCells.get(this.cellKey(cx + dx, cz + dz));
        if (!l) continue;
        for (const e of l) {
          if (filter && !filter(e)) continue;
          const ex = e.b.x - e.a.x, ez = e.b.z - e.a.z;
          const l2 = ex * ex + ez * ez || 1;
          const t = Math.max(0, Math.min(1, ((x - e.a.x) * ex + (z - e.a.z) * ez) / l2));
          const d = Math.hypot(e.a.x + ex * t - x, e.a.z + ez * t - z);
          if (d <= maxDist && (!best || d < best.d)) best = { e, t, d };
        }
      }
    }
    return best;
  }

  /** Je bod na vozovce? Vrací třídu silnice nebo null. */
  surfaceAt(x: number, z: number): string | null {
    const n = this.nearest(x, z, 6);
    if (!n) return null;
    const hw = ROAD_HALF_WIDTH[n.e.cls] ?? 2;
    return n.d <= hw + 0.4 ? n.e.cls : null;
  }

  static allowed(e: GEdge, profile: RouteProfile): boolean {
    if (profile === 'walk') return true;
    if (e.cls === 'path') return false;
    if (profile === 'bus' && e.cls === 'track') return false;
    return true;
  }

  static cost(e: GEdge, profile: RouteProfile): number {
    let v = SPEED_LIMIT[e.cls] ?? 40;
    if (profile === 'walk') v = 5;
    if (profile === 'bus' && e.cls === 'service') v = 8;
    if (e.cls === 'track') v = 8;
    return e.len / v;
  }

  /**
   * Trasa A* mezi dvěma body. Vrací body (x, z) včetně napojení na silnici, nebo null.
   */
  route(fx: number, fz: number, tx: number, tz: number, profile: RouteProfile, maxNodes = 60000): { pts: [number, number][]; len: number } | null {
    const flt = (e: GEdge) => RoadGraph.allowed(e, profile);
    const s = this.nearest(fx, fz, 80, flt);
    const t = this.nearest(tx, tz, 120, flt);
    if (!s || !t) return null;
    const startCands: { n: GNode; c: number }[] = [];
    const sp = { x: s.e.a.x + (s.e.b.x - s.e.a.x) * s.t, z: s.e.a.z + (s.e.b.z - s.e.a.z) * s.t };
    const tp = { x: t.e.a.x + (t.e.b.x - t.e.a.x) * t.t, z: t.e.a.z + (t.e.b.z - t.e.a.z) * t.t };
    const walk = profile === 'walk';
    if (s.e.fwd || walk) startCands.push({ n: s.e.b, c: (1 - s.t) * RoadGraph.cost(s.e, profile) });
    if (s.e.back || walk) startCands.push({ n: s.e.a, c: s.t * RoadGraph.cost(s.e, profile) });
    // Cílová hrana: dojedeme na její uzel a pak po ní.
    const goal = new Map<GNode, number>();
    if (t.e.fwd || walk) goal.set(t.e.a, t.t * RoadGraph.cost(t.e, profile));
    if (t.e.back || walk) goal.set(t.e.b, (1 - t.t) * RoadGraph.cost(t.e, profile));
    if (s.e === t.e) {
      return { pts: [[sp.x, sp.z], [tp.x, tp.z]], len: Math.hypot(tp.x - sp.x, tp.z - sp.z) };
    }
    const vmax = walk ? 5 : 130;
    const hfun = (n: GNode) => Math.hypot(n.x - tp.x, n.z - tp.z) / vmax;
    const g = new Map<GNode, number>();
    const prev = new Map<GNode, GNode>();
    const heap = new MinHeap<GNode>();
    for (const c of startCands) {
      g.set(c.n, c.c);
      heap.push(c.n, c.c + hfun(c.n));
    }
    let best: GNode | null = null;
    let bestCost = Infinity;
    let visited = 0;
    const closed = new Set<GNode>();
    while (heap.size) {
      const n = heap.pop()!;
      if (closed.has(n)) continue;
      closed.add(n);
      const gn = g.get(n)!;
      if (gn + hfun(n) >= bestCost) break;
      const gc = goal.get(n);
      if (gc !== undefined && gn + gc < bestCost) {
        bestCost = gn + gc;
        best = n;
      }
      if (++visited > maxNodes) break;
      const relax = (e: GEdge, m: GNode) => {
        if (!RoadGraph.allowed(e, profile)) return;
        const c = gn + RoadGraph.cost(e, profile);
        if (c < (g.get(m) ?? Infinity)) {
          g.set(m, c);
          prev.set(m, n);
          heap.push(m, c + hfun(m));
        }
      };
      for (const e of n.out) if (e.fwd || walk) relax(e, e.b);
      for (const e of n.inn) if (e.back || walk) relax(e, e.a);
    }
    if (!best) return null;
    const chain: GNode[] = [];
    for (let n: GNode | undefined = best; n; n = prev.get(n)) chain.push(n);
    chain.reverse();
    const pts: [number, number][] = [[sp.x, sp.z], ...chain.map((n) => [n.x, n.z] as [number, number]), [tp.x, tp.z]];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { pts, len };
  }
}

export class MinHeap<T> {
  private items: T[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: T, key: number) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): T | undefined {
    if (!this.items.length) return undefined;
    const top = this.items[0];
    const lastI = this.items.pop()!;
    const lastK = this.keys.pop()!;
    if (this.items.length) {
      this.items[0] = lastI;
      this.keys[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.items.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
