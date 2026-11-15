// Management: vlastní dopravní firma. Depa, vozidla, řidiči, linky na skutečných
// zastávkách, poptávka odvozená z obestavěného prostoru budov kolem zastávek (data OSM).

import type { World } from '../world/world';
import { SPECS, type VehicleType } from './vehicle';
import type { Company, CompanyLine, CompanyVehicle, Driver, LineStop } from './state';

const FIRST = ['Jan', 'Petr', 'Jiří', 'Pavel', 'Martin', 'Tomáš', 'Lukáš', 'Jana', 'Eva', 'Hana', 'Lenka', 'Kateřina', 'Marie', 'David', 'Ondřej', 'Veronika', 'Michal', 'Zdeněk', 'Alena', 'Karel'];
const LAST = ['Novák', 'Svoboda', 'Novotný', 'Dvořák', 'Černý', 'Procházka', 'Kučera', 'Veselý', 'Horák', 'Němec', 'Pokorný', 'Marek', 'Pospíšil', 'Hájek', 'Král', 'Jelínek', 'Růžička', 'Beneš', 'Fiala', 'Sedláček'];

export const FOUND_COST = 120000;
export const DEPOT_COST = 1500000;

export function newCompany(name: string, x: number, z: number, place: string): Company {
  return {
    name, founded: Date.now(), hour: 0, reputation: 0.5, loan: 0,
    depots: [{ id: 1, name: place, x, z, capacity: 6 }],
    vehicles: [], drivers: [], lines: [], ledger: [], nextId: 2,
    log: [`Firma ${name} založena v ${place}.`],
  };
}

export function candidates(seed: number): Driver[] {
  let s = seed;
  const r = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  return Array.from({ length: 4 }, (_, i) => {
    const skill = 0.35 + r() * 0.6;
    const f = FIRST[Math.floor(r() * FIRST.length)];
    let l = LAST[Math.floor(r() * LAST.length)];
    if (['Jana', 'Eva', 'Hana', 'Lenka', 'Kateřina', 'Marie', 'Veronika', 'Alena'].includes(f)) {
      l = l.endsWith('ý') ? `${l.slice(0, -1)}á` : l.endsWith('a') ? `${l.slice(0, -1)}ová` : `${l}ová`;
    }
    return {
      id: -(i + 1), name: `${f} ${l}`, skill, wage: Math.round(190 + skill * 160), vehicle: null, hired: 0, mood: 0.8,
    };
  });
}

/** Poptávka (cestujících za hodinu) u zastávky podle zástavby v okolí 350 m. */
export function stopDemand(world: World, x: number, z: number): number {
  const vol = world.buildingVolume(x, z, 350);
  return Math.round(Math.min(320, 6 + Math.sqrt(vol) / 14));
}

export function addLine(c: Company, world: World, data: { stops: LineStop[]; path: [number, number][]; lengthKm: number; tripMin: number; number: string; name: string }): CompanyLine {
  const stops = data.stops.map((s) => ({ ...s, demand: s.demand || stopDemand(world, s.x, s.z) }));
  // Nejbližší depo.
  let depot = c.depots[0];
  for (const d of c.depots) {
    if (Math.hypot(d.x - stops[0].x, d.z - stops[0].z) < Math.hypot(depot.x - stops[0].x, depot.z - stops[0].z)) depot = d;
  }
  const line: CompanyLine = {
    id: c.nextId++, number: data.number, name: data.name, kind: 'bus', stops, path: data.path,
    lengthKm: data.lengthKm, tripMin: data.tripMin, fare: 24, vehicles: [], depot: depot.id,
  };
  c.lines.push(line);
  c.log.unshift(`Nová linka ${line.number} ${line.name} (${stops.length} zastávek).`);
  return line;
}

export function nearestDepotDist(c: Company, x: number, z: number): number {
  return Math.min(...c.depots.map((d) => Math.hypot(d.x - x, d.z - z)));
}

export function buyVehicle(c: Company, type: VehicleType, depot: number): CompanyVehicle {
  const v: CompanyVehicle = { id: c.nextId++, type, condition: 1, km: 0, bought: Date.now(), broken: 0, depot };
  c.vehicles.push(v);
  c.log.unshift(`Koupeno vozidlo: ${SPECS[type].name} (#${v.id}).`);
  return v;
}

export function sellValue(v: CompanyVehicle): number {
  return Math.round(SPECS[v.type].price * (0.35 + 0.4 * v.condition) * Math.max(0.3, 1 - v.km / 600000));
}

export interface HourResult {
  income: number;
  costs: number;
  passengers: number;
  events: string[];
}

/**
 * Simulace jedné provozní hodiny firmy. Volá se každých 30 s reálného času.
 */
export function simulateHour(c: Company): HourResult {
  const res: HourResult = { income: 0, costs: 0, passengers: 0, events: [] };
  c.hour++;
  const hourOfDay = c.hour % 24;
  // Denní profil poptávky (špičky ráno a odpoledne, v noci minimum).
  const profile = [0.05, 0.03, 0.02, 0.02, 0.08, 0.35, 0.9, 1.2, 1.0, 0.7, 0.6, 0.65, 0.7, 0.75, 0.9, 1.1, 1.15, 0.9, 0.7, 0.5, 0.35, 0.25, 0.15, 0.08][hourOfDay];
  const night = hourOfDay < 5 || hourOfDay >= 23;
  for (const line of c.lines) {
    const vehs = line.vehicles.map((id) => c.vehicles.find((v) => v.id === id)).filter((v): v is CompanyVehicle => !!v);
    const active = vehs.filter((v) => v.broken <= 0 && c.drivers.some((d) => d.vehicle === v.id));
    if (!active.length || night) continue;
    const demand = line.stops.reduce((a, s) => a + s.demand, 0) * profile * (0.6 + c.reputation * 0.8) * Math.pow(24 / line.fare, 0.7);
    // Frekvence: víc vozů = kratší interval = vyšší využití poptávky (s klesajícím výnosem).
    const tripsPerHour = active.length * (60 / (line.tripMin * 2 + 8));
    const capacity = active.reduce((a, v) => a + SPECS[v.type].seats, 0) * (60 / (line.tripMin * 2 + 8)) * 2;
    const captured = demand * (1 - Math.exp(-tripsPerHour / 3));
    const pax = Math.round(Math.min(capacity, captured));
    res.passengers += pax;
    res.income += pax * line.fare;
    const km = tripsPerHour * line.lengthKm * 2;
    res.costs += km * 14; // nafta
    for (const v of active) {
      const share = km / active.length;
      v.km += share;
      v.condition = Math.max(0, v.condition - share / 40000);
      if (Math.random() < (1 - v.condition) * 0.03) {
        v.broken = 3 + Math.floor(Math.random() * 6);
        res.costs += 4000 + Math.round((1 - v.condition) * 20000);
        res.events.push(`Porucha vozu #${v.id} na lince ${line.number}.`);
        c.reputation = Math.max(0, c.reputation - 0.02);
      }
    }
    // Reputace podle kvality řidičů a naplněnosti.
    const skill = c.drivers.filter((d) => active.some((v) => v.id === d.vehicle)).reduce((a, d) => a + d.skill, 0) / active.length;
    const crowd = captured > capacity ? -0.004 : 0.001;
    c.reputation = Math.min(1, Math.max(0, c.reputation + (skill - 0.6) * 0.004 + crowd));
  }
  for (const v of c.vehicles) {
    if (v.broken > 0) v.broken--;
    res.costs += SPECS[v.type].price * 0.00004; // pojištění, parkování
  }
  for (const d of c.drivers) {
    const working = d.vehicle !== null && !night;
    res.costs += working ? d.wage : 0;
    d.skill = Math.min(1, d.skill + (working ? 0.0004 : 0));
  }
  for (const dp of c.depots) res.costs += dp.capacity * 30;
  if (c.loan > 0) res.costs += c.loan * 0.00001;
  res.income = Math.round(res.income);
  res.costs = Math.round(res.costs);
  c.ledger.push({ hour: c.hour, income: res.income, costs: res.costs, passengers: res.passengers });
  if (c.ledger.length > 24 * 14) c.ledger.shift();
  for (const e of res.events) c.log.unshift(e);
  if (c.log.length > 60) c.log.length = 60;
  return res;
}

export function companyValue(c: Company): number {
  return c.vehicles.reduce((a, v) => a + sellValue(v), 0) + c.depots.length * DEPOT_COST * 0.6 - c.loan;
}
