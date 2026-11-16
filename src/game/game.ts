// Hlavní herní smyčka: svět, hráč (auto/autobus/chůze), kamera, práce, firma, ukládání.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CITIES, lonLatToWorld, worldToLonLat } from '../geo';
import { Environment } from '../world/environment';
import { QUALITY, World } from '../world/world';
import { SPEED_LIMIT } from '../world/roadgraph';
import { AudioFx } from './audio';
import { simulateHour } from './company';
import { Input } from './input';
import { BusJob, FreightJob, type Job, type JobCtx } from './jobs';
import { buildPerson, buildVehicleModel, updateSign, type VehicleModel } from './models';
import { defaultState, formatMoney, level, loadState, saveState, type SaveState } from './state';
import { Traffic, LIGHT_GLOW, addLightGlow } from './traffic';
import { Pedestrians } from './pedestrians';
import { loadPid } from './pid';
import { Signals } from './signals';
import { Grass } from '../world/grass';
import { Skidmarks } from './skidmarks';
import { MetroTunnel } from './metro';
import { SPECS, Vehicle, type VehicleType } from './vehicle';
import { Minimap } from '../ui/minimap';
import { openPanel, closePanel, currentPanel, showJobResult } from '../ui/panels';

/** Jednoduchý interiér: palubní deska, volant, tachometr, sloupky skla. Souřadnice kamery. */
function buildCockpit(): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1f2124, roughness: 0.8 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.6 });
  const dash = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.35, 0.7), dark);
  dash.position.set(0.25, -0.62, -0.95);
  dash.rotation.x = -0.15;
  g.add(dash);
  // Volant.
  const wheel = new THREE.Group();
  wheel.name = 'wheel';
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 8, 28), trim);
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.03, 0.02), trim);
  const spoke2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.17, 0.02), trim);
  spoke2.position.y = -0.09;
  wheel.add(rim, spoke, spoke2);
  wheel.position.set(0, -0.42, -0.62);
  wheel.rotation.x = -0.35;
  g.add(wheel);
  // Tachometr s ručičkou.
  const dialTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const x = cv.getContext('2d')!;
    x.fillStyle = '#0d0e10';
    x.beginPath();
    x.arc(64, 64, 62, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#d9dde3';
    x.lineWidth = 3;
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * 0.75 + (i / 10) * Math.PI * 1.5;
      x.beginPath();
      x.moveTo(64 + Math.cos(a) * 46, 64 + Math.sin(a) * 46);
      x.lineTo(64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56);
      x.stroke();
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const dial = new THREE.Mesh(new THREE.CircleGeometry(0.07, 24), new THREE.MeshBasicMaterial({ map: dialTex }));
  dial.position.set(0, -0.39, -0.78);
  dial.rotation.x = -0.35;
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.055, 0.003), new THREE.MeshBasicMaterial({ color: 0xff5533 }));
  needle.geometry.translate(0, 0.0275, 0);
  needle.name = 'needle';
  needle.position.set(0, -0.389, -0.777);
  needle.rotation.x = -0.35;
  g.add(dial, needle);
  // Sloupky čelního skla.
  const pillars = new THREE.Group();
  pillars.name = 'pillars';
  for (const [x, r] of [[-0.62, 0.35], [1.05, -0.35]] as [number, number][]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.2, 0.07), dark);
    p.position.set(x, 0.05, -0.85);
    p.rotation.z = r;
    pillars.add(p);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.5), dark);
  roof.position.set(0.2, 0.52, -0.6);
  pillars.add(roof);
  g.add(pillars);
  g.traverse((o) => {
    o.renderOrder = 10;
    o.frustumCulled = false;
  });
  return g;
}

const VEHICLE_COLORS: Record<VehicleType, number> = {
  auto: 0xc8452f, taxi: 0xf3d23a, dodávka: 0xeeeeee, autobus: 0xd8342c, meziměstský: 0x2f78c4, kamion: 0x3a6b3a, tramvaj: 0xd8342c, metro: 0xc9ccd1,
};

const $ = (id: string) => document.getElementById(id)!;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.5, 60000);
  readonly world: World;
  readonly env: Environment;
  readonly traffic: Traffic;
  readonly pedestrians: Pedestrians;
  readonly signals: Signals;
  readonly grass: Grass;
  readonly skid: Skidmarks;
  readonly audio = new AudioFx();
  readonly input: Input;
  readonly minimap: Minimap;
  state: SaveState;
  vehicle: Vehicle;
  model: VehicleModel;
  rental = false;
  walking = false;
  walker = { x: 0, z: 0, y: 0, heading: 0, mesh: buildPerson(0x2f6db5), anim: 0 };
  job: Job | null = null;
  navPts: [number, number][] | null = null;
  clock = 0;
  ready = false;
  private navMesh: THREE.Mesh | null = null;
  private navT = 0;
  private navTarget: { x: number; z: number } | null = null;
  private marker: THREE.Mesh;
  private camYaw = 0;
  private camHeading = 0;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  /** Dodatečné zpracování obrazu (střední a vysoká kvalita). */
  post = false;
  private camPitch = 0.28;
  private camDist = 1;
  private camPos = new THREE.Vector3();
  private camInit = false;
  private hudT = 0;
  private placeT = 0;
  private saveT = 0;
  private companyT = 0;
  private lastTime = performance.now();
  private loadStart = performance.now();
  private fps = 60;
  private pixelRatio = Math.min(window.devicePixelRatio, 1.75);
  private perfT = 0;
  private crashCool = 0;
  location = { place: '', street: '' };
  private labelEls = new Map<string, { el: HTMLDivElement; x: number; z: number; y: number }>();
  private labelT = 0;
  paused = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.world = new World(this.renderer);
    this.scene.add(this.world.root);
    this.env = new Environment(this.scene, this.renderer);
    this.traffic = new Traffic(this.world);
    this.scene.add(this.traffic.group);
    this.grass = new Grass(this.world);
    this.skid = new Skidmarks(this.world);
    this.scene.add(this.skid.mesh);
    this.scene.add(this.grass.mesh);
    this.signals = new Signals(this.world);
    this.scene.add(this.signals.group);
    this.traffic.signals = this.signals;
    this.pedestrians = new Pedestrians(this.world);
    this.scene.add(this.pedestrians.group);
    this.input = new Input(canvas);
    this.minimap = new Minimap($('minimap') as HTMLCanvasElement);
    const start = lonLatToWorld(CITIES[0].lon, CITIES[0].lat);
    this.state = loadState() ?? defaultState(start.x, start.z);
    this.applySettings();
    this.vehicle = new Vehicle(SPECS[this.state.vehicle]);
    this.model = buildVehicleModel(this.vehicle.spec, VEHICLE_COLORS[this.state.vehicle], true);
    addLightGlow(this.model, this.vehicle.spec);
    this.scene.add(this.model.root);
    this.scene.add(this.walker.mesh);
    this.walker.mesh.visible = false;
    this.marker = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, 160, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x5ee08a, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, fog: false }),
    );
    this.marker.visible = false;
    this.scene.add(this.marker);
    // Palubní deska pro pohled z kabiny (připojená ke kameře).
    this.scene.add(this.camera);
    this.cockpit = buildCockpit();
    this.cockpit.visible = false;
    this.camera.add(this.cockpit);
    this.fuel = this.state.fuel ?? 1;
    this.condition = this.state.condition ?? 1;
    this.vehicle.x = this.state.pos.x;
    this.vehicle.z = this.state.pos.z;
    this.vehicle.heading = this.state.pos.heading;
    this.walking = this.state.walking;
    this.world.onTileLoaded = () => this.minimap.dirty();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
    });
    window.addEventListener('beforeunload', () => this.save());
    const startAudio = () => {
      this.audio.start();
      this.audio.enabled = this.state.settings.sound;
    };
    window.addEventListener('pointerdown', startAudio, { once: true });
    window.addEventListener('keydown', startAudio, { once: true });
  }

  async start() {
    $('load-text').textContent = 'Načítám mapové podklady…';
    try {
      await this.world.init();
    } catch (e) {
      $('load-text').textContent = 'Nepodařilo se spojit s mapovým serverem (OpenFreeMap). Zkontrolujte připojení a obnovte stránku.';
      console.error(e);
      return;
    }
    // Sdílený odkaz: #50.08750/14.42050
    const m = /^#(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(location.hash);
    if (m) {
      const p = lonLatToWorld(Number(m[2]), Number(m[1]));
      this.state.pos = { x: p.x, z: p.z, heading: 0 };
      this.state.walking = false;
      this.walking = false;
      this.state.tutorialDone = true;
      history.replaceState(null, '', location.pathname);
    }
    this.teleport(this.state.pos.x, this.state.pos.z, this.state.pos.heading, !this.state.walking);
    void loadPid();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  applySettings() {
    const s = this.state.settings;
    const q = QUALITY[s.quality] ?? QUALITY['střední'];
    const aerial = s.surface === 'letecký snímek';
    if (this.world.quality !== q || this.world.aerial !== aerial) {
      this.world.aerial = aerial;
      this.world.setQuality(q);
    }
    this.env.setShadows(q.shadows);
    this.post = q.shadows;
    if (this.grass) this.grass.enabled = q.radius >= 2;
    if (this.post && !this.composer) this.setupComposer();
    this.env.season = s.season;
    if (s.weather !== 'skutečné') this.env.weather = s.weather;
    else this.weatherT = 0;
    this.env.time = s.time;
    this.env.timeSpeed = Math.max(0, s.timeSpeed);
    this.audio.enabled = s.sound;
    this.traffic.max = q.radius >= 2 ? 28 : 14;
    if (this.pedestrians) this.pedestrians.max = q.radius >= 2 ? 30 : 15;
  }

  private setupComposer() {
    const c = new EffectComposer(this.renderer);
    c.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.2, 0.5, 0.88);
    c.addPass(this.bloom);
    c.addPass(new OutputPass());
    // Jemná vinětace a teplejší barevné ladění.
    c.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        void main(){
          vec4 c = texture2D(tDiffuse, vUv);
          vec2 d = vUv - 0.5;
          float vig = smoothstep(0.85, 0.25, length(d * vec2(1.0, 0.8)));
          c.rgb *= mix(0.82, 1.0, vig);
          c.rgb = mix(c.rgb, c.rgb * vec3(1.03, 1.0, 0.96), 0.6);
          gl_FragColor = c;
        }`,
    }));
    this.composer = c;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const touch = matchMedia('(pointer: coarse)').matches;
    $('touch').classList.toggle('hidden', !touch);
  }

  // ------------------------------------------------------------ hráč

  /** Přesun kamkoli v republice. Čeká na načtení dlaždice, pak postaví auto na silnici. */
  teleport(x: number, z: number, heading = 0, snap = true) {
    this.ready = false;
    this.loadStart = performance.now();
    this.vehicle.x = x;
    this.vehicle.z = z;
    this.vehicle.heading = heading;
    this.walker.x = x;
    this.walker.z = z;
    this.pendingSnap = snap;
    this.weatherT = 3;
    this.traffic.clear();
    this.pedestrians.clear();
    this.signals.clear();
    this.world.rebase(x, z);
    this.camInit = false;
    $('loading').classList.remove('hidden', 'fade');
    this.minimap.dirty();
  }
  private pendingSnap = true;

  /** Najde nejbližší silnici a postaví na ni vozidlo po směru jízdy. */
  snapToRoad(x: number, z: number): { x: number; z: number; heading: number } | null {
    const flt = (e: { cls: string; tunnel?: boolean }) => !e.tunnel && e.cls !== 'path' && e.cls !== 'track' && e.cls !== 'motorway' && e.cls !== 'tram' && e.cls !== 'metro';
    const n = this.world.graph.nearest(x, z, 400, flt) ?? this.world.graph.nearest(x, z, 1500, flt);
    if (!n) return null;
    const e = n.e;
    const fwd = e.fwd;
    const a = fwd ? e.a : e.b;
    const b = fwd ? e.b : e.a;
    const t = fwd ? n.t : 1 - n.t;
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const off = e.fwd && e.back ? (e.width / 4) : 0;
    return {
      x: a.x + dx * t + (-dz / l) * off,
      z: a.z + dz * t + (dx / l) * off,
      heading: Math.atan2(dx, -dz),
    };
  }

  setVehicle(type: VehicleType, rental = false) {
    const v = this.vehicle;
    this.scene.remove(this.model.root);
    const nv = new Vehicle(SPECS[type]);
    const p = this.snapToRoad(this.walking ? this.walker.x : v.x, this.walking ? this.walker.z : v.z);
    const pos = p ?? { x: v.x, z: v.z, heading: v.heading };
    nv.place(pos.x, pos.z, pos.heading, this.world);
    this.vehicle = nv;
    this.model = buildVehicleModel(nv.spec, VEHICLE_COLORS[type], true);
    addLightGlow(this.model, nv.spec);
    this.scene.add(this.model.root);
    if (!rental) this.state.vehicle = type;
    this.rental = rental;
    this.walking = false;
    if (this.job instanceof BusJob) updateSign(this.model, this.job.line.number, this.job.line.stops[this.job.line.stops.length - 1].name);
    this.camInit = false;
  }

  get px() {
    return this.walking ? this.walker.x : this.vehicle.x;
  }

  get pz() {
    return this.walking ? this.walker.z : this.vehicle.z;
  }

  /** Vozidlo jede po kolejích (tramvaj, metro). */
  isRail(): boolean {
    return this.vehicle.spec.type === 'tramvaj' || this.vehicle.spec.type === 'metro';
  }

  toggleWalk() {
    const v = this.vehicle;
    if (this.metro) {
      this.notify('V tunelu metra vystoupit nelze.', 'warn');
      return;
    }
    if (!this.walking) {
      if (v.speed > 2) {
        this.notify('Nejdřív zastavte.', 'warn');
        return;
      }
      const [fx, fz] = v.forward();
      // Vystoupit vlevo od vozidla.
      this.walker.x = v.x + fz * (v.spec.width / 2 + 1.0);
      this.walker.z = v.z - fx * (v.spec.width / 2 + 1.0);
      this.walker.heading = v.heading;
      this.walking = true;
      v.vF = v.vL = v.yawRate = 0;
    } else {
      const d = Math.hypot(this.walker.x - v.x, this.walker.z - v.z);
      if (d > Math.max(6, v.spec.length / 2 + 3)) {
        this.notify('Vozidlo je moc daleko. Přistavte si ho v garáži (G).', 'warn');
        return;
      }
      this.walking = false;
    }
    this.camInit = false;
  }

  private updateCockpit(on: boolean) {
    const c = this.cockpit;
    const v = this.vehicle;
    const big = v.spec.mass > 5000;
    c.visible = on && !this.walking;
    if (!c.visible) return;
    const wheel = c.getObjectByName('wheel')!;
    wheel.rotation.z = -v.steer * 7;
    // Autobus a tramvaj: volant víc vlevo a plošší; metro bez volantu.
    wheel.visible = v.spec.type !== 'metro' && v.spec.type !== 'tramvaj';
    c.getObjectByName('pillars')!.visible = !big;
    c.position.set(big ? 0.05 : 0, big ? -0.08 : 0, 0);
    const speedo = c.getObjectByName('needle');
    if (speedo) speedo.rotation.z = 2.2 - Math.min(1, Math.abs(v.vF) / 55) * 4.4;
  }

  /** Dálková trasa po silnicích z veřejného směrovače OSRM (data OSM). */
  private async fetchLongRoute(job: FreightJob) {
    const a = worldToLonLat(this.px, this.pz);
    const b = worldToLonLat(job.dest.x, job.dest.z);
    try {
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}?overview=full&geometries=geojson`);
      const j = (await r.json()) as { routes?: { distance: number; geometry: { coordinates: [number, number][] } }[] };
      const route = j.routes?.[0];
      if (!route || this.job !== job) return;
      job.longRoute = route.geometry.coordinates.map(([lon, lat]) => {
        const p = lonLatToWorld(lon, lat);
        return [p.x, p.z] as [number, number];
      });
      job.km = route.distance / 1000;
      this.navT = 0;
    } catch {
      /* bez dálkové trasy zůstane ukazatel na minimapě */
    }
  }

  /** Zbytek dálkové trasy od bodu nejblíž hráči. */
  private longRouteFrom(job: Job): [number, number][] | null {
    if (!(job instanceof FreightJob) || !job.longRoute) return null;
    const p = job.longRoute;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < p.length; i++) {
      const d = Math.hypot(p[i][0] - this.px, p[i][1] - this.pz);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return [[this.px, this.pz], ...p.slice(bi)];
  }

  /** Nejbližší čerpací stanice v dosahu (30 m). */
  nearFuel(): { name: string; d: number } | null {
    let best: { name: string; d: number } | null = null;
    for (const f of this.world.allFuel()) {
      const d = Math.hypot(f.x - this.vehicle.x, f.z - this.vehicle.z);
      if (d < 35 && (!best || d < best.d)) best = { name: f.name, d };
    }
    return best;
  }

  refuel() {
    const v = this.vehicle;
    if (this.rental) {
      this.notify('Firemní vůz tankuje firma.', 'info');
      return;
    }
    const st = this.nearFuel();
    if (!st) {
      this.notify('Tankovat lze jen u čerpací stanice.', 'warn');
      return;
    }
    if (v.speed > 0.5) {
      this.notify('Nejdřív zastavte.', 'warn');
      return;
    }
    const litres = (1 - this.fuel) * v.spec.tank;
    if (litres < 0.5) {
      this.notify('Nádrž je plná.', 'info');
      return;
    }
    const price = Math.round(litres * 38.9);
    this.state.money -= price;
    this.fuel = 1;
    this.fuelWarn = false;
    this.audio.chime();
    this.notify(`${st.name}: natankováno ${litres.toFixed(1)} l za ${formatMoney(price)}`, 'ok');
  }

  /** Odkaz na aktuální místo. */
  shareLink(): string {
    const { lon, lat } = worldToLonLat(this.px, this.pz);
    return `${location.origin}${location.pathname}#${lat.toFixed(5)}/${lon.toFixed(5)}`;
  }

  notify(msg: string, kind: 'ok' | 'warn' | 'info' = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    const box = $('toasts');
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild!.remove();
    setTimeout(() => t.remove(), 4200);
  }

  pay(amount: number, xp: number) {
    const before = level(this.state.xp);
    this.state.money += amount;
    this.state.xp += xp;
    this.state.stats.earned += Math.max(0, amount);
    if (level(this.state.xp) > before) this.notify(`Nová úroveň ${level(this.state.xp)}!`, 'ok');
  }

  startJob(job: Job) {
    this.cancelJob();
    this.job = job;
    if (job instanceof FreightJob) void this.fetchLongRoute(job);
    this.navPts = null;
    this.navTarget = null;
    this.navT = 0;
    if (job instanceof BusJob) updateSign(this.model, job.line.number, job.line.stops[job.line.stops.length - 1].name);
    // Tramvaj jede po kolejích celé trasy linky.
    if (job instanceof BusJob && (job.line.mode === 'tram' || job.line.mode === 'metro')) {
      let path: [number, number][] = [];
      for (const l of job.line.legs) path = path.concat(path.length ? l.slice(1) : l);
      if (job.line.mode === 'metro') {
        const lc = { A: [0, 0.65, 0.38], B: [0.97, 0.7, 0.13], C: [0.86, 0.2, 0.22] }[job.line.number] ?? [0.5, 0.5, 0.5];
        this.metro = new MetroTunnel(this.world, path, job.line.stops, lc);
        this.model.root.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m?.userData?.stripe) m.color.setRGB(lc[0], lc[1], lc[2]);
        });
        this.scene.add(this.metro.group);
        this.state.settings.camera = 1;
      }
      this.setTramPath(path);
    } else this.tramPath = null;
  }

  private setTramPath(path: [number, number][]) {
    // Dopředu trochu prodloužit začátek, aby tramvaj stála celá na trati.
    this.tramPath = path;
    this.tramCum = [0];
    for (let i = 1; i < path.length; i++) this.tramCum.push(this.tramCum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    // Metro: čelo na konci nástupiště výchozí stanice (stanice sahá ±70 m).
    this.tramS = Math.min(this.metro ? 64 : this.vehicle.spec.length + 2, this.tramCum[this.tramCum.length - 1]);
    this.placeTram(0);
  }

  private tramPoint(s: number): [number, number] {
    const p = this.tramPath!;
    const c = this.tramCum;
    s = Math.max(0, Math.min(c[c.length - 1], s));
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m;
      else hi = m;
    }
    const seg = c[hi] - c[lo] || 1;
    const t = (s - c[lo]) / seg;
    return [p[lo][0] + (p[hi][0] - p[lo][0]) * t, p[lo][1] + (p[hi][1] - p[lo][1]) * t];
  }

  /** Umístí tramvaj: přední konec na s, zadní o délku vozu zpět po trati. */
  private placeTram(dt: number) {
    const v = this.vehicle;
    const L = v.spec.length;
    const f = this.tramPoint(this.tramS);
    const r = this.tramPoint(this.tramS - L);
    const h = Math.atan2(f[0] - r[0], -(f[1] - r[1]));
    if (dt > 0) {
      let dh = h - v.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      v.yawRate = dh / dt;
    }
    v.heading = h;
    v.x = (f[0] + r[0]) / 2;
    v.z = (f[1] + r[1]) / 2;
    if (this.metro) {
      const yf = this.metro.yAtS(this.tramS), yr = this.metro.yAtS(this.tramS - L);
      v.y = (yf + yr) / 2;
      v.pitch = Math.atan2(yf - yr, L);
      v.roll = 0;
      return;
    }
    const g = this.world.groundHeight(v.x, v.z, v.y + 1);
    if (!Number.isNaN(g)) v.y = g;
  }

  private updateTram(dt: number, ax: { throttle: number; brake: number }) {
    const v = this.vehicle;
    const end = this.tramCum[this.tramCum.length - 1];
    const prev = v.vF;
    let a = ax.throttle * 1.3 - ax.brake * 1.8 - (v.vF > 0 ? 0.08 : 0);
    if (v.doorsOpen) a = -3;
    v.vF = Math.max(0, Math.min(v.spec.vmax, v.vF + a * dt));
    if (this.tramS >= end - 0.5) v.vF = 0;
    this.tramS = Math.min(end, this.tramS + v.vF * dt);
    v.vL = 0;
    v.accel = (v.vF - prev) / Math.max(dt, 1e-3);
    this.placeTram(dt);
    v.latAccel = v.vF * v.yawRate;
    v.rpm = 600 + v.vF * 90;
    v.gear = 1;
    v.odometer += v.vF * dt;
    v.onRoad = v.spec.type === 'metro' ? 'metro' : 'tram';
  }

  private endMetro() {
    if (!this.metro) return;
    this.metro.dispose();
    this.metro = null;
    this.state.settings.camera = 0;
  }

  cancelJob() {
    if (!this.job) return;
    this.tramPath = null;
    this.endMetro();
    this.job.dispose();
    this.job = null;
    this.navPts = null;
    this.setNavMesh(null);
    this.marker.visible = false;
    if (this.rental) {
      this.notify('Půjčené vozidlo vráceno.', 'info');
      this.setVehicle(this.state.garage.includes(this.state.vehicle) ? this.state.vehicle : this.state.garage[0] ?? 'auto');
    }
    updateSign(this.model, '---', '');
  }

  private jobCtx(): JobCtx {
    return {
      world: this.world,
      vehicle: this.walking ? null : this.vehicle,
      model: this.model,
      scene: this.scene,
      walking: this.walking,
      notify: (m, k) => this.notify(m, k),
      chime: () => this.audio.chime(),
      clock: this.clock,
      yAt: this.metro ? (x: number, z: number) => this.metro!.platformY(x, z) : undefined,
    };
  }

  save() {
    const s = this.state;
    s.pos = { x: this.px, z: this.pz, heading: this.walking ? this.walker.heading : this.vehicle.heading };
    s.walking = this.walking;
    s.settings.time = this.env.time;
    if (!this.rental) {
      s.vehicle = this.vehicle.spec.type;
      s.fuel = this.fuel;
      s.condition = this.condition;
    }
    saveState(s);
  }

  // ------------------------------------------------------------ smyčka

  private frame() {
    const now = performance.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.fps = this.fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1;
    dt = Math.min(dt, 0.05);
    if (this.paused || currentPanel()) {
      // Hra běží dál za panelem, ale bez vstupu.
    }
    this.clock += dt;
    const inPanel = !!currentPanel();
    this.handleKeys(inPanel);

    {
      // Rychlost pro přednačítání dlaždic ve směru jízdy.
      const v = this.vehicle;
      const [fx, fz] = v.forward();
      const vx = this.walking ? 0 : fx * v.vF - fz * v.vL;
      const vz = this.walking ? 0 : fz * v.vF + fx * v.vL;
      this.world.update(this.px, this.pz, vx, vz);
    }
    if (this.world.rebase(this.px, this.pz)) {
      this.minimap.dirty();
      this.navMeshDirty = true;
    }

    if (!this.ready) {
      this.camInit = false;
      this.waitForWorld();
    } else {
      if (this.walking) this.updateWalker(dt, inPanel);
      else this.updateVehicle(dt, inPanel);
      this.updateJob(dt);
      this.traffic.update(dt, this.px, this.pz, this.walking ? null : this.vehicle, this.state.company?.lines ?? [], this.env.night);
      this.pedestrians.update(dt, this.px, this.pz, this.walking ? null : this.vehicle);
      this.signals.update(dt, this.px, this.pz);
      this.grass.update(dt, this.px, this.pz, this.env.season);
      this.metro?.update();
      this.env.underground = !!this.metro;
      this.placeT -= dt;
      if (this.placeT <= 0) {
        this.placeT = 1;
        this.checkPlaces();
      }
      this.saveT -= dt;
      if (this.saveT <= 0) {
        this.saveT = 10;
        this.save();
      }
      this.companyT -= dt;
      if (this.companyT <= 0) {
        this.companyT = 30;
        this.companyTick();
      }
    }
    this.updateCamera(dt);
    this.env.update(dt, this.camera.position, this.focus());
    this.world.mats.walls.emissiveIntensity = this.env.night * 1.4;
    this.world.mats.shop.emissiveIntensity = this.env.night * 1.6;
    this.world.mats.panel.emissiveIntensity = this.env.night * 1.4;
    this.world.mats.house.emissiveIntensity = this.env.night * 1.3;
    this.world.mats.hall.emissiveIntensity = this.env.night * 0.6;
    for (const m of Object.values(this.world.mats.facade)) m.emissiveIntensity = this.env.night * 1.4;
    for (const m of this.world.signMats) m.emissiveIntensity = 0.15 + this.env.night * 1.1;
    this.world.mats.lamp.emissiveIntensity = this.env.night > 0.4 ? 2.5 : 0;
    this.world.mats.glow.opacity = Math.max(0, this.env.night - 0.3) * 1.2;
    this.world.mats.pool.opacity = Math.min(0.3, Math.max(0, this.env.night - 0.35) * 0.5);
    this.world.mats.pool.visible = this.env.night > 0.35;
    LIGHT_GLOW.head.opacity = Math.max(0, this.env.night - 0.3) * 1.1;
    LIGHT_GLOW.tail.opacity = Math.max(0, this.env.night - 0.3) * 1.0;
    this.world.setSeason(this.env.season);
    this.adaptPerformance(dt);
    this.updateRealWorld(dt);
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.1;
      this.updateHud();
    }
    this.minimap.draw(this);
    if (this.composer && this.post) {
      this.bloom!.strength = Math.max(0, this.env.night - 0.2) * 0.7;
      this.bloom!.enabled = this.bloom!.strength > 0.01;
      this.composer.render();
    } else this.renderer.render(this.scene, this.camera);
    this.updateLabels(dt);
    this.input.endFrame();
  }

  private navMeshDirty = false;
  private urbanT = 0;
  weatherT = 0;
  realWeather = '';
  private speedT = 0;
  private redNode: unknown = null;
  private introT = 0;
  private cockpit!: THREE.Group;
  private compiling = false;
  private shadersReady = false;
  /** Trasa tramvaje (x, z) a kumulativní délky. */
  private tramPath: [number, number][] | null = null;
  private tramCum: number[] = [];
  private tramS = 0;
  /** Tunel metra během práce v metru. */
  metro: MetroTunnel | null = null;
  /** Palivo 0..1. */
  fuel = 1;
  /** Stav vozidla 0..1. */
  condition = 1;
  private fuelWarn = false;
  private urban = false;

  /** Rychlostní limit: v obci max. 50 km/h (kromě dálnic a rychlostních silnic). */
  speedLimit(cls: string | null): number | null {
    if (!cls || cls === 'path') return null;
    const lim = SPEED_LIMIT[cls];
    if (!lim) return null;
    if (this.urban && cls !== 'motorway' && cls !== 'trunk' && cls !== 'metro') return Math.min(lim, 50);
    return lim;
  }

  /** Skutečný čas a počasí (Open-Meteo) podle nastavení. */
  private updateRealWorld(dt: number) {
    const s = this.state.settings;
    if (s.timeSpeed < 0) {
      const d = new Date();
      this.env.time = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
      const m = d.getMonth();
      this.env.season = m <= 1 || m === 11 ? 'zima' : m <= 4 ? 'jaro' : m <= 7 ? 'léto' : 'podzim';
    }
    if (s.weather !== 'skutečné' || !this.ready) return;
    this.weatherT -= dt;
    if (this.weatherT > 0) return;
    this.weatherT = 600;
    const { lon, lat } = worldToLonLat(this.px, this.pz);
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=weather_code,temperature_2m`)
      .then((r) => r.json())
      .then((j: { current?: { weather_code: number; temperature_2m: number } }) => {
        const c = j.current?.weather_code;
        if (c === undefined) return;
        this.env.weather = c <= 1 ? 'jasno' : c <= 3 ? 'oblačno' : c <= 48 ? 'mlha' : (c >= 71 && c <= 77) || c === 85 || c === 86 ? 'sníh' : 'déšť';
        this.realWeather = `${Math.round(j.current!.temperature_2m)} °C`;
      })
      .catch(() => {
        this.weatherT = 120;
      });
  }

  /** Dynamické rozlišení: při nízkém FPS sníží vykreslovací rozlišení, při rezervě ho vrátí. */
  private adaptPerformance(dt: number) {
    if (!this.ready || document.hidden) return;
    this.perfT += dt;
    if (this.perfT < 2) return;
    this.perfT = 0;
    const max = Math.min(window.devicePixelRatio, 1.75);
    let pr = this.pixelRatio;
    if (this.fps < 28 && pr > 0.6) pr = Math.max(0.6, pr - 0.15);
    else if (this.fps > 55 && pr < max) pr = Math.min(max, pr + 0.1);
    if (Math.abs(pr - this.pixelRatio) > 0.01) {
      this.pixelRatio = pr;
      this.renderer.setPixelRatio(pr);
      this.resize();
    }
  }

  private focus(): THREE.Vector3 {
    const y = this.walking ? this.walker.y : this.vehicle.y;
    return this.world.toScene(this.px, this.pz, new THREE.Vector3(), y);
  }

  private waitForWorld() {
    const x = this.px, z = this.pz;
    const tilesWanted = Math.max(1, this.world.near.size + this.world.stats.pending);
    const frac = this.world.near.size / tilesWanted;
    ($('load-bar') as HTMLElement).style.width = `${Math.round(10 + frac * 90)}%`;
    const secs = (performance.now() - this.loadStart) / 1000;
    $('load-text').textContent = this.world.stats.errors && secs > 15
      ? 'Některé dlaždice se nepodařilo načíst, zkouším dál…'
      : `Stahuji budovy, silnice a terén… (${this.world.near.size}/${tilesWanted})`;
    if (this.compiling) {
      $('load-text').textContent = 'Připravuji grafiku…';
      return;
    }
    if (!this.world.isReady(x, z)) return;
    const h = this.world.terrainHeight(x, z);
    if (Number.isNaN(h)) return;
    if (this.pendingSnap || !this.walking) {
      const p = this.pendingSnap ? this.snapToRoad(x, z) : null;
      const pos = p ?? { x, z, heading: this.vehicle.heading };
      this.vehicle.place(pos.x, pos.z, pos.heading, this.world);
    } else {
      this.vehicle.place(x, z, this.vehicle.heading, this.world);
    }
    if (this.walking) {
      this.walker.y = this.world.groundHeight(this.walker.x, this.walker.z, 9999);
    }
    // Shadery zkompilovat ještě za načítací obrazovkou (asynchronně, kde to prohlížeč umí),
    // aby se hra po spuštění nezasekla.
    if (!this.shadersReady) {
      this.compiling = true;
      this.updateCamera(0);
      this.renderer.compileAsync(this.scene, this.camera)
        .catch(() => {})
        .then(() => {
          this.shadersReady = true;
          this.compiling = false;
        });
      return;
    }
    this.ready = true;
    this.introT = 3.2;
    $('loading').classList.add('fade');
    $('hud').classList.remove('hidden');
    setTimeout(() => $('loading').classList.add('hidden'), 700);
    if (!this.state.tutorialDone) {
      this.state.tutorialDone = true;
      openPanel(this, 'welcome');
    }
  }

  private handleKeys(inPanel: boolean) {
    const i = this.input;
    if (i.hit('Escape')) {
      if (inPanel) closePanel();
      else openPanel(this, 'settings');
    }
    const panels: Record<string, string> = { KeyM: 'map', KeyJ: 'jobs', KeyG: 'garage', KeyF: 'company', KeyL: 'journal', KeyH: 'help' };
    for (const [k, p] of Object.entries(panels)) {
      if (i.hit(k)) {
        if (currentPanel() === p) closePanel();
        else openPanel(this, p);
      }
    }
    if (inPanel || !this.ready) return;
    if (i.hit('KeyU')) {
      // Fotorežim: skrýt rozhraní.
      $('hud').classList.toggle('hidden');
      $('labels').classList.toggle('hidden');
    }
    if (i.hit('KeyC')) {
      this.state.settings.camera = (this.state.settings.camera + 1) % 3;
      this.camInit = false;
    }
    if (i.hit('KeyE')) this.toggleWalk();
    if (i.hit('KeyO') && !this.walking) {
      const v = this.vehicle;
      if (v.speed > 1) this.notify('Dveře lze otevřít jen ve stání.', 'warn');
      else {
        v.doorsOpen = !v.doorsOpen;
        this.audio.beep(v.doorsOpen ? 520 : 420, 0.18, 'triangle');
      }
    }
    if (i.hit('KeyT') && !this.walking) this.refuel();
    this.audio.horn(!inPanel && !this.walking && i.down('KeyQ'));
    if (i.hit('KeyR') && this.isRail() && this.tramPath && !this.walking) {
      this.placeTram(0);
    } else if (i.hit('KeyR')) {
      const p = this.snapToRoad(this.px, this.pz);
      if (p) {
        if (this.walking) {
          this.walker.x = p.x;
          this.walker.z = p.z;
        } else this.vehicle.place(p.x, p.z, p.heading, this.world);
        this.notify('Vráceno na silnici.', 'info');
      }
    }
  }

  private updateVehicle(dt: number, inPanel: boolean) {
    const v = this.vehicle;
    const ax = inPanel ? { throttle: 0, brake: 0, steer: 0, handbrake: false } : this.input.axes();
    // Palivo: spotřeba podle ujeté vzdálenosti a plynu; půjčené vozy tankuje firma.
    if (!this.rental) {
      const km = (Math.abs(v.vF) * dt) / 1000;
      const used = (km * v.spec.consumption * (0.6 + ax.throttle * 0.8)) / 100 + (dt * 0.2 * v.spec.consumption) / 360000;
      this.fuel = Math.max(0, this.fuel - used / v.spec.tank);
      if (this.fuel < 0.12 && !this.fuelWarn) {
        this.fuelWarn = true;
        this.notify('Dochází palivo – zastavte u čerpací stanice (T = tankovat).', 'warn');
      }
      if (this.fuel <= 0) ax.throttle = 0;
      // Poškozené vozidlo má menší výkon.
      if (this.condition < 0.5) ax.throttle *= 0.5 + this.condition;
    }
    const obstacles = [...this.traffic.obstacles(), ...this.pedestrians.obstacles()].filter((o) => Math.hypot(o.x - v.x, o.z - v.z) < 30);
    if (this.isRail() && this.tramPath) this.updateTram(dt, ax);
    else {
      v.update(dt, ax, this.world, this.env.grip(), obstacles);
      v.updateAttitude(this.world, dt);
      this.skid.update(v, true);
    }
    this.crashCool -= dt;
    for (const imp of v.impacts) {
      if (imp.speed > 3 && this.crashCool <= 0) {
        this.audio.crash();
        this.state.stats.crashes++;
        this.crashCool = 1;
        if (!this.rental) {
          const before = this.condition;
          this.condition = Math.max(0, this.condition - Math.min(0.35, imp.speed * 0.012));
          if (before >= 0.5 && this.condition < 0.5) this.notify('Vozidlo je poškozené – opravte ho v garáži (G).', 'warn');
        }
      }
    }
    if (!this.job) v.impacts.length = 0;
    // Jízda na červenou.
    const sig = this.signals.ahead(v.x, v.z, v.heading);
    if (sig && sig.dist < 2 && sig.light === 'red' && v.vF > 3 && this.redNode !== sig.node) {
      this.redNode = sig.node;
      this.audio.beep(300, 0.25, 'square');
      this.notify('Projeli jste na červenou!', 'warn');
      if (this.job) this.job.speeding++;
    }
    // Přestupky při práci: delší jízda o víc než 10 km/h nad limit.
    const lim = this.speedLimit(v.onRoad);
    if (this.job && lim && Math.abs(v.vF) * 3.6 > lim + 10) {
      this.speedT += dt;
      if (this.speedT > 3) {
        this.speedT = -10;
        this.job.speeding++;
        this.notify(`Překročení rychlosti (${lim} km/h) – sníží to hodnocení`, 'warn');
      }
    } else if (this.speedT > 0) this.speedT = 0;
    else this.speedT = Math.min(0, this.speedT + dt);
    const m = this.model;
    this.world.toScene(v.x, v.z, m.root.position, v.y);
    m.root.rotation.order = 'YXZ';
    m.root.rotation.set(v.pitch, -v.heading, -v.roll);
    for (const w of m.frontWheels) w.rotation.y = -v.steer;
    const spin = (v.vF * dt) / (m.wheels[0] ? 0.4 : 1);
    for (const w of m.wheels) w.children.forEach((c) => (c.rotation.x -= spin));
    for (const d of m.doors) d.position.x = v.spec.width / 2 + (v.doorsOpen ? 0.28 : 0.02);
    const night = this.env.night;
    if (m.headlights) m.headlights.intensity = night > 0.35 ? 260 : 0;
    m.lightMats[0].emissiveIntensity = night > 0.35 ? 3 : 0.2;
    m.brakeMat.emissiveIntensity = ax.brake > 0.1 && v.vF > 0.3 ? 3 : night > 0.35 ? 1 : 0.2;
    this.state.stats.distance += Math.abs(v.vF) * dt;
    this.audio.update(v.rpm, ax.throttle, v.speed, v.spec.mass > 5000, this.env.weather === 'déšť', true);
    this.audio.squeal(v.airborne || v.speed < 3 ? 0 : Math.max(0, v.slip - 0.35) * 1.4);
    this.walker.mesh.visible = false;
    // Z kabiny: osobní auto skryté; kolejová vozidla také (kamera je za čelním sklem modelu).
    m.root.visible = !(this.state.settings.camera === 1 || this.metro);
  }

  private updateWalker(dt: number, inPanel: boolean) {
    const w = this.walker;
    const i = this.input;
    const ax = inPanel ? { throttle: 0, brake: 0, steer: 0, handbrake: false } : i.axes();
    const run = i.down('ShiftLeft', 'ShiftRight') || ax.handbrake;
    const sp = (run ? 6 : 2.2) * (ax.throttle - ax.brake * 0.6);
    w.heading += ax.steer * dt * 2.6;
    const fx = Math.sin(w.heading), fz = -Math.cos(w.heading);
    w.x += fx * sp * dt;
    w.z += fz * sp * dt;
    const c = this.world.collide(w.x, w.z, 0.35);
    if (c) {
      w.x += c.px;
      w.z += c.pz;
    }
    const g = this.world.groundHeight(w.x, w.z, w.y + 1);
    if (!Number.isNaN(g)) w.y = g;
    w.anim += Math.abs(sp) * dt * 3;
    this.world.toScene(w.x, w.z, w.mesh.position, w.y);
    w.mesh.rotation.y = -w.heading;
    w.mesh.position.y += Math.abs(Math.sin(w.anim)) * 0.05 * Math.min(1, Math.abs(sp));
    w.mesh.visible = this.state.settings.camera !== 1;
    this.state.stats.distance += Math.abs(sp) * dt;
    // Zaparkované vozidlo zůstává ve scéně.
    const v = this.vehicle;
    this.world.toScene(v.x, v.z, this.model.root.position, v.y);
    this.model.root.visible = true;
    if (this.model.headlights) this.model.headlights.intensity = 0;
    this.audio.update(0, 0, 0, false, this.env.weather === 'déšť', false);
    this.audio.squeal(0);
  }

  private updateCamera(dt: number) {
    const i = this.input;
    if (i.dragging) {
      this.camYaw -= i.mouseDX * 0.005;
      this.camPitch = Math.max(-0.1, Math.min(1.3, this.camPitch + i.mouseDY * 0.004));
    } else {
      this.camYaw *= 1 - Math.min(1, dt * 1.5);
    }
    if (i.wheel) this.camDist = Math.max(0.4, Math.min(4, this.camDist * (1 + i.wheel * 0.12)));
    const mode = this.state.settings.camera;
    const v = this.vehicle;
    let heading = this.walking ? this.walker.heading : v.heading;
    // Kamera se plynule stáčí za vozem; ve smyku se dívá spíš ve směru pohybu.
    if (!this.walking && v.speed > 3) {
      const [vfx, vfz] = v.forward();
      const mx = vfx * v.vF + -vfz * v.vL, mz = vfz * v.vF + vfx * v.vL;
      const velH = Math.atan2(mx, -mz);
      let dv = velH - heading;
      while (dv > Math.PI) dv -= Math.PI * 2;
      while (dv < -Math.PI) dv += Math.PI * 2;
      if (v.vF > 0) heading += dv * 0.45;
    }
    let dh = heading - this.camHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    if (!this.camInit || Math.abs(dh) > 2.5) this.camHeading = heading;
    else this.camHeading += dh * Math.min(1, dt * (this.walking ? 6 : 3.2));
    heading = this.camHeading;
    const target = this.focus();
    const yaw = heading + this.camYaw;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    let desired: THREE.Vector3;
    let look: THREE.Vector3;
    if ((mode === 1 || this.metro) && !this.walking) {
      // Pohled z místa řidiče.
      const s = v.spec;
      const along = s.mass > 5000 ? s.length / 2 - 1.1 : 0.2;
      const side = s.mass > 5000 ? -0.6 : -0.38;
      const up = s.mass > 5000 ? 2.4 : 1.15;
      const hf = Math.sin(v.heading), hz = -Math.cos(v.heading);
      desired = target.clone();
      desired.y += up;
      desired.x = target.x + hf * along + (-hz) * side;
      desired.z = target.z + hz * along + hf * side;
      // Na kolejích: výška kabiny podle trati (vlak je dlouhý a trať se svažuje).
      if (this.isRail() && this.tramPath) {
        // Kabina = čelo vlaku na trati (model může být na začátku trasy zkrácený).
        const [cxw, czw] = this.tramPoint(this.tramS - 1.1);
        const o = this.world.origin;
        desired.x = cxw - o.x + (-hz) * side;
        desired.z = czw - o.z + hf * side;
        const yf = this.metro ? this.metro.yAtS(this.tramS - 1.1) : v.y + Math.sin(v.pitch) * along;
        desired.y = yf + up;
      }
      look = desired.clone().add(new THREE.Vector3(fx * 30, -2 + Math.tan(v.pitch) * 30, fz * 30));
      this.camera.position.copy(desired);
      this.camera.lookAt(look);
      this.camera.fov = 70;
      this.camera.updateProjectionMatrix();
      this.updateCockpit(true);
      return;
    }
    this.updateCockpit(false);
    const base = (this.walking ? 4.5 : Math.max(7, v.spec.length * 1.25)) * (this.camera.aspect < 1 ? 1.5 : 1);
    const dist = base * this.camDist * (mode === 2 ? 3.2 : 1) * (this.walking ? 1 : 1 + Math.min(0.25, v.speed * 0.006));
    const pitch = mode === 2 ? Math.max(this.camPitch, 0.7) : this.camPitch;
    desired = target.clone().add(new THREE.Vector3(-fx * dist * Math.cos(pitch), dist * Math.sin(pitch) + (this.walking ? 1.6 : v.spec.height * 0.6), -fz * dist * Math.cos(pitch)));
    // Nepodlézt pod terén.
    const gx = desired.x + this.world.origin.x, gz = desired.z + this.world.origin.z;
    const gh = this.world.terrainHeight(gx, gz);
    if (!Number.isNaN(gh)) desired.y = Math.max(desired.y, gh + 1.2);
    // Kamera nesmí skončit ve zdi: když mezi vozidlem a kamerou stojí budova,
    // nejdřív ji zvednout výš (strmější pohled), a teprve pak přiblížit.
    {
      const o = this.world.origin;
      const eyeY = target.y + 1.5;
      const blocked = (d: THREE.Vector3) => this.world.segmentHit(target.x + o.x, target.z + o.z, d.x + o.x, d.z + o.z, eyeY, d.y);
      let hit = blocked(desired);
      if (hit < 1) {
        const horiz = Math.hypot(desired.x - target.x, desired.z - target.z);
        const total = Math.hypot(horiz, desired.y - target.y);
        let p = Math.atan2(desired.y - target.y, horiz);
        while (hit < 1 && p < 1.35) {
          p += 0.12;
          const k = (total * Math.cos(p)) / (horiz || 1);
          const cand = new THREE.Vector3(target.x + (desired.x - target.x) * k, target.y + total * Math.sin(p), target.z + (desired.z - target.z) * k);
          hit = blocked(cand);
          if (hit >= 1) desired.copy(cand);
        }
      }
      if (hit < 1) {
        const t = Math.max(0.15, hit - 0.6 / Math.max(1, target.distanceTo(desired)));
        desired.x = target.x + (desired.x - target.x) * t;
        desired.y = target.y + (desired.y - target.y) * t;
        desired.z = target.z + (desired.z - target.z) * t;
        desired.y = Math.max(desired.y, target.y + 3);
      }
    }
    // Úvodní přílet kamery z výšky.
    if (this.introT > 0) {
      this.introT -= dt;
      const k = Math.max(0, this.introT / 3.2);
      const e = k * k * (3 - 2 * k);
      const high = target.clone().add(new THREE.Vector3(-fx * 260, 380, -fz * 260));
      desired.lerp(high, e);
      this.camPos.copy(desired);
      this.camInit = true;
    }
    if (!this.camInit) {
      this.camPos.copy(desired);
      this.camInit = true;
    }
    const k = 1 - Math.exp(-dt * (this.walking ? 8 : 5));
    this.camPos.lerp(desired, k);
    this.camera.position.copy(this.camPos);
    look = target.clone();
    look.y += this.walking ? 1.4 : v.spec.height * 0.7;
    this.camera.lookAt(look);
    const fov = 60 + Math.min(12, (this.walking ? 0 : v.speed) * 0.25);
    if (Math.abs(this.camera.fov - fov) > 0.1) {
      this.camera.fov += (fov - this.camera.fov) * k;
      this.camera.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------ práce

  private updateJob(dt: number) {
    const job = this.job;
    if (!job) {
      this.marker.visible = false;
      return;
    }
    const ctx = this.jobCtx();
    job.update(dt, ctx);
    $('job').innerHTML = job.status(ctx) + '<br><button class="btn" id="job-cancel">Zrušit práci</button>';
    ($('job-cancel') as HTMLButtonElement).onclick = () => {
      this.cancelJob();
      $('job').classList.add('hidden');
    };
    $('job').classList.remove('hidden');
    const t = job.target();
    if (t) {
      const y = this.world.terrainHeight(t.x, t.z);
      this.world.toScene(t.x, t.z, this.marker.position, (Number.isNaN(y) ? this.vehicle.y : y) + 80);
      this.marker.visible = true;
      // Navigace.
      this.navT -= dt;
      const moved = this.navTarget ? Math.hypot(this.navTarget.x - t.x, this.navTarget.z - t.z) > 1 : true;
      if (moved || this.navT <= 0 || this.navMeshDirty) {
        this.navT = 3;
        this.navMeshDirty = false;
        this.navTarget = { x: t.x, z: t.z };
        if (this.isRail() && this.tramPath && !this.walking) {
          // Kolejová vozidla: navigace = zbytek trasy linky.
          let k = 0;
          while (k < this.tramCum.length - 1 && this.tramCum[k] < this.tramS) k++;
          this.navPts = this.tramPath.slice(Math.max(0, k - 1));
          this.setNavMesh(this.metro ? null : this.navPts);
        } else {
          const profile = this.walking ? 'walk' : this.vehicle.spec.mass > 5000 ? 'bus' : 'car';
          const r = this.world.graph.route(this.px, this.pz, t.x, t.z, profile, 40000);
          this.navPts = r ? r.pts : this.longRouteFrom(job);
          this.setNavMesh(this.navPts);
        }
      }
    } else this.marker.visible = false;
    if (job.done) {
      const res = job.result!;
      let pay = res.pay;
      if (this.rental) pay = Math.round(pay * 0.7);
      this.pay(pay, res.xp);
      const st = this.state.stats;
      st.jobs++;
      st.busStops += res.stats.busStops ?? 0;
      st.passengers += res.stats.passengers ?? 0;
      st.taxiRides += res.stats.taxiRides ?? 0;
      st.deliveries += res.stats.deliveries ?? 0;
      const rental = this.rental;
      this.job = null;
      job.dispose();
      this.navPts = null;
      this.setNavMesh(null);
      this.marker.visible = false;
      $('job').classList.add('hidden');
      this.audio.chime();
      this.endMetro();
      this.tramPath = null;
      if (rental) {
        this.setVehicle(this.state.garage.includes(this.state.vehicle) ? this.state.vehicle : this.state.garage[0] ?? 'auto');
        this.rental = false;
      }
      showJobResult(this, res, pay, rental);
      this.save();
    }
  }

  private setNavMesh(pts: [number, number][] | null) {
    if (this.navMesh) {
      this.scene.remove(this.navMesh);
      this.navMesh.geometry.dispose();
      this.navMesh = null;
    }
    if (!pts || pts.length < 2) return;
    const pos: number[] = [];
    const w = 0.8;
    // Jen prvních ~1,5 km, aby se mesh nestavěl zbytečně velký.
    let acc = 0;
    for (let i = 0; i + 1 < pts.length && acc < 1500; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 0.01) continue;
      acc += l;
      const n = Math.max(1, Math.ceil(l / 6));
      const nx = (-(bz - az) / l) * w, nz = ((bx - ax) / l) * w;
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const p0x = ax + (bx - ax) * t0, p0z = az + (bz - az) * t0;
        const p1x = ax + (bx - ax) * t1, p1z = az + (bz - az) * t1;
        const h0 = this.world.groundHeight(p0x, p0z, this.vehicle.y + 1) + 0.32;
        const h1 = this.world.groundHeight(p1x, p1z, this.vehicle.y + 1) + 0.32;
        if (Number.isNaN(h0 + h1)) continue;
        const o = this.world.origin;
        const q = [
          [p0x - nx - o.x, h0, p0z - nz - o.z], [p0x + nx - o.x, h0, p0z + nz - o.z],
          [p1x - nx - o.x, h1, p1z - nz - o.z], [p1x + nx - o.x, h1, p1z + nz - o.z],
        ];
        pos.push(...q[0], ...q[1], ...q[2], ...q[2], ...q[1], ...q[3]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.navMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x47e07a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }));
    this.navMesh.renderOrder = 2;
    this.scene.add(this.navMesh);
  }

  // ------------------------------------------------------------ deník a firma

  private checkPlaces() {
    const radius: Record<string, number> = { city: 2500, town: 1300, village: 550, suburb: 450, quarter: 400, neighbourhood: 300, hamlet: 260, isolated_dwelling: 150, locality: 200 };
    let best: { name: string; d: number; w: number } | null = null;
    for (const p of this.world.allPlaces()) {
      const d = Math.hypot(p.x - this.px, p.z - this.pz);
      const r = radius[p.cls] ?? 300;
      if (d < r) {
        const key = `${p.name}|${p.cls}|${Math.round(p.x / 2000)}|${Math.round(p.z / 2000)}`;
        if (!this.state.visited[key]) {
          this.state.visited[key] = { name: p.name, cls: p.cls, x: p.x, z: p.z, t: Date.now() };
          const label = { city: 'Město', town: 'Město', village: 'Obec', suburb: 'Čtvrť', quarter: 'Čtvrť', neighbourhood: 'Lokalita', hamlet: 'Osada' }[p.cls] ?? 'Místo';
          this.notify(`📖 ${label} ${p.name} zapsáno do deníku`, 'ok');
          this.pay(0, p.cls === 'city' || p.cls === 'town' ? 25 : 8);
        }
      }
      const w = p.cls === 'city' ? 3 : p.cls === 'town' ? 2 : 1;
      if (['city', 'town', 'village', 'hamlet'].includes(p.cls) && d < (p.cls === 'city' ? 15000 : 2500 * w) && (!best || d / w < best.d / best.w)) best = { name: p.name, d, w };
    }
    // Čtvrť má přednost, je-li blízko.
    let suburb: string | null = null;
    for (const p of this.world.allPlaces()) {
      if (['suburb', 'quarter', 'neighbourhood'].includes(p.cls) && Math.hypot(p.x - this.px, p.z - this.pz) < 700) suburb = p.name;
    }
    this.location.place = best ? (suburb && suburb !== best.name ? `${best.name} – ${suburb}` : best.name) : suburb ?? '';
    this.location.street = this.world.streetName(this.px, this.pz) ?? '';
  }

  private companyTick() {
    const c = this.state.company;
    if (!c) return;
    const r = simulateHour(c);
    this.state.money += r.income - r.costs;
    for (const e of r.events) this.notify(`🏢 ${e}`, 'warn');
    if (currentPanel() === 'company') openPanel(this, 'company', true);
  }

  // ------------------------------------------------------------ popisky obcí

  private updateLabels(dt: number) {
    const box = $('labels');
    this.labelT -= dt;
    if (this.labelT <= 0 && this.ready) {
      this.labelT = 0.5;
      const rank: Record<string, number> = { city: 9000, town: 5000, village: 2600, suburb: 1400, quarter: 900, hamlet: 1100, neighbourhood: 600 };
      const want = this.world.allPlaces()
        .map((p) => ({ p, d: Math.hypot(p.x - this.px, p.z - this.pz) }))
        .filter(({ p, d }) => d < (rank[p.cls] ?? 0) && d > 60)
        .sort((a, b) => a.d / (rank[a.p.cls] ?? 1) - b.d / (rank[b.p.cls] ?? 1))
        .slice(0, 10);
      const keep = new Set<string>();
      for (const { p } of want) {
        const key = `${p.name}|${Math.round(p.x)}|${Math.round(p.z)}`;
        keep.add(key);
        if (this.labelEls.has(key)) continue;
        const el = document.createElement('div');
        const big = ['city', 'town', 'village'].includes(p.cls) ? p.cls : 'small';
        el.className = `plabel ${big}`;
        el.textContent = p.name;
        box.appendChild(el);
        const th = this.world.terrainHeight(p.x, p.z);
        this.labelEls.set(key, { el, x: p.x, z: p.z, y: Number.isNaN(th) ? 0 : th });
      }
      for (const [k, v] of this.labelEls) {
        if (!keep.has(k)) {
          v.el.remove();
          this.labelEls.delete(k);
        }
      }
    }
    const show = !currentPanel() && this.ready && this.state.settings.camera !== 1;
    box.style.display = show ? '' : 'none';
    if (!show) return;
    const w = window.innerWidth, h = window.innerHeight;
    const v = new THREE.Vector3();
    for (const l of this.labelEls.values()) {
      const d = Math.hypot(l.x - this.px, l.z - this.pz);
      this.world.toScene(l.x, l.z, v, l.y + 25 + d * 0.012);
      v.project(this.camera);
      if (v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) {
        l.el.style.opacity = '0';
        continue;
      }
      const sc = Math.max(0.6, Math.min(1.15, 900 / (d + 300)));
      l.el.style.opacity = String(Math.min(1, (d - 60) / 150));
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%) scale(${sc})`;
    }
  }

  // ------------------------------------------------------------ HUD

  private updateHud() {
    const v = this.vehicle;
    const s = this.state;
    const { lon, lat } = worldToLonLat(this.px, this.pz);
    $('loc-name').textContent = this.location.place || 'Česká republika';
    $('loc-street').textContent = this.location.street;
    const alt = this.walking ? this.walker.y : v.y;
    $('loc-tiles').textContent = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E · ${Math.round(alt)} m n. m.${this.world.stats.pending ? ` · načítám ${this.world.stats.pending}` : ''} · ${Math.round(this.fps)} fps`;
    $('money').textContent = formatMoney(s.money);
    $('money').style.color = s.money < 0 ? '#ff7b6b' : '';
    const hh = Math.floor(this.env.time);
    const mm = Math.floor((this.env.time - hh) * 60);
    $('clock').textContent = `${hh}:${String(mm).padStart(2, '0')}`;
    $('weather-label').textContent = `${this.env.weather}${this.realWeather && this.state.settings.weather === 'skutečné' ? ` ${this.realWeather}` : ''}, ${this.env.season}`;
    const lv = level(s.xp);
    $('lvl').textContent = String(lv);
    const lo = (lv - 1) ** 2 * 100, hi = lv ** 2 * 100;
    ($('xp') as HTMLElement).style.width = `${((s.xp - lo) / (hi - lo)) * 100}%`;
    if (this.walking) {
      $('speed').textContent = '🚶';
      $('gear').textContent = 'pěšky';
      $('vehname').textContent = 'E – nastoupit';
      ($('rpm') as HTMLElement).style.width = '0';
      $('limit').classList.add('hidden');
    } else {
      $('speed').textContent = String(Math.round(Math.abs(v.vF) * 3.6));
      $('gear').textContent = v.gear < 0 ? 'R' : v.speed < 0.3 ? 'N' : String(v.gear);
      $('vehname').textContent = v.spec.name + (this.rental ? ' (půjčený)' : '');
      ($('rpm') as HTMLElement).style.width = `${Math.min(100, (v.rpm / (v.spec.mass > 5000 ? 2400 : 6500)) * 100)}%`;
      const fe = $('fuel') as HTMLElement;
      fe.style.width = `${Math.round((this.rental ? 1 : this.fuel) * 100)}%`;
      fe.classList.toggle('low', !this.rental && this.fuel < 0.12);
      this.urbanT -= 0.1;
      if (this.urbanT <= 0) {
        this.urbanT = 0.5;
        this.urban = this.world.buildingVolume(v.x, v.z, 220) > 50000;
      }
      const lim = this.speedLimit(v.onRoad);
      const el = $('limit');
      if (lim) {
        el.textContent = String(lim);
        el.classList.remove('hidden');
        $('speed').style.color = Math.abs(v.vF) * 3.6 > lim + 5 ? '#ff7b6b' : '';
      } else el.classList.add('hidden');
    }
    // Nápověda k akcím.
    let hint = '';
    if (this.ready && !currentPanel()) {
      if (this.walking) {
        const d = Math.hypot(this.walker.x - v.x, this.walker.z - v.z);
        if (d < Math.max(6, v.spec.length / 2 + 3)) hint = `E – nastoupit do vozidla (${v.spec.name})`;
      } else if (this.job) {
        hint = this.job.actionLabel(this.jobCtx()) ?? '';
      }
      if (!hint && !this.walking && v.speed < 1 && !this.rental && this.fuel < 0.97 && this.nearFuel()) hint = `T – natankovat (${this.nearFuel()!.name})`;
      if (!hint && !this.walking && v.speed < 0.5 && v.spec.mass > 5000 && v.spec.type !== 'kamion') hint = v.doorsOpen ? 'O – zavřít dveře' : 'O – otevřít dveře';
      if (!hint && !this.walking && this.world.graph.version > 0 && !v.onRoad && v.speed < 1 && this.clock > 5) hint = 'R – zpět na silnici';
    }
    $('hint').textContent = hint;
    $('hint').classList.toggle('hidden', !hint);
    if (!this.job) $('job').classList.add('hidden');
  }
}
