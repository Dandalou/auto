// Souřadnicový systém hry.
//
// Svět je Web Mercator na zoomu 14 přeškálovaný na metry pevným faktorem cos(LAT0).
// Díky pevnému faktoru má každá dlaždice z14 stejnou velikost (~1579 m) a v rámci
// Česka je chyba vůči skutečným metrům do ±2 %. Výšky jsou ve skutečných metrech.
//
// Osy: X = východ, Z = jih (směr růstu y v dlaždicích), Y = nahoru.

export const Z = 14;
export const LAT0 = 49.8;
const R = 6378137;
export const K = Math.cos((LAT0 * Math.PI) / 180);
/** Velikost dlaždice z14 ve světových metrech. */
export const TILE_M = ((2 * Math.PI * R) / 2 ** Z) * K;

export interface WorldPos {
  x: number;
  z: number;
}

export function lonLatToWorld(lon: number, lat: number): WorldPos {
  const n = 2 ** Z;
  const tx = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const ty = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x: tx * TILE_M, z: ty * TILE_M };
}

export function worldToLonLat(x: number, z: number): { lon: number; lat: number } {
  const n = 2 ** Z;
  const tx = x / TILE_M;
  const ty = z / TILE_M;
  const lon = (tx / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return { lon, lat };
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Hrubý obrys ČR (lon, lat) pro velkou mapu a kontrolu, zda jsme v republice. */
export const CZ_OUTLINE: [number, number][] = [
  [12.09, 50.25], [12.26, 50.06], [12.5, 49.97], [12.4, 49.76], [12.52, 49.69], [12.67, 49.43],
  [13.03, 49.3], [13.4, 49.04], [13.61, 48.95], [13.84, 48.77], [14.06, 48.66], [14.33, 48.56],
  [14.7, 48.58], [14.95, 48.77], [15.16, 48.99], [15.54, 48.91], [16.05, 48.75], [16.54, 48.8],
  [16.94, 48.62], [17.1, 48.82], [17.54, 48.8], [17.89, 48.9], [18.1, 49.07], [18.17, 49.27],
  [18.4, 49.32], [18.55, 49.5], [18.85, 49.52], [18.58, 49.91], [18.27, 49.96], [17.87, 49.98],
  [17.65, 50.1], [17.73, 50.32], [17.19, 50.38], [16.9, 50.45], [16.69, 50.1], [16.45, 50.32],
  [16.21, 50.43], [16.43, 50.58], [16.0, 50.6], [15.85, 50.68], [15.38, 50.79], [15.27, 50.98],
  [14.98, 51.0], [14.82, 50.87], [14.62, 50.92], [14.32, 51.05], [14.25, 50.88], [13.9, 50.79],
  [13.55, 50.71], [13.32, 50.6], [13.03, 50.5], [12.78, 50.44], [12.51, 50.4], [12.33, 50.24],
  [12.09, 50.25],
];

export interface City {
  name: string;
  lon: number;
  lat: number;
}

/** Krajská a další větší města – rychlý teleport a orientace na velké mapě. */
export const CITIES: City[] = [
  { name: 'Praha – Staroměstské nám.', lon: 14.4205, lat: 50.0875 },
  { name: 'Brno – nám. Svobody', lon: 16.6083, lat: 49.1951 },
  { name: 'Ostrava – Masarykovo nám.', lon: 18.2925, lat: 49.8355 },
  { name: 'Plzeň – nám. Republiky', lon: 13.3777, lat: 49.7476 },
  { name: 'Liberec', lon: 15.0566, lat: 50.7698 },
  { name: 'Olomouc', lon: 17.2513, lat: 49.5937 },
  { name: 'České Budějovice', lon: 14.4744, lat: 48.9746 },
  { name: 'Hradec Králové', lon: 15.8327, lat: 50.2092 },
  { name: 'Ústí nad Labem', lon: 14.0323, lat: 50.6607 },
  { name: 'Pardubice', lon: 15.7781, lat: 50.0381 },
  { name: 'Zlín', lon: 17.6667, lat: 49.2265 },
  { name: 'Jihlava', lon: 15.5911, lat: 49.3961 },
  { name: 'Karlovy Vary', lon: 12.8712, lat: 50.2306 },
  { name: 'Český Krumlov', lon: 14.3155, lat: 48.8106 },
  { name: 'Kutná Hora', lon: 15.2683, lat: 49.9484 },
  { name: 'Telč', lon: 15.4527, lat: 49.1842 },
  { name: 'Třebíč', lon: 15.8809, lat: 49.2149 },
  { name: 'Tábor', lon: 14.6578, lat: 49.4144 },
  { name: 'Opava', lon: 17.9047, lat: 49.9387 },
  { name: 'Kladno', lon: 14.1031, lat: 50.1473 },
  { name: 'Sněžka (Pec pod Sněžkou)', lon: 15.7287, lat: 50.6927 },
  { name: 'Lipno nad Vltavou', lon: 14.2213, lat: 48.6366 },
  { name: 'Karlštejn', lon: 14.1855, lat: 49.9339 },
  { name: 'Hřensko', lon: 14.2422, lat: 50.8752 },
];

export function pointInOutline(lon: number, lat: number): boolean {
  let inside = false;
  const p = CZ_OUTLINE;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
