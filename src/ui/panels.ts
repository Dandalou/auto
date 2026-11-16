// Panely: práce, garáž, firma, mapa, deník, nastavení, nápověda.

import { CITIES, CZ_OUTLINE, lonLatToWorld, pointInOutline, worldToLonLat } from '../geo';
import type { Game } from '../game/game';
import {
  addLine, buyVehicle, candidates, companyValue, DEPOT_COST, FOUND_COST, nearestDepotDist, newCompany, sellValue, stopDemand,
} from '../game/company';
import { planPidLines } from '../game/pid';
import { escapeHtml, generateOffers, planBusLine, simplifyPath, type JobResult, type Offer } from '../game/jobs';
import { clearState, formatMoney, level } from '../game/state';
import { SPECS, type VehicleType } from '../game/vehicle';
import { QUALITY } from '../world/world';
import type { Season, Weather } from '../world/environment';

let current: string | null = null;
let offers: Offer[] = [];
let offersAt = { x: 0, z: 0, t: 0 };
let companyTab = 'přehled';
let hireSeed = 12345;

const $ = (id: string) => document.getElementById(id)!;

export function currentPanel(): string | null {
  return current;
}

export function closePanel() {
  current = null;
  $('modal').classList.add('hidden');
}

$('modal-close').addEventListener('click', closePanel);
$('modal').addEventListener('pointerdown', (e) => {
  if (e.target === $('modal')) closePanel();
});

function show(name: string, html: string) {
  current = name;
  $('modal-body').innerHTML = html;
  $('modal').classList.remove('hidden');
}

function on(sel: string, fn: (el: HTMLElement) => void) {
  document.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener('click', () => fn(el)));
}

export function openPanel(g: Game, name: string, refresh = false) {
  if (refresh && current !== name) return;
  const scroll = refresh ? (document.querySelector('.modal-box') as HTMLElement)?.scrollTop ?? 0 : 0;
  switch (name) {
    case 'jobs': jobsPanel(g); break;
    case 'garage': garagePanel(g); break;
    case 'company': companyPanel(g); break;
    case 'map': mapPanel(g); break;
    case 'journal': journalPanel(g); break;
    case 'settings': settingsPanel(g); break;
    case 'help': helpPanel(g, false); break;
    case 'welcome': helpPanel(g, true); break;
  }
  if (refresh) (document.querySelector('.modal-box') as HTMLElement).scrollTop = scroll;
}

// ------------------------------------------------------------ práce

function jobsPanel(g: Game) {
  if (!g.ready) return;
  const d = Math.hypot(offersAt.x - g.px, offersAt.z - g.pz);
  if (!offers.length || d > 500 || performance.now() - offersAt.t > 120000) {
    offers = generateOffers(g.world, g.px, g.pz);
    offersAt = { x: g.px, z: g.pz, t: performance.now() };
  }
  const own = (t: VehicleType[]) => t.some((v) => g.state.garage.includes(v));
  const needs: Record<string, VehicleType[]> = { bus: ['autobus', 'meziměstský'], taxi: ['taxi', 'auto'], delivery: ['dodávka', 'auto', 'taxi'], tram: ['tramvaj'], metro: ['metro'] };
  const icon: Record<string, string> = { bus: '🚌', taxi: '🚕', delivery: '📦', tram: '', metro: '' };
  const cards = offers.map((o, i) => {
    const owned = own(needs[o.kind]);
    return `<div class="card">
      <div class="t">${icon[o.kind]} ${escapeHtml(o.title)}</div>
      <div class="muted small">${escapeHtml(o.detail)}</div>
      <div class="pay">až ${formatMoney(o.estPay * 1.3)}</div>
      <div class="row">
        <button class="btn primary" data-take="${i}" ${owned ? '' : 'disabled'}>Přijmout</button>
        <button class="btn" data-rent="${i}">Firemní vůz (−30 %)</button>
      </div>
      ${owned ? '' : '<div class="muted small">Nemáte vhodné vozidlo – můžete jet firemním.</div>'}
    </div>`;
  }).join('');
  show('jobs', `<h2>Práce v okolí</h2>
    <p class="muted">Linky vedou po skutečných zastávkách MHD, taxi a zásilky jezdí na skutečné adresy z OpenStreetMap. ${g.job ? '<b class="warn">Přijetím nové práce zrušíte současnou.</b>' : ''}</p>
    ${offers.length ? `<div class="cards">${cards}</div>` : '<p>V okolí se nenašly zastávky ani adresy. Popojeďte do města nebo počkejte na načtení okolí.</p>'}
    <div class="row" style="margin-top:12px"><button class="btn" id="reroll">Jiné nabídky</button></div>`);
  const take = (i: number, rent: boolean) => {
    const o = offers[i];
    const types = needs[o.kind];
    const cur = g.vehicle.spec.type;
    if (rent) {
      if (!types.includes(cur) || g.walking) g.setVehicle(types[0], true);
    } else if (!types.includes(cur) || g.walking) {
      g.setVehicle(types.find((t) => g.state.garage.includes(t))!);
    }
    g.startJob(o.make({
      world: g.world, vehicle: g.vehicle, model: g.model, scene: g.scene, walking: false,
      notify: (m, k) => g.notify(m, k), chime: () => g.audio.chime(), clock: g.clock,
    }));
    offers.splice(i, 1);
    closePanel();
  };
  on('[data-take]', (el) => take(Number(el.dataset.take), false));
  on('[data-rent]', (el) => take(Number(el.dataset.rent), true));
  on('#reroll', () => {
    offers = [];
    jobsPanel(g);
  });
}

export function showJobResult(g: Game, r: JobResult, pay: number, rental: boolean) {
  const canLine = r.line && g.state.company;
  show('result', `<h2>Hotovo! +${formatMoney(pay)}</h2>
    ${r.summary.map((s) => `<p>${escapeHtml(s)}</p>`).join('')}
    ${rental ? '<p class="muted">Firemní vůz: odečteno 30 % výdělku.</p>' : ''}
    <p class="muted">+${r.xp} XP</p>
    ${canLine ? '<button class="btn primary" id="addline">Zařadit tuto linku do své firmy</button>' : r.line ? '<p class="muted">Až si založíte firmu (F), můžete projeté linky provozovat s vlastními řidiči.</p>' : ''}
    <div class="row" style="margin-top:10px"><button class="btn" id="more">Další práce</button></div>`);
  on('#addline', (el) => {
    const c = g.state.company!;
    const line = addLine(c, g.world, r.line!);
    (el as HTMLButtonElement).disabled = true;
    el.textContent = `Linka ${line.number} přidána – přiřaďte jí vozy a řidiče v sekci Firma`;
  });
  on('#more', () => jobsPanel(g));
}

// ------------------------------------------------------------ garáž

function garagePanel(g: Game) {
  const types = (Object.keys(SPECS) as VehicleType[]).filter((t) => t !== 'tramvaj' && t !== 'metro');
  const cards = types.map((t) => {
    const s = SPECS[t];
    const owned = g.state.garage.includes(t);
    const cur = g.vehicle.spec.type === t && !g.rental;
    return `<div class="card">
      <div class="t">${s.name}</div>
      <div class="muted small">${Math.round(s.power / 1000)} kW · max ${Math.round(s.vmax * 3.6)} km/h · ${s.length} m · ${(s.mass / 1000).toFixed(1)} t</div>
      ${owned
        ? `<button class="btn ${cur ? '' : 'primary'}" data-use="${t}" ${cur ? 'disabled' : ''}>${cur ? 'Právě řídíte' : 'Přistavit'}</button>`
        : `<div class="pay">${formatMoney(s.price)}</div><button class="btn" data-buy="${t}" ${g.state.money >= s.price ? '' : 'disabled'}>Koupit</button>`}
    </div>`;
  }).join('');
  const repair = Math.round((1 - g.condition) * 30000 * (g.vehicle.spec.mass > 5000 ? 3 : 1));
  show('garage', `<h2>Garáž</h2>
    <p class="muted">Vlastní vozidla můžete kdykoli přistavit na nejbližší silnici. Peníze vyděláte prací (J).</p>
    <div class="row" style="margin-bottom:12px">Stav vozidla: <b class="${g.condition < 0.5 ? 'warn' : ''}">${Math.round(g.condition * 100)} %</b>
      <button class="btn" id="repair" ${repair > 0 && !g.rental ? '' : 'disabled'}>Opravit (${formatMoney(repair)})</button></div>
    <div class="cards">${cards}</div>`);
  on('#repair', () => {
    g.state.money -= repair;
    g.condition = 1;
    g.notify('Vozidlo opraveno.', 'ok');
    garagePanel(g);
  });
  on('[data-use]', (el) => {
    if (g.job && g.rental) g.cancelJob();
    g.setVehicle(el.dataset.use as VehicleType);
    closePanel();
  });
  on('[data-buy]', (el) => {
    const t = el.dataset.buy as VehicleType;
    if (g.state.money < SPECS[t].price) return;
    g.state.money -= SPECS[t].price;
    g.state.garage.push(t);
    g.notify(`Koupeno: ${SPECS[t].name}`, 'ok');
    g.save();
    garagePanel(g);
  });
}

// ------------------------------------------------------------ firma

function companyPanel(g: Game) {
  const c = g.state.company;
  if (!c) {
    const place = g.location.place || 'Česko';
    show('company', `<h2>Vlastní dopravní firma</h2>
      <p>Založte firmu, nakupujte autobusy, najímejte řidiče a provozujte linky na skutečných zastávkách. Poptávka na lince se počítá z velikosti zástavby kolem zastávek (data OSM). Firma vydělává i ve chvíli, kdy jezdíte jinde.</p>
      <p class="muted">Založení stojí ${formatMoney(FOUND_COST)}. První depo vznikne tady (${escapeHtml(place)}).</p>
      <div class="row"><input type="text" id="cname" value="${escapeHtml(`Dopravní společnost ${place.split(' – ')[0]}`)}" class="grow">
      <button class="btn primary" id="found" ${g.state.money >= FOUND_COST ? '' : 'disabled'}>Založit firmu</button></div>
      ${g.state.money < FOUND_COST ? `<p class="warn">Chybí vám ${formatMoney(FOUND_COST - g.state.money)}. Vydělejte si jako řidič autobusu nebo taxikář.</p>` : ''}`);
    on('#found', () => {
      const name = ($('cname') as HTMLInputElement).value.trim() || 'Moje doprava';
      g.state.money -= FOUND_COST;
      g.state.company = newCompany(name, g.px, g.pz, place);
      g.notify(`Firma ${name} založena!`, 'ok');
      g.save();
      companyPanel(g);
    });
    return;
  }
  const tabs = ['přehled', 'linky', 'vozy', 'řidiči', 'depa'];
  const tabHtml = `<div class="tabs">${tabs.map((t) => `<button data-tab="${t}" class="${t === companyTab ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>`;
  let body = '';
  const last24 = c.ledger.slice(-24);
  const inc = last24.reduce((a, r) => a + r.income, 0);
  const cost = last24.reduce((a, r) => a + r.costs, 0);
  const pax = last24.reduce((a, r) => a + r.passengers, 0);
  if (companyTab === 'přehled') {
    body = `<div class="kpis">
      <div class="kpi"><div class="v">${formatMoney(g.state.money)}</div><div class="l">Pokladna</div></div>
      <div class="kpi"><div class="v ${inc - cost >= 0 ? 'ok' : 'warn'}">${formatMoney(inc - cost)}</div><div class="l">Zisk za 24 h provozu</div></div>
      <div class="kpi"><div class="v">${pax.toLocaleString('cs-CZ')}</div><div class="l">Cestujících za 24 h</div></div>
      <div class="kpi"><div class="v">${Math.round(c.reputation * 100)} %</div><div class="l">Pověst</div></div>
      <div class="kpi"><div class="v">${formatMoney(companyValue(c))}</div><div class="l">Hodnota firmy</div></div>
      <div class="kpi"><div class="v">${c.hour % 24}:00</div><div class="l">Provozní hodina (den ${Math.floor(c.hour / 24) + 1})</div></div>
    </div>
    <canvas class="chart" id="chart" width="800" height="140"></canvas>
    <p class="muted small">1 provozní hodina = 30 s hraní. Graf: tržby (zeleně) a náklady (červeně) za poslední 2 dny.</p>
    <div class="row">
      <button class="btn" id="loan">Vzít úvěr 1 000 000 Kč</button>
      <button class="btn" id="repay" ${c.loan > 0 && g.state.money >= 500000 ? '' : 'disabled'}>Splatit 500 000 Kč</button>
      <span class="muted">Dluh: ${formatMoney(c.loan)}</span>
    </div>
    <h3>Události</h3><div class="list small">${c.log.slice(0, 15).map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>`;
  } else if (companyTab === 'linky') {
    const rows = c.lines.map((l) => {
      const dem = l.stops.reduce((a, s) => a + s.demand, 0);
      const free = c.vehicles.filter((v) => !c.lines.some((x) => x.vehicles.includes(v.id)));
      return `<tr><td><b>${escapeHtml(l.number)}</b></td><td>${escapeHtml(l.name)}<div class="muted small">${l.stops.length} zastávek · ${l.lengthKm.toFixed(1)} km · ${Math.round(l.tripMin)} min · poptávka ${dem}/h</div></td>
        <td class="num">${l.vehicles.length}</td>
        <td><div class="row">
          <button class="btn" data-addveh="${l.id}" ${free.length ? '' : 'disabled'}>+ vůz</button>
          <button class="btn" data-remveh="${l.id}" ${l.vehicles.length ? '' : 'disabled'}>− vůz</button>
          <select data-fare="${l.id}">${[16, 20, 24, 30, 36].map((f) => `<option ${f === l.fare ? 'selected' : ''}>${f}</option>`).join('')}</select> Kč
          <button class="btn" data-delline="${l.id}">Zrušit</button></div></td></tr>`;
    }).join('');
    body = `<p class="muted">Linky přidáte dokončením autobusové práce (tlačítko po dojetí) nebo návrhem z okolních zastávek. Linka musí začínat do 15 km od depa.</p>
      <div class="row"><button class="btn primary" id="planline">Navrhnout linku ze zastávek v okolí</button>
      <button class="btn" id="pidline">Převzít skutečnou linku PID v okolí</button></div>
      ${c.lines.length ? `<table><tr><th>Č.</th><th>Linka</th><th class="num">Vozy</th><th></th></tr>${rows}</table>` : '<p>Zatím žádné linky.</p>'}`;
  } else if (companyTab === 'vozy') {
    const rows = c.vehicles.map((v) => {
      const line = c.lines.find((l) => l.vehicles.includes(v.id));
      const drv = c.drivers.find((d) => d.vehicle === v.id);
      return `<tr><td>#${v.id} ${SPECS[v.type].name}</td><td>${line ? `linka ${escapeHtml(line.number)}` : '<span class="muted">v depu</span>'}</td>
        <td>${drv ? escapeHtml(drv.name) : '<span class="warn">bez řidiče</span>'}</td>
        <td class="num">${Math.round(v.condition * 100)} %${v.broken > 0 ? ' <span class="warn">v opravě</span>' : ''}</td><td class="num">${Math.round(v.km).toLocaleString('cs-CZ')} km</td>
        <td><div class="row"><button class="btn" data-service="${v.id}" ${v.condition < 0.98 ? '' : 'disabled'}>Servis ${formatMoney((1 - v.condition) * 60000)}</button>
        <button class="btn" data-sell="${v.id}">Prodat ${formatMoney(sellValue(v))}</button></div></td></tr>`;
    }).join('');
    const buy = (['autobus', 'meziměstský'] as VehicleType[]).map((t) => `<button class="btn primary" data-cbuy="${t}" ${g.state.money >= SPECS[t].price ? '' : 'disabled'}>Koupit ${SPECS[t].name} (${formatMoney(SPECS[t].price)})</button>`).join(' ');
    const cap = c.depots.reduce((a, d) => a + d.capacity, 0);
    body = `<div class="row">${buy}</div><p class="muted small">Kapacita dep: ${c.vehicles.length}/${cap} vozů.</p>
      ${c.vehicles.length ? `<table><tr><th>Vůz</th><th>Nasazení</th><th>Řidič</th><th class="num">Stav</th><th class="num">Najeto</th><th></th></tr>${rows}</table>` : '<p>Firma zatím nemá žádné vozy.</p>'}`;
  } else if (companyTab === 'řidiči') {
    const rows = c.drivers.map((d) => {
      const opts = ['<option value="">— volno —</option>', ...c.vehicles.map((v) => {
        const taken = c.drivers.some((o) => o !== d && o.vehicle === v.id);
        return taken ? '' : `<option value="${v.id}" ${d.vehicle === v.id ? 'selected' : ''}>#${v.id} ${SPECS[v.type].name}</option>`;
      })].join('');
      return `<tr><td>${escapeHtml(d.name)}</td><td class="num">${Math.round(d.skill * 100)} %</td><td class="num">${d.wage} Kč/h</td>
        <td><select data-assign="${d.id}">${opts}</select></td><td><button class="btn" data-fire="${d.id}">Propustit</button></td></tr>`;
    }).join('');
    const cands = candidates(hireSeed).map((d, i) => `<div class="card"><div class="t">${escapeHtml(d.name)}</div>
      <div class="muted small">Zkušenost ${Math.round(d.skill * 100)} % · mzda ${d.wage} Kč/h</div>
      <button class="btn primary" data-hire="${i}">Najmout (nástupné ${formatMoney(d.wage * 40)})</button></div>`).join('');
    body = `${c.drivers.length ? `<table><tr><th>Řidič</th><th class="num">Zkušenost</th><th class="num">Mzda</th><th>Vůz</th><th></th></tr>${rows}</table>` : '<p>Zatím nikoho nezaměstnáváte.</p>'}
      <h3>Uchazeči</h3><div class="cards">${cands}</div>`;
  } else if (companyTab === 'depa') {
    const rows = c.depots.map((d) => `<tr><td>${escapeHtml(d.name)}</td><td class="num">${d.capacity}</td>
      <td class="num">${(Math.hypot(d.x - g.px, d.z - g.pz) / 1000).toFixed(1)} km</td>
      <td><button class="btn" data-expand="${d.id}" ${g.state.money >= 400000 ? '' : 'disabled'}>Rozšířit +4 (400 000 Kč)</button></td></tr>`).join('');
    const here = g.location.place || 'zde';
    body = `<table><tr><th>Depo</th><th class="num">Kapacita</th><th class="num">Vzdálenost</th><th></th></tr>${rows}</table>
      <p class="muted">Nové depo v jiném městě umožní zakládat linky i tam.</p>
      <button class="btn primary" id="newdepot" ${g.state.money >= DEPOT_COST && nearestDepotDist(c, g.px, g.pz) > 15000 ? '' : 'disabled'}>Postavit depo: ${escapeHtml(here)} (${formatMoney(DEPOT_COST)})</button>
      ${nearestDepotDist(c, g.px, g.pz) <= 15000 ? '<p class="muted small">Do 15 km už depo máte.</p>' : ''}`;
  }
  show('company', `<h2>🏢 ${escapeHtml(c.name)}</h2>${tabHtml}${body}`);
  on('[data-tab]', (el) => {
    companyTab = el.dataset.tab!;
    companyPanel(g);
  });
  const chart = document.getElementById('chart') as HTMLCanvasElement | null;
  if (chart) drawChart(chart, c.ledger.slice(-48));
  on('#loan', () => {
    c.loan += 1000000;
    g.state.money += 1000000;
    c.log.unshift('Přijat úvěr 1 000 000 Kč.');
    companyPanel(g);
  });
  on('#repay', () => {
    const v = Math.min(500000, c.loan);
    c.loan -= v;
    g.state.money -= v;
    companyPanel(g);
  });
  on('#planline', () => {
    if (nearestDepotDist(c, g.px, g.pz) > 15000) {
      g.notify('Jste dál než 15 km od depa.', 'warn');
      return;
    }
    const p = planBusLine(g.world, g.px, g.pz, 8);
    if (!p) {
      g.notify('V okolí nejsou vhodné zastávky.', 'warn');
      return;
    }
    let path: [number, number][] = [];
    for (const l of p.legs) path = path.concat(path.length ? l.slice(1) : l);
    const km = p.legLen.reduce((a, b) => a + b, 0) / 1000;
    const line = addLine(c, g.world, {
      stops: p.stops.map((s) => ({ name: s.name, x: s.x, z: s.z, demand: stopDemand(g.world, s.x, s.z) })),
      path: simplifyPath(path, 4), lengthKm: km, tripMin: km / 0.3 + p.stops.length * 0.5,
      number: p.number, name: `${p.stops[0].name} – ${p.stops[p.stops.length - 1].name}`,
    });
    g.notify(`Linka ${line.number} navržena.`, 'ok');
    companyPanel(g);
  });
  on('#pidline', () => {
    if (nearestDepotDist(c, g.px, g.pz) > 15000) {
      g.notify('Jste dál než 15 km od depa.', 'warn');
      return;
    }
    const plans = planPidLines(g.world, g.px, g.pz, 6).filter((p) => !c.lines.some((l) => l.number === p.number));
    const p = plans[0];
    if (!p) {
      g.notify('V okolí není žádná linka PID (nebo už ji provozujete).', 'warn');
      return;
    }
    let path: [number, number][] = [];
    for (const l of p.legs) path = path.concat(path.length ? l.slice(1) : l);
    const km = p.legLen.reduce((a, b) => a + b, 0) / 1000;
    const line = addLine(c, g.world, {
      stops: p.stops.map((s) => ({ name: s.name, x: s.x, z: s.z, demand: stopDemand(g.world, s.x, s.z) })),
      path: simplifyPath(path, 4), lengthKm: km, tripMin: Math.max(5, p.times[p.times.length - 1] / 60),
      number: p.number, name: `${p.stops[0].name} – ${p.stops[p.stops.length - 1].name} (směr ${p.headsign})`,
    });
    g.notify(`Převzata linka PID ${line.number}.`, 'ok');
    companyPanel(g);
  });
  on('[data-addveh]', (el) => {
    const l = c.lines.find((x) => x.id === Number(el.dataset.addveh))!;
    const free = c.vehicles.find((v) => !c.lines.some((x) => x.vehicles.includes(v.id)));
    if (free) l.vehicles.push(free.id);
    companyPanel(g);
  });
  on('[data-remveh]', (el) => {
    const l = c.lines.find((x) => x.id === Number(el.dataset.remveh))!;
    l.vehicles.pop();
    companyPanel(g);
  });
  on('[data-delline]', (el) => {
    c.lines = c.lines.filter((x) => x.id !== Number(el.dataset.delline));
    companyPanel(g);
  });
  document.querySelectorAll<HTMLSelectElement>('[data-fare]').forEach((s) => s.addEventListener('change', () => {
    const l = c.lines.find((x) => x.id === Number(s.dataset.fare))!;
    l.fare = Number(s.value);
    // Dražší jízdné snižuje poptávku.
    c.log.unshift(`Jízdné na lince ${l.number}: ${l.fare} Kč.`);
  }));
  on('[data-cbuy]', (el) => {
    const t = el.dataset.cbuy as VehicleType;
    const cap = c.depots.reduce((a, d) => a + d.capacity, 0);
    if (c.vehicles.length >= cap) {
      g.notify('Depa jsou plná – rozšiřte je.', 'warn');
      return;
    }
    if (g.state.money < SPECS[t].price) return;
    g.state.money -= SPECS[t].price;
    let dep = c.depots[0];
    for (const d of c.depots) if (Math.hypot(d.x - g.px, d.z - g.pz) < Math.hypot(dep.x - g.px, dep.z - g.pz)) dep = d;
    buyVehicle(c, t, dep.id);
    companyPanel(g);
  });
  on('[data-service]', (el) => {
    const v = c.vehicles.find((x) => x.id === Number(el.dataset.service))!;
    const price = Math.round((1 - v.condition) * 60000);
    if (g.state.money < price) return;
    g.state.money -= price;
    v.condition = 1;
    v.broken = 0;
    companyPanel(g);
  });
  on('[data-sell]', (el) => {
    const id = Number(el.dataset.sell);
    const v = c.vehicles.find((x) => x.id === id)!;
    g.state.money += sellValue(v);
    c.vehicles = c.vehicles.filter((x) => x.id !== id);
    for (const l of c.lines) l.vehicles = l.vehicles.filter((x) => x !== id);
    for (const d of c.drivers) if (d.vehicle === id) d.vehicle = null;
    companyPanel(g);
  });
  document.querySelectorAll<HTMLSelectElement>('[data-assign]').forEach((s) => s.addEventListener('change', () => {
    const d = c.drivers.find((x) => x.id === Number(s.dataset.assign))!;
    d.vehicle = s.value ? Number(s.value) : null;
    companyPanel(g);
  }));
  on('[data-fire]', (el) => {
    c.drivers = c.drivers.filter((x) => x.id !== Number(el.dataset.fire));
    companyPanel(g);
  });
  on('[data-hire]', (el) => {
    const d = candidates(hireSeed)[Number(el.dataset.hire)];
    if (g.state.money < d.wage * 40) return;
    g.state.money -= d.wage * 40;
    d.id = c.nextId++;
    d.hired = Date.now();
    // Automaticky přiřadit volný vůz.
    const free = c.vehicles.find((v) => !c.drivers.some((o) => o.vehicle === v.id));
    d.vehicle = free ? free.id : null;
    c.drivers.push(d);
    c.log.unshift(`Přijat řidič ${d.name}.`);
    hireSeed = (hireSeed * 48271) % 2147483647;
    companyPanel(g);
  });
  on('[data-expand]', (el) => {
    const d = c.depots.find((x) => x.id === Number(el.dataset.expand))!;
    g.state.money -= 400000;
    d.capacity += 4;
    companyPanel(g);
  });
  on('#newdepot', () => {
    g.state.money -= DEPOT_COST;
    c.depots.push({ id: c.nextId++, name: g.location.place || 'Nové depo', x: g.px, z: g.pz, capacity: 6 });
    c.log.unshift(`Postaveno depo ${g.location.place}.`);
    companyPanel(g);
  });
}

function drawChart(cv: HTMLCanvasElement, rows: { income: number; costs: number }[]) {
  const ctx = cv.getContext('2d')!;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!rows.length) {
    ctx.fillStyle = '#a7b0bb';
    ctx.font = '14px sans-serif';
    ctx.fillText('Zatím žádná data – přiřaďte lince vůz a řidiče.', 10, H / 2);
    return;
  }
  const max = Math.max(1, ...rows.map((r) => Math.max(r.income, r.costs)));
  const bw = W / 48;
  rows.forEach((r, i) => {
    const x = i * bw;
    ctx.fillStyle = '#4cc27a';
    const hi = (r.income / max) * (H - 10);
    ctx.fillRect(x + 1, H - hi, bw / 2 - 1, hi);
    ctx.fillStyle = '#e2483d';
    const hc = (r.costs / max) * (H - 10);
    ctx.fillRect(x + bw / 2, H - hc, bw / 2 - 1, hc);
  });
}

// ------------------------------------------------------------ mapa

let mapView = { cx: 0, cz: 0, scale: 0 };

function mapPanel(g: Game) {
  show('map', `<h2>Mapa</h2>
    <div class="row" style="margin-bottom:8px">
      <input type="text" id="search" placeholder="Hledat adresu, obec, místo…" class="grow">
      <button class="btn" id="dosearch">Hledat</button>
      <button class="btn" id="zoomme">Kde jsem</button>
      <button class="btn" id="zoomcz">Celá ČR</button>
      <button class="btn" id="share">🔗 Sdílet místo</button>
    </div>
    <div id="results" class="list"></div>
    <canvas id="bigmap"></canvas>
    <p class="muted small">Kolečkem přibližte, tažením posuňte, kliknutím se přenesete na místo (auto se postaví na nejbližší silnici).</p>
    <div class="row">${CITIES.map((c, i) => `<button class="btn" data-city="${i}">${escapeHtml(c.name)}</button>`).join('')}</div>`);
  const cv = $('bigmap') as HTMLCanvasElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  const czCenter = lonLatToWorld(15.45, 49.8);
  const czScale = cv.width / 520000;
  if (!mapView.scale) mapView = { cx: czCenter.x, cz: czCenter.z, scale: czScale };
  const draw = () => drawBigMap(g, cv, dpr);
  draw();
  let drag: { x: number; y: number; moved: boolean } | null = null;
  cv.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    mapView.cx -= (dx * dpr) / mapView.scale;
    mapView.cz -= (dy * dpr) / mapView.scale;
    drag.x = e.clientX;
    drag.y = e.clientY;
    draw();
  });
  cv.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) {
      const r = cv.getBoundingClientRect();
      const x = mapView.cx + ((e.clientX - r.left) * dpr - cv.width / 2) / mapView.scale;
      const z = mapView.cz + ((e.clientY - r.top) * dpr - cv.height / 2) / mapView.scale;
      const ll = worldToLonLat(x, z);
      if (ll.lat > 48.4 && ll.lat < 51.2 && ll.lon > 11.9 && ll.lon < 19) {
        travel(g, x, z);
      }
    }
    drag = null;
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * dpr - cv.width / 2;
    const my = (e.clientY - r.top) * dpr - cv.height / 2;
    const wx = mapView.cx + mx / mapView.scale;
    const wz = mapView.cz + my / mapView.scale;
    mapView.scale = Math.max(czScale * 0.8, Math.min(1.5, mapView.scale * (e.deltaY < 0 ? 1.25 : 0.8)));
    mapView.cx = wx - mx / mapView.scale;
    mapView.cz = wz - my / mapView.scale;
    draw();
  }, { passive: false });
  on('#share', () => {
    const link = g.shareLink();
    const done = () => g.notify('Odkaz na toto místo zkopírován do schránky.', 'ok');
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      void navigator.share({ title: 'Česko na kolech', text: g.location.place || 'Podívej, kde jsem', url: link }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(link).then(done, () => prompt('Odkaz na toto místo:', link));
    }
  });
  on('#zoomme', () => {
    mapView = { cx: g.px, cz: g.pz, scale: 0.25 * dpr };
    draw();
  });
  on('#zoomcz', () => {
    mapView = { cx: czCenter.x, cz: czCenter.z, scale: czScale };
    draw();
  });
  on('[data-city]', (el) => {
    const c = CITIES[Number(el.dataset.city)];
    const p = lonLatToWorld(c.lon, c.lat);
    travel(g, p.x, p.z);
  });
  const search = async () => {
    const q = ($('search') as HTMLInputElement).value.trim();
    if (!q) return;
    $('results').innerHTML = '<p class="muted">Hledám…</p>';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=cz&limit=8&accept-language=cs&q=${encodeURIComponent(q)}`);
      const j = (await r.json()) as { display_name: string; lat: string; lon: string }[];
      $('results').innerHTML = j.length
        ? j.map((x, i) => `<div class="row" style="margin:4px 0"><button class="btn" data-res="${i}">Jet sem</button> <span class="small">${escapeHtml(x.display_name)}</span></div>`).join('')
        : '<p class="muted">Nic nenalezeno.</p>';
      on('[data-res]', (el) => {
        const x = j[Number(el.dataset.res)];
        const p = lonLatToWorld(Number(x.lon), Number(x.lat));
        travel(g, p.x, p.z);
      });
    } catch {
      $('results').innerHTML = '<p class="warn">Vyhledávání není dostupné.</p>';
    }
  };
  on('#dosearch', () => void search());
  ($('search') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void search();
  });
}

function travel(g: Game, x: number, z: number) {
  if (g.job) {
    if (!confirm('Přesunem zrušíte rozpracovanou práci. Pokračovat?')) return;
    g.cancelJob();
  }
  closePanel();
  g.walking = false;
  g.teleport(x, z, 0, true);
}

function drawBigMap(g: Game, cv: HTMLCanvasElement, dpr: number) {
  const ctx = cv.getContext('2d')!;
  const W = cv.width, H = cv.height;
  const { cx, cz, scale } = mapView;
  const sx = (x: number) => (x - cx) * scale + W / 2;
  const sy = (z: number) => (z - cz) * scale + H / 2;
  ctx.fillStyle = '#1b222b';
  ctx.fillRect(0, 0, W, H);
  // Obrys ČR.
  ctx.beginPath();
  CZ_OUTLINE.forEach(([lon, lat], i) => {
    const p = lonLatToWorld(lon, lat);
    if (i === 0) ctx.moveTo(sx(p.x), sy(p.z));
    else ctx.lineTo(sx(p.x), sy(p.z));
  });
  ctx.closePath();
  ctx.fillStyle = '#2c3a2b';
  ctx.fill();
  ctx.strokeStyle = '#e2483d';
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
  // Načtené dlaždice.
  for (const t of g.world.minimapTiles()) {
    const x = sx(t.ox), y = sy(t.oz), s = t.size * scale;
    if (x > W || y > H || x + s < 0 || y + s < 0) continue;
    ctx.drawImage(t.img, x, y, s, s);
  }
  // Firemní linky a depa.
  const c = g.state.company;
  if (c) {
    ctx.strokeStyle = '#ff6a5c';
    ctx.lineWidth = 3 * dpr;
    for (const l of c.lines) {
      ctx.beginPath();
      l.path.forEach(([x, z], i) => (i ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z))));
      ctx.stroke();
    }
    ctx.fillStyle = '#ff6a5c';
    for (const d of c.depots) ctx.fillRect(sx(d.x) - 5 * dpr, sy(d.z) - 5 * dpr, 10 * dpr, 10 * dpr);
  }
  // Navštívená místa.
  ctx.fillStyle = '#5aa9e6';
  for (const v of Object.values(g.state.visited)) {
    ctx.beginPath();
    ctx.arc(sx(v.x), sy(v.z), 2.5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  // Města.
  ctx.font = `${12 * dpr}px sans-serif`;
  for (const city of CITIES) {
    const p = lonLatToWorld(city.lon, city.lat);
    const x = sx(p.x), y = sy(p.z);
    if (x < -50 || y < -20 || x > W + 50 || y > H + 20) continue;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(city.name.split(' – ')[0], x + 6 * dpr, y + 4 * dpr);
  }
  // Hráč.
  ctx.fillStyle = '#ffd34a';
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.arc(sx(g.px), sy(g.pz), 6 * dpr, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Měřítko.
  const m = [100, 500, 1000, 5000, 10000, 50000].find((v) => v * scale > 60 * dpr) ?? 100000;
  ctx.fillStyle = '#fff';
  ctx.fillRect(12 * dpr, H - 16 * dpr, m * scale, 3 * dpr);
  ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, 12 * dpr, H - 22 * dpr);
}

// ------------------------------------------------------------ deník

function journalPanel(g: Game) {
  const v = Object.values(g.state.visited).sort((a, b) => b.t - a.t);
  const count = (cls: string[]) => v.filter((x) => cls.includes(x.cls)).length;
  const s = g.state.stats;
  const label: Record<string, string> = { city: 'město', town: 'město', village: 'obec', suburb: 'čtvrť', quarter: 'čtvrť', neighbourhood: 'lokalita', hamlet: 'osada', isolated_dwelling: 'samota', locality: 'místo' };
  show('journal', `<h2>📖 Cestovní deník</h2>
    <div class="kpis">
      <div class="kpi"><div class="v">${count(['city', 'town'])}</div><div class="l">Měst</div></div>
      <div class="kpi"><div class="v">${count(['village'])}</div><div class="l">Obcí</div></div>
      <div class="kpi"><div class="v">${count(['hamlet', 'isolated_dwelling', 'locality', 'suburb', 'quarter', 'neighbourhood'])}</div><div class="l">Osad a čtvrtí</div></div>
      <div class="kpi"><div class="v">${(s.distance / 1000).toFixed(1)} km</div><div class="l">Najeto a nachozeno</div></div>
      <div class="kpi"><div class="v">${s.jobs}</div><div class="l">Dokončených prací</div></div>
      <div class="kpi"><div class="v">${s.passengers}</div><div class="l">Přepravených osob</div></div>
      <div class="kpi"><div class="v">${s.busStops}</div><div class="l">Obsloužených zastávek</div></div>
      <div class="kpi"><div class="v">${s.deliveries}</div><div class="l">Doručených zásilek</div></div>
      <div class="kpi"><div class="v">${formatMoney(s.earned)}</div><div class="l">Vyděláno celkem</div></div>
      <div class="kpi"><div class="v">${level(g.state.xp)}</div><div class="l">Úroveň řidiče</div></div>
    </div>
    <h3>Navštívená místa (${v.length})</h3>
    <div class="list">${v.length ? v.map((x) => `<div class="row"><button class="btn" data-go="${x.x},${x.z}">↗</button> ${escapeHtml(x.name)} <span class="muted small">${label[x.cls] ?? x.cls} · ${new Date(x.t).toLocaleDateString('cs-CZ')}</span></div>`).join('') : '<p class="muted">Projeďte obcí a zapíše se sem.</p>'}</div>`);
  on('[data-go]', (el) => {
    const [x, z] = el.dataset.go!.split(',').map(Number);
    travel(g, x, z);
  });
}

// ------------------------------------------------------------ nastavení

function settingsPanel(g: Game) {
  const s = g.state.settings;
  const opt = (vals: string[], cur: string) => vals.map((v) => `<option ${v === cur ? 'selected' : ''}>${v}</option>`).join('');
  show('settings', `<h2>Nastavení</h2>
    <div class="keys">
      <label>Kvalita grafiky</label><select id="s-q">${opt(Object.keys(QUALITY), s.quality)}</select>
      <label>Roční období</label><select id="s-season">${opt(['jaro', 'léto', 'podzim', 'zima'], g.env.season)}</select>
      <label>Počasí</label><select id="s-weather">${opt(['skutečné', 'jasno', 'oblačno', 'mlha', 'déšť', 'sníh'], s.weather === 'skutečné' ? 'skutečné' : g.env.weather)}</select>
      <label>Denní doba <span id="s-tl">${g.env.time.toFixed(1)} h</span></label><input type="range" id="s-time" min="0" max="23.9" step="0.1" value="${g.env.time}">
      <label>Plynutí času</label><select id="s-speed">${[-1, 0, 1, 10, 60].map((v) => `<option value="${v}" ${v === s.timeSpeed ? 'selected' : ''}>${v < 0 ? 'skutečný čas a roční období' : v === 0 ? 'zastaveno' : v === 1 ? '1 min / s' : `${v} min / s`}</option>`).join('')}</select>
      <label>Zvuk</label><select id="s-sound">${opt(['zapnutý', 'vypnutý'], s.sound ? 'zapnutý' : 'vypnutý')}</select>
      <label>Povrch krajiny</label><select id="s-surface">${opt(['mapa', 'letecký snímek'], s.surface ?? 'mapa')}</select>
      <label>Doprava</label><select id="s-traffic">${opt(['zapnutá', 'vypnutá'], g.traffic.enabled ? 'zapnutá' : 'vypnutá')}</select>
    </div>
    <h3>Uložená hra</h3>
    <div class="row">
      <button class="btn" id="s-export">Exportovat</button>
      <button class="btn" id="s-import">Importovat</button>
      <button class="btn" id="s-reset">Začít znovu</button>
    </div>
    <h3>O hře a datech</h3>
    <p class="legal">Mapová data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">přispěvatelé OpenStreetMap</a> (ODbL), dlaždice <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> / <a href="https://openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a>. Budovy (podlaží, využití, konstrukce): RÚIAN © ČÚZK, barvy střech: Ortofoto ČR © ČÚZK (CC BY 4.0). Terén a vegetace © <a href="https://geoportal.cuzk.cz" target="_blank" rel="noopener">ČÚZK</a> (DMR 5G, DMP 1G, CC BY 4.0), mimo ČR <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a>. Vyhledávání: Nominatim. Jízdní řády: <a href="https://pid.cz/o-systemu/opendata/" target="_blank" rel="noopener">PID</a> (CC BY 4.0). Počasí: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>. Pozice: ${worldToLonLat(g.px, g.pz).lat.toFixed(5)}, ${worldToLonLat(g.px, g.pz).lon.toFixed(5)}.</p>`);
  const sel = (id: string) => $(id) as HTMLSelectElement;
  sel('s-q').onchange = () => {
    s.quality = sel('s-q').value;
    g.applySettings();
  };
  sel('s-season').onchange = () => (g.env.season = s.season = sel('s-season').value as Season);
  sel('s-weather').onchange = () => {
    s.weather = sel('s-weather').value as Weather | 'skutečné';
    if (s.weather === 'skutečné') g.weatherT = 0;
    else g.env.weather = s.weather;
  };
  ($('s-time') as HTMLInputElement).oninput = () => {
    g.env.time = s.time = Number(($('s-time') as HTMLInputElement).value);
    $('s-tl').textContent = `${g.env.time.toFixed(1)} h`;
  };
  sel('s-speed').onchange = () => {
    s.timeSpeed = Number(sel('s-speed').value);
    g.env.timeSpeed = Math.max(0, s.timeSpeed);
  };
  sel('s-sound').onchange = () => (g.audio.enabled = s.sound = sel('s-sound').value === 'zapnutý');
  sel('s-surface').onchange = () => {
    s.surface = sel('s-surface').value as 'mapa' | 'letecký snímek';
    g.applySettings();
  };
  sel('s-traffic').onchange = () => (g.traffic.enabled = sel('s-traffic').value === 'zapnutá');
  on('#s-export', () => {
    g.save();
    const blob = new Blob([JSON.stringify(g.state)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cesko-na-kolech-ulozeni.json';
    a.click();
  });
  on('#s-import', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const st = JSON.parse(await f.text());
        if (st.version !== 1) throw new Error('verze');
        localStorage.setItem('cesko-na-kolech-save-v1', JSON.stringify(st));
        location.reload();
      } catch {
        alert('Soubor se nepodařilo načíst.');
      }
    };
    inp.click();
  });
  on('#s-reset', () => {
    if (!confirm('Opravdu smazat postup a začít znovu?')) return;
    clearState();
    window.onbeforeunload = null;
    location.reload();
  });
}

function helpPanel(g: Game, first: boolean) {
  show('help', `<h2>Vítejte v Česku na kolech</h2>
    <p>Celá Česká republika ze skutečných dat: každá budova, silnice, les, řeka, zastávka a adresa z OpenStreetMap, terén z výškových dat. Svět se stahuje průběžně kolem vás – jeďte kamkoli.</p>
    <h3>Ovládání</h3>
    <div class="keys">
      <span><kbd>W</kbd> <kbd>S</kbd> / <kbd>↑</kbd> <kbd>↓</kbd></span><span>plyn / brzda a couvání (pěšky chůze)</span>
      <span><kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd></span><span>zatáčení</span>
      <span><kbd>Mezerník</kbd></span><span>ruční brzda (pěšky běh, nebo <kbd>Shift</kbd>)</span>
      <span><kbd>E</kbd></span><span>vystoupit / nastoupit</span>
      <span><kbd>O</kbd></span><span>dveře autobusu</span>
      <span><kbd>C</kbd></span><span>kamera (za vozem / od řidiče / z výšky); tažení myší otáčí, kolečko oddálí</span>
      <span><kbd>R</kbd></span><span>vrátit se na silnici</span>
      <span><kbd>Q</kbd></span><span>klakson</span>
      <span><kbd>T</kbd></span><span>natankovat u čerpací stanice (oranžové body na minimapě)</span>
      <span><kbd>J</kbd> <kbd>G</kbd> <kbd>F</kbd> <kbd>M</kbd> <kbd>L</kbd></span><span>práce, garáž, firma, mapa, deník</span>
      <span><kbd>Esc</kbd></span><span>nastavení (počasí, denní doba, kvalita)</span>
      <span><kbd>U</kbd></span><span>skrýt rozhraní (fotorežim); sdílet místo jde v mapě</span>
    </div>
    <p class="muted small">Funguje i herní ovladač (páčka řízení, spouště plyn a brzda) a na mobilu dotyková tlačítka.</p>
    <h3>Jak hrát</h3>
    <p>🚗 <b>Volná jízda</b> – projíždějte obce a města, zapisují se do deníku. Na mapě (M) se přenesete kamkoli.<br>
    🚌 <b>Řidič autobusu</b> – v nabídce práce (J) vezměte linku. Zastavte u zastávky, otevřete dveře (O), počkejte na cestující, zavřete a jeďte dál podle jízdního řádu. Hodnotí se přesnost a plynulost.<br>
    🚕 <b>Taxi a rozvoz</b> – vozte zákazníky a zásilky na skutečné adresy.<br>
    🏢 <b>Firma</b> – za vydělané peníze založte dopravní firmu (F), kupte autobusy, najměte řidiče a provozujte linky. Vaše autobusy pak potkáte na silnici.</p>
    ${first ? `<h3>Kde začít?</h3><div class="row">${CITIES.slice(0, 12).map((c, i) => `<button class="btn" data-start="${i}">${escapeHtml(c.name.split(' – ')[0])}</button>`).join('')}
      <button class="btn" id="random">🎲 Náhodné místo v ČR</button></div>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn primary" id="go">${first ? 'Začít tady (Praha)' : 'Vyrazit'}</button></div>`);
  on('#go', closePanel);
  on('[data-start]', (el) => {
    const c = CITIES[Number(el.dataset.start)];
    const p = lonLatToWorld(c.lon, c.lat);
    travel(g, p.x, p.z);
  });
  on('#random', () => {
    // Náhodný bod uvnitř obrysu republiky.
    for (let i = 0; i < 200; i++) {
      const lon = 12.1 + Math.random() * 6.8;
      const lat = 48.55 + Math.random() * 2.5;
      if (!pointInOutline(lon, lat)) continue;
      const p = lonLatToWorld(lon, lat);
      travel(g, p.x, p.z);
      return;
    }
  });
}
