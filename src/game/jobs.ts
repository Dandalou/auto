// Práce: autobusová linka po skutečných zastávkách, taxi na skutečné adresy, rozvoz zásilek.

import * as THREE from 'three';
import type { NamedPoint } from '../world/types';
import type { World } from '../world/world';
import { RoadGraph } from '../world/roadgraph';
import { buildPerson, updateSign, type VehicleModel } from './models';
import type { Vehicle, VehicleType } from './vehicle';
import type { LineStop } from './state';
import { planPidLines } from './pid';
import { CITIES, lonLatToWorld, worldToLonLat } from '../geo';

export interface JobCtx {
  world: World;
  vehicle: Vehicle | null;
  model: VehicleModel | null;
  scene: THREE.Object3D;
  walking: boolean;
  notify(msg: string, kind?: 'ok' | 'warn' | 'info'): void;
  chime(): void;
  clock: number; // reálné sekundy od začátku
  /** Výška, na které stojí cestující (např. nástupiště metra). */
  yAt?: (x: number, z: number) => number;
}

export interface Waypoint {
  x: number;
  z: number;
  label: string;
}

export interface JobResult {
  pay: number;
  xp: number;
  summary: string[];
  stats: { busStops?: number; passengers?: number; taxiRides?: number; deliveries?: number };
  line?: { stops: LineStop[]; path: [number, number][]; lengthKm: number; tripMin: number; number: string; name: string };
}

export abstract class Job {
  abstract kind: 'bus' | 'taxi' | 'delivery' | 'freight';
  abstract title: string;
  abstract vehicle: VehicleType[];
  done = false;
  failed = false;
  /** Počet přestupků (překročení rychlosti). */
  speeding = 0;
  result: JobResult | null = null;
  abstract target(): Waypoint | null;
  abstract update(dt: number, ctx: JobCtx): void;
  abstract status(ctx: JobCtx): string;
  action(_ctx: JobCtx): void {}
  actionLabel(_ctx: JobCtx): string | null {
    return null;
  }
  dispose() {}
}

// --------------------------------------------------------------- pomocné

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function signed(sec: number): string {
  const s = Math.round(sec);
  return s === 0 ? '±0 s' : s > 0 ? `+${fmtTime(s)}` : `−${fmtTime(-s)}`;
}

/** Sloučí nástupiště stejného jména. */
function uniqueStops(stops: NamedPoint[]): Map<string, NamedPoint[]> {
  const m = new Map<string, NamedPoint[]>();
  for (const s of stops) {
    let l = m.get(s.name);
    if (!l) m.set(s.name, (l = []));
    if (!l.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < 5)) l.push(s);
  }
  return m;
}

export interface PlannedLine {
  stops: NamedPoint[];
  legs: [number, number][][];
  legLen: number[];
  number: string;
  /** Skutečný jízdní řád (s od první zastávky), u linek PID. */
  times?: number[];
  headsign?: string;
  mode?: 'bus' | 'tram' | 'metro';
}

/** Naplánuje linku ze skutečných zastávek v okolí bodu. */
export function planBusLine(world: World, x: number, z: number, count = 7, rnd = Math.random, mode: 'bus' | 'tram' = 'bus'): PlannedLine | null {
  const byName = uniqueStops(mode === 'tram' ? world.allTramStops() : world.allStops());
  const names = [...byName.keys()];
  if (names.length < 3) return null;
  const center = (n: string) => {
    const l = byName.get(n)!;
    return { x: l.reduce((a, b) => a + b.x, 0) / l.length, z: l.reduce((a, b) => a + b.z, 0) / l.length };
  };
  // Začátek: nejbližší zastávka.
  names.sort((a, b) => {
    const ca = center(a), cb = center(b);
    return Math.hypot(ca.x - x, ca.z - z) - Math.hypot(cb.x - x, cb.z - z);
  });
  const startName = names[Math.floor(rnd() * Math.min(3, names.length))];
  const first = byName.get(startName)!;
  const chain: NamedPoint[] = [first[Math.floor(rnd() * first.length)]];
  const used = new Set([startName]);
  const legs: [number, number][][] = [];
  const legLen: number[] = [];
  let dir: [number, number] | null = null;
  while (chain.length < count) {
    const cur = chain[chain.length - 1];
    const cands: { name: string; p: NamedPoint; w: number }[] = [];
    for (const n of names) {
      if (used.has(n)) continue;
      for (const p of byName.get(n)!) {
        const d = Math.hypot(p.x - cur.x, p.z - cur.z);
        if (d < 280 || d > 1400) continue;
        let w = -Math.abs(d - 650) / 650;
        if (dir) {
          const dot = ((p.x - cur.x) * dir[0] + (p.z - cur.z) * dir[1]) / d;
          if (dot < 0.1) continue;
          w += dot;
        }
        cands.push({ name: n, p, w: w + rnd() * 0.6 });
      }
    }
    if (!cands.length) break;
    cands.sort((a, b) => b.w - a.w);
    let ok = false;
    for (const c of cands.slice(0, 4)) {
      const r = world.graph.route(cur.x, cur.z, c.p.x, c.p.z, mode, 20000);
      if (!r) continue;
      const straight = Math.hypot(c.p.x - cur.x, c.p.z - cur.z);
      if (r.len > straight * 2.6 + 300) continue;
      chain.push(c.p);
      used.add(c.name);
      legs.push(r.pts);
      legLen.push(r.len);
      dir = [(c.p.x - cur.x) / straight, (c.p.z - cur.z) / straight];
      ok = true;
      break;
    }
    if (!ok) break;
  }
  if (chain.length < 3) return null;
  return { stops: chain, legs, legLen, number: String(mode === 'tram' ? 1 + Math.floor(rnd() * 25) : 100 + Math.floor(rnd() * 99)), mode };
}

// --------------------------------------------------------------- autobus

interface Passenger {
  mesh: THREE.Object3D;
  stop: number;
  state: 'wait' | 'board' | 'ride' | 'alight' | 'gone';
  dest: number;
  t: number;
}

export class BusJob extends Job {
  kind = 'bus' as const;
  vehicle: VehicleType[] = ['autobus', 'meziměstský'];
  title: string;
  idx = 0; // příští zastávka
  schedule: number[] = [];
  startTime = -1;
  stopState: 'drive' | 'arrived' | 'boarding' = 'drive';
  boardT = 0;
  onboard = 0;
  penalties = 0;
  comfortEvents = 0;
  crashes = 0;
  delays: number[] = [];
  carried = 0;
  private pax: Passenger[] = [];
  private group = new THREE.Group();
  private comfortCool = 0;

  constructor(public line: PlannedLine, ctx: JobCtx) {
    super();
    const last = line.stops[line.stops.length - 1].name;
    if (line.mode === 'tram') this.vehicle = ['tramvaj'];
    if (line.mode === 'metro') this.vehicle = ['metro'];
    this.title = line.headsign
      ? `Linka ${line.number} (PID) směr ${line.headsign}: ${line.stops[0].name} → ${last}`
      : `Linka ${line.number}: ${line.stops[0].name} → ${last}`;
    if (line.times && line.times.length === line.stops.length) {
      // Skutečný jízdní řád PID (s rezervou na hráčovo seznamování s trasou).
      this.schedule = line.times.map((t) => Math.round((t * 1.15) / 30) * 30);
    } else {
      let t = 0;
      this.schedule.push(0);
      for (const len of line.legLen) {
        t += len / 8.5 + 25; // průměr ~30 km/h + čas na zastávce
        this.schedule.push(Math.round(t / 30) * 30);
      }
    }
    ctx.scene.add(this.group);
    // Cestující čekající na zastávkách.
    line.stops.forEach((s, i) => {
      if (i === line.stops.length - 1) return;
      const n = 1 + Math.floor(Math.random() * 5);
      for (let k = 0; k < n; k++) {
        const m = buildPerson([0x3a6ea5, 0xa53a3a, 0x3aa56e, 0x806040, 0x555555][k % 5]);
        this.group.add(m);
        const dest = i + 1 + Math.floor(Math.random() * (line.stops.length - 1 - i));
        this.pax.push({ mesh: m, stop: i, state: 'wait', dest, t: Math.random() * 6 });
      }
    });
  }

  target(): Waypoint | null {
    const s = this.line.stops[this.idx];
    return s ? { x: s.x, z: s.z, label: s.name } : null;
  }

  routeHint(): [number, number][] | null {
    if (this.idx === 0) return null;
    return this.line.legs[this.idx - 1] ?? null;
  }

  private placePax(ctx: JobCtx, dt: number) {
    const w = ctx.world;
    const v = ctx.vehicle;
    for (const p of this.pax) {
      if (p.state === 'gone' || p.state === 'ride') {
        p.mesh.visible = false;
        continue;
      }
      p.mesh.visible = true;
      const s = this.line.stops[p.state === 'alight' ? p.dest : p.stop];
      const ang = p.t * 1.7 + p.stop;
      let tx = s.x + Math.cos(ang) * 2.2;
      let tz = s.z + Math.sin(ang) * 2.2;
      if ((p.state === 'board' || p.state === 'alight') && v) {
        const [fx, fz] = v.forward();
        // Dveře vpravo u předku.
        const dx = v.x + fx * (v.spec.length / 2 - 1.2) + -fz * (v.spec.width / 2 + 0.5);
        const dz = v.z + fz * (v.spec.length / 2 - 1.2) + fx * (v.spec.width / 2 + 0.5);
        const k = p.state === 'board' ? Math.min(1, p.t / 2.5) : 1 - Math.min(1, p.t / 2.5);
        tx = tx + (dx - tx) * k;
        tz = tz + (dz - tz) * k;
        p.t += dt;
      }
      const y = ctx.yAt ? ctx.yAt(tx, tz) : w.groundHeight(tx, tz, 9999);
      w.toScene(tx, tz, p.mesh.position, Number.isNaN(y) ? 0 : y);
    }
  }

  update(dt: number, ctx: JobCtx) {
    const v = ctx.vehicle;
    this.placePax(ctx, dt);
    if (!v || !this.vehicle.includes(v.spec.type)) return;
    if (this.startTime < 0) this.startTime = ctx.clock;
    const now = ctx.clock - this.startTime;
    // Plynulost jízdy.
    this.comfortCool -= dt;
    if (this.comfortCool <= 0 && (v.accel < -4 || v.accel > 2.8 || Math.abs(v.latAccel) > 3)) {
      this.comfortEvents++;
      this.comfortCool = 2;
      ctx.notify('Cestující se zapotáceli – jeďte plynuleji', 'warn');
    }
    for (const imp of v.impacts) {
      if (imp.speed > 2) {
        this.crashes++;
        ctx.notify('Náraz! Cestující si stěžují.', 'warn');
      }
    }
    const s = this.line.stops[this.idx];
    if (!s) return;
    const [fx, fz] = v.forward();
    const doorX = v.x + fx * (v.spec.length / 2 - 1.2);
    const doorZ = v.z + fz * (v.spec.length / 2 - 1.2);
    const dist = Math.min(Math.hypot(doorX - s.x, doorZ - s.z), Math.hypot(v.x - s.x, v.z - s.z));
    if (this.stopState === 'drive') {
      if (dist < Math.max(28, v.spec.length / 2 + 6) && v.speed < 0.6) {
        this.stopState = 'arrived';
        ctx.notify(`Zastávka ${s.name}: otevřete dveře (O)`, 'info');
      }
    } else if (this.stopState === 'arrived') {
      if (dist > Math.max(35, v.spec.length / 2 + 12)) this.stopState = 'drive';
      if (v.doorsOpen) {
        this.stopState = 'boarding';
        this.boardT = 0;
        const delay = now - this.schedule[this.idx];
        this.delays.push(delay);
        for (const p of this.pax) {
          if (p.state === 'ride' && p.dest === this.idx) {
            p.state = 'alight';
            p.t = 0;
            this.onboard--;
          }
          if (p.state === 'wait' && p.stop === this.idx) {
            p.state = 'board';
            p.t = 0;
          }
        }
      }
    } else if (this.stopState === 'boarding') {
      this.boardT += dt;
      let busy = false;
      for (const p of this.pax) {
        if (p.state === 'board' && p.t >= 2.5) {
          p.state = 'ride';
          this.onboard++;
          this.carried++;
        } else if (p.state === 'alight' && p.t >= 2.5) {
          p.state = 'gone';
        }
        if (p.state === 'board' || p.state === 'alight') busy = true;
      }
      if (!v.doorsOpen) {
        if (busy) {
          ctx.notify('Zavřeli jste dveře cestujícím před nosem!', 'warn');
          this.penalties++;
          for (const p of this.pax) if (p.state === 'board') p.state = 'wait';
        }
        const early = now < this.schedule[this.idx] - 30;
        if (early) {
          ctx.notify('Odjezd před časem podle jízdního řádu', 'warn');
          this.penalties++;
        }
        ctx.chime();
        this.idx++;
        this.stopState = 'drive';
        if (ctx.model) updateSign(ctx.model, this.line.number, this.line.stops[this.line.stops.length - 1].name);
        if (this.idx >= this.line.stops.length) this.finish(ctx);
      } else if (this.idx === this.line.stops.length - 1 && !busy && this.boardT > 3) {
        this.idx++;
        this.finish(ctx);
      }
    }
    v.impacts.length = 0;
  }

  private finish(ctx: JobCtx) {
    const n = this.line.stops.length;
    const late = this.delays.filter((d) => d > 120).length;
    const punct = Math.max(0, 1 - late / n - this.penalties * 0.1);
    const comfort = Math.max(0, 1 - this.comfortEvents * 0.06 - this.crashes * 0.15 - this.speeding * 0.08);
    const score = 0.5 * punct + 0.5 * comfort;
    const km = this.line.legLen.reduce((a, b) => a + b, 0) / 1000;
    const pay = Math.round((n * 260 + km * 160 + this.carried * 20) * (0.4 + score * 0.9));
    const stars = Math.round(score * 5);
    let path: [number, number][] = [];
    for (const l of this.line.legs) path = path.concat(path.length ? l.slice(1) : l);
    this.result = {
      pay, xp: Math.round(40 + n * 10 * score),
      summary: [
        `Zastávek: ${n}, ujeto ${km.toFixed(1)} km, svezeno ${this.carried} cestujících`,
        `Přesnost: ${Math.round(punct * 100)} % (zpoždění nad 2 min: ${late}×)`,
        `Plynulost a předpisy: ${Math.round(comfort * 100)} % (prudké manévry ${this.comfortEvents}×, nárazy ${this.crashes}×, přestupky ${this.speeding}×)`,
        `Hodnocení: ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`,
      ],
      stats: { busStops: n, passengers: this.carried },
      line: {
        stops: this.line.stops.map((s) => ({ name: s.name, x: s.x, z: s.z, demand: 0 })),
        path: simplifyPath(path, 4), lengthKm: km, tripMin: Math.max(5, this.schedule[this.schedule.length - 1] / 60),
        number: this.line.number, name: `${this.line.stops[0].name} – ${this.line.stops[n - 1].name}`,
      },
    };
    this.done = true;
    void ctx;
  }

  action(ctx: JobCtx) {
    void ctx;
  }

  status(ctx: JobCtx): string {
    const s = this.line.stops[this.idx];
    if (!s) return 'Linka dokončena';
    const now = this.startTime < 0 ? 0 : ctx.clock - this.startTime;
    const due = this.schedule[this.idx];
    const rows = this.line.stops.map((st, i) => {
      const cls = i < this.idx ? 'past' : i === this.idx ? 'cur' : '';
      return `<li class="${cls}"><span>${fmtTime(this.schedule[i])}</span> ${escapeHtml(st.name)}</li>`;
    }).join('');
    const delay = now - due;
    const hint = this.stopState === 'arrived' ? 'Otevřete dveře (O)' : this.stopState === 'boarding' ? 'Nástup/výstup… pak zavřete dveře (O)' : `Jeďte na zastávku`;
    const v = ctx.vehicle;
    const wrongVeh = !v || !this.vehicle.includes(v.spec.type);
    return `<b>${escapeHtml(this.title)}</b><br>
      ${wrongVeh ? '<span class="warn">Nastupte do autobusu (G – garáž / přistavení)</span><br>' : ''}
      <span>${hint}</span><br>
      Čas jízdy ${fmtTime(now)} · odjezd ${fmtTime(due)} · <span class="${delay > 120 ? 'warn' : ''}">${this.startTime < 0 ? '' : signed(delay)}</span> · ve voze ${this.onboard}
      <ol class="stops">${rows}</ol>`;
  }

  dispose() {
    this.group.parent?.remove(this.group);
  }
}

// --------------------------------------------------------------- taxi

export class TaxiJob extends Job {
  kind = 'taxi' as const;
  vehicle: VehicleType[] = ['taxi', 'auto'];
  title: string;
  phase: 'pickup' | 'ride' = 'pickup';
  startRide = 0;
  rideLen = 0;
  eta = 0;
  comfortEvents = 0;
  waitT = 0;
  private person: THREE.Object3D;
  private comfortCool = 0;

  constructor(public from: NamedPoint & { street: string }, public to: NamedPoint & { street: string }, ctx: JobCtx) {
    super();
    this.title = `Taxi: ${to.street} ${to.name}`;
    this.person = buildPerson(0x7a4fa0);
    ctx.scene.add(this.person);
  }

  target(): Waypoint | null {
    const p = this.phase === 'pickup' ? this.from : this.to;
    return { x: p.x, z: p.z, label: `${p.street} ${p.name}` };
  }

  update(dt: number, ctx: JobCtx) {
    const v = ctx.vehicle;
    const w = ctx.world;
    if (this.phase === 'pickup') {
      const y = w.groundHeight(this.from.x, this.from.z, 9999);
      w.toScene(this.from.x, this.from.z, this.person.position, Number.isNaN(y) ? 0 : y);
      this.person.visible = true;
    } else this.person.visible = false;
    if (!v || !this.vehicle.includes(v.spec.type)) return;
    const t = this.target()!;
    const d = Math.hypot(v.x - t.x, v.z - t.z);
    if (this.phase === 'ride') {
      this.comfortCool -= dt;
      if (this.comfortCool <= 0 && (v.accel < -5 || v.accel > 3.5 || Math.abs(v.latAccel) > 4.5)) {
        this.comfortEvents++;
        this.comfortCool = 2;
        ctx.notify('Zákazník: „Opatrněji, prosím!“', 'warn');
      }
    }
    if (d < 30 && v.speed < 0.8) {
      this.waitT += dt;
      if (this.waitT > 1.5) {
        this.waitT = 0;
        if (this.phase === 'pickup') {
          this.phase = 'ride';
          this.startRide = ctx.clock;
          const r = w.graph.route(this.from.x, this.from.z, this.to.x, this.to.z, 'car');
          this.rideLen = r?.len ?? Math.hypot(this.to.x - this.from.x, this.to.z - this.from.z) * 1.3;
          this.eta = this.rideLen / 9 + 30;
          ctx.chime();
          ctx.notify(`Zákazník nastoupil. Cíl: ${this.to.street} ${this.to.name} (${(this.rideLen / 1000).toFixed(1)} km)`, 'ok');
        } else {
          const time = ctx.clock - this.startRide;
          const km = this.rideLen / 1000;
          const fare = Math.round(90 + km * 45 + time / 60 * 8);
          const tip = Math.max(0, Math.round(fare * (0.15 - this.comfortEvents * 0.05 - this.speeding * 0.05 + (time < this.eta ? 0.1 : -0.05))));
          this.result = {
            pay: fare + tip, xp: Math.round(20 + km * 8),
            summary: [
              `Jízdné ${fare} Kč za ${km.toFixed(1)} km (${fmtTime(time)}, odhad ${fmtTime(this.eta)})`,
              `Spropitné ${tip} Kč`,
            ],
            stats: { taxiRides: 1, passengers: 1 },
          };
          this.done = true;
        }
      }
    } else this.waitT = 0;
    v.impacts.length = 0;
  }

  status(ctx: JobCtx): string {
    const v = ctx.vehicle;
    const t = this.target()!;
    const d = v ? Math.hypot(v.x - t.x, v.z - t.z) : 0;
    const wrong = !v || !this.vehicle.includes(v.spec.type);
    return `<b>${this.phase === 'pickup' ? 'Vyzvedněte zákazníka' : 'Odvezte zákazníka'}</b><br>
      ${wrong ? '<span class="warn">Potřebujete auto nebo taxi</span><br>' : ''}
      ${escapeHtml(t.label)} · ${(d / 1000).toFixed(2)} km<br>
      ${this.phase === 'ride' ? `Taxametr: ${Math.round(60 + ((ctx.clock - this.startRide) / 60) * 6)} Kč + km` : 'Zastavte u adresy'}`;
  }

  dispose() {
    this.person.parent?.remove(this.person);
  }
}

// --------------------------------------------------------------- rozvoz

export class DeliveryJob extends Job {
  kind = 'delivery' as const;
  vehicle: VehicleType[] = ['dodávka', 'auto', 'taxi'];
  title = 'Rozvoz zásilek';
  idx = 0;
  start = -1;
  limit: number;
  holdT = 0;

  constructor(public drops: (NamedPoint & { street: string })[]) {
    super();
    let len = 0;
    for (let i = 1; i < drops.length; i++) len += Math.hypot(drops[i].x - drops[i - 1].x, drops[i].z - drops[i - 1].z);
    this.limit = Math.round((len * 1.5) / 8 + drops.length * 45 + 120);
  }

  target(): Waypoint | null {
    const d = this.drops[this.idx];
    return d ? { x: d.x, z: d.z, label: `${d.street} ${d.name}` } : null;
  }

  actionLabel(ctx: JobCtx): string | null {
    const t = this.target();
    const v = ctx.vehicle;
    if (!t || !v) return null;
    return Math.hypot(v.x - t.x, v.z - t.z) < 30 && v.speed < 0.8 ? 'Předat zásilku (E)' : null;
  }

  update(dt: number, ctx: JobCtx) {
    const v = ctx.vehicle;
    if (!v || !this.vehicle.includes(v.spec.type)) return;
    if (this.start < 0) this.start = ctx.clock;
    const t = this.target();
    if (!t) return;
    if (Math.hypot(v.x - t.x, v.z - t.z) < 30 && v.speed < 0.8) {
      this.holdT += dt;
      if (this.holdT > 2.5) {
        this.holdT = 0;
        this.idx++;
        ctx.chime();
        ctx.notify(`Doručeno (${this.idx}/${this.drops.length})`, 'ok');
        if (this.idx >= this.drops.length) {
          const time = ctx.clock - this.start;
          const inTime = time <= this.limit;
          const pay = Math.round(this.drops.length * 160 * (v.spec.type === 'dodávka' ? 1.3 : 1) + (inTime ? 400 : 0));
          this.result = {
            pay, xp: 15 * this.drops.length,
            summary: [`Doručeno ${this.drops.length} zásilek za ${fmtTime(time)} (limit ${fmtTime(this.limit)})`, inTime ? 'Bonus za včasné doručení 250 Kč' : 'Bez bonusu – pozdě'],
            stats: { deliveries: this.drops.length },
          };
          this.done = true;
        }
      }
    } else this.holdT = 0;
    v.impacts.length = 0;
  }

  status(ctx: JobCtx): string {
    const t = this.target();
    const v = ctx.vehicle;
    const left = this.start < 0 ? this.limit : this.limit - (ctx.clock - this.start);
    const d = t && v ? Math.hypot(v.x - t.x, v.z - t.z) : 0;
    return `<b>Rozvoz zásilek ${this.idx}/${this.drops.length}</b><br>
      ${t ? `${escapeHtml(t.label)} · ${(d / 1000).toFixed(2)} km` : ''}<br>
      Zbývá <span class="${left < 0 ? 'warn' : ''}">${left < 0 ? '−' : ''}${fmtTime(Math.abs(left))}</span> · zastavte u adresy na 3 s`;
  }
}

// --------------------------------------------------------------- nákladní doprava

export class FreightJob extends Job {
  kind = 'freight' as const;
  vehicle: VehicleType[] = ['kamion', 'dodávka'];
  title: string;
  start = -1;
  holdT = 0;
  km: number;
  /** Trasa po silnicích přes celou republiku (OSRM), světové souřadnice. */
  longRoute: [number, number][] | null = null;

  constructor(public dest: { name: string; x: number; z: number }, public cargo: string, fromX: number, fromZ: number) {
    super();
    this.km = (Math.hypot(dest.x - fromX, dest.z - fromZ) * 1.25) / 1000;
    this.title = `Náklad: ${cargo} → ${dest.name}`;
  }

  target(): Waypoint | null {
    return { x: this.dest.x, z: this.dest.z, label: this.dest.name };
  }

  update(dt: number, ctx: JobCtx) {
    const v = ctx.vehicle;
    if (!v || !this.vehicle.includes(v.spec.type)) return;
    if (this.start < 0) this.start = ctx.clock;
    const d = Math.hypot(v.x - this.dest.x, v.z - this.dest.z);
    if (d < 350 && v.speed < 0.8) {
      this.holdT += dt;
      if (this.holdT > 3) {
        const time = ctx.clock - this.start;
        const limit = (this.km / 60) * 3600 + 300; // průměr 60 km/h + rezerva
        const inTime = time <= limit;
        const truck = v.spec.type === 'kamion';
        const pay = Math.round((400 + this.km * (truck ? 95 : 60)) * (inTime ? 1.15 : 0.85));
        this.result = {
          pay, xp: Math.round(30 + this.km * 3),
          summary: [
            `Doručeno do ${this.dest.name}: ${this.cargo}`,
            `Vzdálenost cca ${this.km.toFixed(0)} km za ${fmtTime(time)} (limit ${fmtTime(limit)})`,
            inTime ? 'Včas – příplatek 15 %' : 'Pozdě – srážka 15 %',
          ],
          stats: { deliveries: 1 },
        };
        this.done = true;
      }
    } else this.holdT = 0;
    v.impacts.length = 0;
  }

  status(ctx: JobCtx): string {
    const v = ctx.vehicle;
    const d = v ? Math.hypot(v.x - this.dest.x, v.z - this.dest.z) : 0;
    const wrong = !v || !this.vehicle.includes(v.spec.type);
    const time = this.start < 0 ? 0 : ctx.clock - this.start;
    return `<b>${escapeHtml(this.title)}</b><br>
      ${wrong ? '<span class="warn">Potřebujete nákladní auto nebo dodávku</span><br>' : ''}
      Zbývá ${(d / 1000).toFixed(1)} km vzdušnou čarou · na cestě ${fmtTime(time)}<br>
      <span class="muted">${this.longRoute ? `Trasa ${this.km.toFixed(0)} km po silnicích je na minimapě.` : 'Hledám trasu…'} Zastavte v cíli (do 350 m).</span>`;
  }
}

const CARGO = ['stavební materiál', 'potraviny', 'nábytek', 'pivo', 'dřevo', 'autodíly', 'elektronika', 'zemědělské stroje', 'papír', 'nápoje'];

/** Zakázka do jiného města 15–80 km daleko. */
export function freightOffer(x: number, z: number): Offer | null {
  const cands = CITIES.map((c) => ({ c, p: lonLatToWorld(c.lon, c.lat) }))
    .map((o) => ({ ...o, d: Math.hypot(o.p.x - x, o.p.z - z) }))
    .filter((o) => o.d > 15000 && o.d < 80000);
  if (!cands.length) return null;
  const o = cands[Math.floor(Math.random() * cands.length)];
  const cargo = CARGO[Math.floor(Math.random() * CARGO.length)];
  const km = (o.d * 1.25) / 1000;
  const name = o.c.name.split(' – ')[0].split(' (')[0];
  void worldToLonLat;
  return {
    kind: 'freight',
    title: `🚛 ${cargo} → ${name}`,
    detail: `cca ${km.toFixed(0)} km · nákladní auto (dodávka za nižší odměnu)`,
    estPay: Math.round(400 + km * 95),
    make: () => new FreightJob({ name, x: o.p.x, z: o.p.z }, cargo, x, z),
  };
}

// --------------------------------------------------------------- nabídky

export interface Offer {
  kind: 'bus' | 'taxi' | 'delivery' | 'tram' | 'metro' | 'freight';
  title: string;
  detail: string;
  estPay: number;
  make(ctx: JobCtx): Job;
}

function addressWithStreet(world: World, p: NamedPoint): NamedPoint & { street: string } {
  return { ...p, street: world.streetName(p.x, p.z) ?? 'č.p.' };
}

export function generateOffers(world: World, x: number, z: number): Offer[] {
  const offers: Offer[] = [];
  // Metro: skutečné linky A, B, C z PID.
  for (const line of planPidLines(world, x, z, 2, 'metro')) {
    const km = line.legLen.reduce((a, b) => a + b, 0) / 1000;
    offers.push({
      kind: 'metro',
      title: `🚇 ${line.number} → ${line.headsign}: ${line.stops[0].name} → ${line.stops[line.stops.length - 1].name}`,
      detail: `metro · ${line.stops.length} stanic · ${km.toFixed(1)} km · pod zemí`,
      estPay: Math.round((line.stops.length * 320 + km * 180 + 150) * 1.2),
      make: (ctx) => new BusJob(line, ctx),
    });
  }
  // Tramvaje: skutečné linky PID, jinde linky z tramvajových zastávek OSM.
  const trams = planPidLines(world, x, z, 2, 'tram');
  if (!trams.length) {
    const t = planBusLine(world, x, z, 7, Math.random, 'tram');
    if (t) trams.push(t as never);
  }
  for (const line of trams as PlannedLine[]) {
    const km = line.legLen.reduce((a, b) => a + b, 0) / 1000;
    offers.push({
      kind: 'tram',
      title: `🚋 ${line.number}${line.headsign ? ` → ${line.headsign}` : ''}: ${line.stops[0].name} → ${line.stops[line.stops.length - 1].name}`,
      detail: `${line.headsign ? 'skutečná linka PID' : 'tramvajová linka'} · ${line.stops.length} zastávek · ${km.toFixed(1)} km · tramvaj`,
      estPay: Math.round((line.stops.length * 260 + km * 160 + 100) * 1.2),
      make: (ctx) => new BusJob(line, ctx),
    });
  }
  // Skutečné linky PID (Praha a Středočeský kraj).
  for (const line of planPidLines(world, x, z, 3, 'bus')) {
    const km = line.legLen.reduce((a, b) => a + b, 0) / 1000;
    offers.push({
      kind: 'bus',
      title: `🚏 ${line.number} → ${line.headsign}: ${line.stops[0].name} → ${line.stops[line.stops.length - 1].name}`,
      detail: `skutečná linka PID · ${line.stops.length} zastávek · ${km.toFixed(1)} km · jízdní řád ${Math.round(line.times[line.times.length - 1] / 60)} min`,
      estPay: Math.round((line.stops.length * 260 + km * 160 + 100) * 1.15),
      make: (ctx) => new BusJob(line, ctx),
    });
  }
  const pidBus = offers.filter((o) => o.kind === 'bus').length;
  for (let i = 0; i < (pidBus ? 1 : 3); i++) {
    const line = planBusLine(world, x, z, 5 + i * 2);
    if (!line) break;
    if (offers.some((o) => o.title.includes(line.stops[0].name) && o.title.includes(line.stops[line.stops.length - 1].name))) continue;
    const km = line.legLen.reduce((a, b) => a + b, 0) / 1000;
    offers.push({
      kind: 'bus',
      title: `Autobus ${line.number}: ${line.stops[0].name} → ${line.stops[line.stops.length - 1].name}`,
      detail: `${line.stops.length} zastávek · ${km.toFixed(1)} km · městský autobus`,
      estPay: Math.round(line.stops.length * 260 + km * 160 + 100),
      make: (ctx) => new BusJob(line, ctx),
    });
  }
  const addrs = world.allAddresses();
  if (addrs.length > 20) {
    for (let i = 0; i < 2; i++) {
      const near = addrs.filter((a) => {
        const d = Math.hypot(a.x - x, a.z - z);
        return d > 150 && d < 900;
      });
      if (!near.length) break;
      const from = near[Math.floor(Math.random() * near.length)];
      const far = addrs.filter((a) => {
        const d = Math.hypot(a.x - from.x, a.z - from.z);
        return d > 1200 && d < 4000;
      });
      if (!far.length) break;
      const to = far[Math.floor(Math.random() * far.length)];
      const f = addressWithStreet(world, from);
      const t = addressWithStreet(world, to);
      const km = Math.hypot(to.x - from.x, to.z - from.z) * 1.3 / 1000;
      offers.push({
        kind: 'taxi',
        title: `Taxi: ${f.street} ${f.name} → ${t.street} ${t.name}`,
        detail: `cca ${km.toFixed(1)} km · osobní auto nebo taxi`,
        estPay: Math.round(90 + km * 50),
        make: (ctx) => new TaxiJob(f, t, ctx),
      });
    }
    const pool = addrs.filter((a) => Math.hypot(a.x - x, a.z - z) < 1800);
    if (pool.length > 10) {
      const n = 5 + Math.floor(Math.random() * 3);
      const drops: (NamedPoint & { street: string })[] = [];
      let cx = x, cz = z;
      const left = [...pool];
      for (let i = 0; i < n && left.length; i++) {
        // Další adresa: náhodná z blízkých (300–900 m).
        const c = left.filter((a) => {
          const d = Math.hypot(a.x - cx, a.z - cz);
          return d > 250 && d < 900;
        });
        const pick = (c.length ? c : left)[Math.floor(Math.random() * (c.length || left.length))];
        left.splice(left.indexOf(pick), 1);
        drops.push(addressWithStreet(world, pick));
        cx = pick.x;
        cz = pick.z;
      }
      offers.push({
        kind: 'delivery',
        title: `Rozvoz: ${drops.length} zásilek po okolí`,
        detail: 'dodávka (s osobním autem nižší výdělek)',
        estPay: drops.length * 180 + 400,
        make: () => new DeliveryJob(drops),
      });
    }
  }
  const fr = freightOffer(x, z);
  if (fr) offers.push(fr);
  return offers;
}

export function simplifyPath(p: [number, number][], tol: number): [number, number][] {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let md = 0;
    let mi = -1;
    const ax = p[a][0], az = p[a][1], bx = p[b][0], bz = p[b][1];
    const dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((p[i][0] - ax) * dz - (p[i][1] - az) * dx) / l;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > tol && mi > 0) {
      keep[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export { RoadGraph };
