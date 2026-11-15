// Uložená hra: kariéra, garáž, deník, firma a nastavení. Ukládá se do localStorage.

import type { VehicleType } from './vehicle';
import type { Season, Weather } from '../world/environment';

export interface Visited {
  name: string;
  cls: string;
  x: number;
  z: number;
  t: number;
}

export interface LineStop {
  name: string;
  x: number;
  z: number;
  demand: number;
}

export interface CompanyLine {
  id: number;
  number: string;
  name: string;
  kind: 'bus' | 'taxi' | 'delivery';
  stops: LineStop[];
  /** Trasa (x, z) – zjednodušená. */
  path: [number, number][];
  lengthKm: number;
  /** Doba jedné jízdy v minutách. */
  tripMin: number;
  fare: number;
  vehicles: number[];
  depot: number;
}

export interface CompanyVehicle {
  id: number;
  type: VehicleType;
  condition: number; // 0..1
  km: number;
  bought: number;
  broken: number; // zbývající hodiny opravy
  depot: number;
}

export interface Driver {
  id: number;
  name: string;
  skill: number; // 0..1
  wage: number; // Kč / h
  vehicle: number | null;
  hired: number;
  mood: number;
}

export interface Depot {
  id: number;
  name: string;
  x: number;
  z: number;
  capacity: number;
}

export interface LedgerRow {
  hour: number;
  income: number;
  costs: number;
  passengers: number;
}

export interface Company {
  name: string;
  founded: number;
  hour: number;
  reputation: number; // 0..1
  loan: number;
  depots: Depot[];
  vehicles: CompanyVehicle[];
  drivers: Driver[];
  lines: CompanyLine[];
  ledger: LedgerRow[];
  nextId: number;
  log: string[];
}

export interface Settings {
  quality: string;
  season: Season;
  /** Počasí, nebo 'skutečné' podle Open-Meteo. */
  weather: Weather | 'skutečné';
  time: number;
  /** Herní minuty za sekundu; -1 = skutečný čas. */
  timeSpeed: number;
  sound: boolean;
  camera: number;
}

export interface Stats {
  distance: number;
  jobs: number;
  busStops: number;
  passengers: number;
  taxiRides: number;
  deliveries: number;
  crashes: number;
  earned: number;
}

export interface SaveState {
  version: 1;
  pos: { x: number; z: number; heading: number };
  vehicle: VehicleType;
  walking: boolean;
  money: number;
  xp: number;
  garage: VehicleType[];
  stats: Stats;
  visited: Record<string, Visited>;
  company: Company | null;
  settings: Settings;
  tutorialDone: boolean;
}

const KEY = 'cesko-na-kolech-save-v1';

export function defaultState(x: number, z: number): SaveState {
  return {
    version: 1,
    pos: { x, z, heading: 0 },
    vehicle: 'auto',
    walking: false,
    money: 40000,
    xp: 0,
    garage: ['auto'],
    stats: { distance: 0, jobs: 0, busStops: 0, passengers: 0, taxiRides: 0, deliveries: 0, crashes: 0, earned: 0 },
    visited: {},
    company: null,
    settings: { quality: 'střední', season: 'léto', weather: 'skutečné', time: 10.5, timeSpeed: -1, sound: true, camera: 0 },
    tutorialDone: false,
  };
}

export function loadState(): SaveState | null {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return null;
    const v = JSON.parse(s) as SaveState;
    if (v.version !== 1) return null;
    return v;
  } catch {
    return null;
  }
}

export function saveState(s: SaveState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* plné úložiště nebo soukromé okno */
  }
}

export function clearState() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nic */
  }
}

export function level(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

export function formatMoney(v: number): string {
  return `${Math.round(v).toLocaleString('cs-CZ')} Kč`;
}
