// Ze dat PID GTFS (Pražská integrovaná doprava) vyrobí kompaktní public/pid.json
// se skutečnými autobusovými a trolejbusovými linkami: pořadí zastávek, souřadnice
// a jízdní doby. Spouští se v CI před sestavením; bez dat hra funguje dál bez linek PID.
//
// Použití: node scripts/build-pid.mjs <složka s rozbaleným GTFS> <výstup.json>

import fs from 'node:fs';
import readline from 'node:readline';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error('Použití: node scripts/build-pid.mjs <gtfs-složka> <výstup.json>');
  process.exit(1);
}

function parseLine(line) {
  const res = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { res.push(cur); cur = ''; }
    else cur += c;
  }
  res.push(cur);
  return res;
}

async function* rows(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(`${dir}/${file}`), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line) continue;
    const cols = parseLine(line.replace(/^﻿/, ''));
    if (!head) { head = cols; continue; }
    const o = {};
    head.forEach((h, i) => (o[h] = cols[i]));
    yield o;
  }
}

const routes = new Map();
for await (const r of rows('routes.txt')) {
  const t = Number(r.route_type);
  if (t !== 3 && t !== 11 && t !== 0) continue; // autobus, trolejbus, tramvaj
  if (r.is_substitute_transport === '1') continue;
  routes.set(r.route_id, { n: r.route_short_name, l: r.route_long_name, t, night: r.is_night === '1', reg: r.is_regional === '1' });
}
const trips = new Map();
const perRoute = new Map();
for await (const t of rows('trips.txt')) {
  if (!routes.has(t.route_id)) continue;
  trips.set(t.trip_id, { r: t.route_id, d: t.direction_id, h: t.trip_headsign, svc: t.service_id });
  perRoute.set(t.route_id, (perRoute.get(t.route_id) ?? 0) + 1);
}
// 1. průchod: počet zastávek každého spoje.
const count = new Map();
for await (const s of rows('stop_times.txt')) {
  if (trips.has(s.trip_id)) count.set(s.trip_id, (count.get(s.trip_id) ?? 0) + 1);
}
// Pro každou linku a směr nejdelší spoj.
const pick = new Map();
for (const [id, n] of count) {
  const t = trips.get(id);
  const k = `${t.r}|${t.d}`;
  const p = pick.get(k);
  if (!p || n > p.n) pick.set(k, { id, n });
}
const wanted = new Set([...pick.values()].map((p) => p.id));
// 2. průchod: zastávky vybraných spojů.
const seq = new Map();
const toMin = (s) => {
  const [h, m, sec] = s.split(':').map(Number);
  return h * 60 + m + sec / 60;
};
for await (const s of rows('stop_times.txt')) {
  if (!wanted.has(s.trip_id)) continue;
  let l = seq.get(s.trip_id);
  if (!l) seq.set(s.trip_id, (l = []));
  l.push({ seq: Number(s.stop_sequence), stop: s.stop_id, t: toMin(s.departure_time || s.arrival_time) });
}
const stopsNeeded = new Set();
for (const l of seq.values()) for (const x of l) stopsNeeded.add(x.stop);
const stopIdx = new Map();
const stopsOut = [];
for await (const s of rows('stops.txt')) {
  if (!stopsNeeded.has(s.stop_id)) continue;
  stopIdx.set(s.stop_id, stopsOut.length);
  stopsOut.push([s.stop_name, Number(Number(s.stop_lat).toFixed(5)), Number(Number(s.stop_lon).toFixed(5))]);
}
const lines = [];
for (const [rid, r] of routes) {
  const dirs = [];
  for (const d of ['0', '1']) {
    const p = pick.get(`${rid}|${d}`);
    if (!p) continue;
    const l = seq.get(p.id).sort((a, b) => a.seq - b.seq);
    const t0 = l[0].t;
    dirs.push({
      h: trips.get(p.id).h,
      s: l.map((x) => stopIdx.get(x.stop)),
      m: l.map((x) => Math.round((x.t - t0) * 10) / 10),
    });
  }
  if (dirs.length) lines.push({ n: r.n, l: r.l, t: r.t, night: r.night ? 1 : 0, reg: r.reg ? 1 : 0, f: perRoute.get(rid) ?? 0, d: dirs });
}
lines.sort((a, b) => a.n.localeCompare(b.n, 'cs', { numeric: true }));
const json = JSON.stringify({ generated: new Date().toISOString(), source: 'PID GTFS (data.pid.cz), CC BY 4.0', stops: stopsOut, lines });
fs.writeFileSync(out, json);
console.log(`PID: ${lines.length} linek, ${stopsOut.length} zastávek, ${(json.length / 1024).toFixed(0)} kB`);
