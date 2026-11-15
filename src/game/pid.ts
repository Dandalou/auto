// Skutečné linky Pražské integrované dopravy (PID) z GTFS, předzpracované do public/pid.json.

import { lonLatToWorld } from '../geo';
import type { World } from '../world/world';
import type { PlannedLine } from './jobs';

interface PidDir {
  h: string;
  s: number[];
  m: number[];
}

interface PidLine {
  n: string;
  l: string;
  t: number;
  night: number;
  reg: number;
  f: number;
  d: PidDir[];
}

interface PidData {
  stops: [string, number, number][];
  lines: PidLine[];
}

let data: PidData | null = null;
let stopXZ: Float64Array | null = null;
let loading: Promise<void> | null = null;

export function loadPid(): Promise<void> {
  if (loading) return loading;
  loading = fetch('./pid.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j: PidData | null) => {
      if (!j) return;
      data = j;
      stopXZ = new Float64Array(j.stops.length * 2);
      j.stops.forEach(([, lat, lon], i) => {
        const p = lonLatToWorld(lon, lat);
        stopXZ![i * 2] = p.x;
        stopXZ![i * 2 + 1] = p.z;
      });
    })
    .catch(() => {});
  return loading;
}

export interface PidPlan extends PlannedLine {
  headsign: string;
  regional: boolean;
  /** Plánované odjezdy od první zastávky (s) podle jízdního řádu PID. */
  times: number[];
}

/** Úsek skutečné linky PID začínající u zastávky blízko hráče. */
export function planPidLines(world: World, x: number, z: number, max = 3): PidPlan[] {
  if (!data || !stopXZ) return [];
  const cands: { line: PidLine; dir: PidDir; start: number; d: number }[] = [];
  for (const line of data.lines) {
    if (line.night) continue;
    for (const dir of line.d) {
      let best = -1;
      let bd = 1500;
      for (let k = 0; k < dir.s.length - 3; k++) {
        const si = dir.s[k];
        const d = Math.hypot(stopXZ[si * 2] - x, stopXZ[si * 2 + 1] - z);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      if (best >= 0) cands.push({ line, dir, start: best, d: bd });
    }
  }
  // Náhodně, ale bližší linky mají přednost.
  cands.sort((a, b) => a.d * (0.5 + Math.random()) - b.d * (0.5 + Math.random()));
  const out: PidPlan[] = [];
  const used = new Set<string>();
  for (const c of cands) {
    if (out.length >= max) break;
    if (used.has(c.line.n)) continue;
    const stops: { name: string; x: number; z: number }[] = [];
    const times: number[] = [];
    const legs: [number, number][][] = [];
    const legLen: number[] = [];
    const want = 6 + Math.floor(Math.random() * 4);
    for (let k = c.start; k < c.dir.s.length && stops.length < want; k++) {
      const si = c.dir.s[k];
      const sx = stopXZ[si * 2], sz = stopXZ[si * 2 + 1];
      if (!world.isReady(sx, sz)) break;
      if (stops.length) {
        const prev = stops[stops.length - 1];
        const r = world.graph.route(prev.x, prev.z, sx, sz, 'bus', 20000);
        if (!r) break;
        legs.push(r.pts);
        legLen.push(r.len);
      }
      stops.push({ name: data.stops[si][0], x: sx, z: sz });
      times.push(Math.round((c.dir.m[k] - c.dir.m[c.start]) * 60));
    }
    if (stops.length < 3) continue;
    used.add(c.line.n);
    out.push({ stops, legs, legLen, number: c.line.n, headsign: c.dir.h, regional: !!c.line.reg, times });
  }
  return out;
}
