// Hlavní herní smyčka: svět, hráč (auto/autobus/chůze), kamera, práce, firma, ukládání.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CITIES, lonLatToWorld, worldToLonLat } from '../geo';
import { Environment } from '../world/environment';
import { QUALITY, World } from '../world/world';
import { SPEED_LIMIT } from '../world/roadgraph';
import { AudioFx } from './audio';
import { simulateHour } from './company';
import { Input } from './input';
import { BusJob, type Job, type JobCtx } from './jobs';
import { buildPerson, buildVehicleModel, updateSign, type VehicleModel } from './models';
import { defaultState, formatMoney, level, loadState, saveState, type SaveState } from './state';
import { Traffic } from './traffic';
import { Pedestrians } from './pedestrians';
import { SPECS, Vehicle, type VehicleType } from './vehicle';
import { Minimap } from '../ui/minimap';
import { openPanel, closePanel, currentPanel, showJobResult } from '../ui/panels';

const VEHICLE_COLORS: Record<VehicleType, number> = {
  auto: 0xc8452f, taxi: 0xf3d23a, dodávka: 0xeeeeee, autobus: 0xc8202a, meziměstský: 0x2b6cb0, kamion: 0x3a6b3a,
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
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    this.world = new World(this.renderer);
    this.scene.add(this.world.root);
    this.env = new Environment(this.scene, this.renderer);
    this.traffic = new Traffic(this.world);
    this.scene.add(this.traffic.group);
    this.pedestrians = new Pedestrians(this.world);
    this.scene.add(this.pedestrians.group);
    this.input = new Input(canvas);
    this.minimap = new Minimap($('minimap') as HTMLCanvasElement);
    const start = lonLatToWorld(CITIES[0].lon, CITIES[0].lat);
    this.state = loadState() ?? defaultState(start.x, start.z);
    this.applySettings();
    this.vehicle = new Vehicle(SPECS[this.state.vehicle]);
    this.model = buildVehicleModel(this.vehicle.spec, VEHICLE_COLORS[this.state.vehicle], true);
    this.scene.add(this.model.root);
    this.scene.add(this.walker.mesh);
    this.walker.mesh.visible = false;
    this.marker = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, 160, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x5ee08a, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false, fog: false }),
    );
    this.marker.visible = false;
    this.scene.add(this.marker);
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
    this.teleport(this.state.pos.x, this.state.pos.z, this.state.pos.heading, !this.state.walking);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  applySettings() {
    const s = this.state.settings;
    const q = QUALITY[s.quality] ?? QUALITY['střední'];
    if (this.world.quality !== q) this.world.setQuality(q);
    this.env.setShadows(q.shadows);
    this.env.season = s.season;
    this.env.weather = s.weather;
    this.env.time = s.time;
    this.env.timeSpeed = s.timeSpeed;
    this.audio.enabled = s.sound;
    this.traffic.max = q.radius >= 2 ? 28 : 14;
    if (this.pedestrians) this.pedestrians.max = q.radius >= 2 ? 30 : 15;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
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
    this.traffic.clear();
    this.pedestrians.clear();
    this.world.rebase(x, z);
    this.camInit = false;
    $('loading').classList.remove('hidden', 'fade');
    this.minimap.dirty();
  }
  private pendingSnap = true;

  /** Najde nejbližší silnici a postaví na ni vozidlo po směru jízdy. */
  snapToRoad(x: number, z: number): { x: number; z: number; heading: number } | null {
    const flt = (e: { cls: string }) => e.cls !== 'path' && e.cls !== 'track' && e.cls !== 'motorway';
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

  toggleWalk() {
    const v = this.vehicle;
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
    this.navPts = null;
    this.navTarget = null;
    this.navT = 0;
    if (job instanceof BusJob) updateSign(this.model, job.line.number, job.line.stops[job.line.stops.length - 1].name);
  }

  cancelJob() {
    if (!this.job) return;
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
    };
  }

  save() {
    const s = this.state;
    s.pos = { x: this.px, z: this.pz, heading: this.walking ? this.walker.heading : this.vehicle.heading };
    s.walking = this.walking;
    s.settings.time = this.env.time;
    if (!this.rental) s.vehicle = this.vehicle.spec.type;
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

    this.world.update(this.px, this.pz);
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
    this.world.mats.lamp.emissiveIntensity = this.env.night > 0.4 ? 2.5 : 0;
    this.world.mats.glow.opacity = Math.max(0, this.env.night - 0.3) * 1.2;
    this.world.setSeason(this.env.season);
    this.adaptPerformance(dt);
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.1;
      this.updateHud();
    }
    this.minimap.draw(this);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels(dt);
    this.input.endFrame();
  }

  private navMeshDirty = false;
  private urbanT = 0;
  private urban = false;

  /** Rychlostní limit: v obci max. 50 km/h (kromě dálnic a rychlostních silnic). */
  speedLimit(cls: string | null): number | null {
    if (!cls || cls === 'path') return null;
    const lim = SPEED_LIMIT[cls];
    if (!lim) return null;
    if (this.urban && cls !== 'motorway' && cls !== 'trunk') return Math.min(lim, 50);
    return lim;
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
    this.ready = true;
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
    if (i.hit('KeyR')) {
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
    const obstacles = [...this.traffic.obstacles(), ...this.pedestrians.obstacles()].filter((o) => Math.hypot(o.x - v.x, o.z - v.z) < 30);
    v.update(dt, ax, this.world, this.env.grip(), obstacles);
    v.updateAttitude(this.world, dt);
    this.crashCool -= dt;
    for (const imp of v.impacts) {
      if (imp.speed > 3 && this.crashCool <= 0) {
        this.audio.crash();
        this.state.stats.crashes++;
        this.crashCool = 1;
      }
    }
    if (!this.job) v.impacts.length = 0;
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
    this.walker.mesh.visible = false;
    m.root.visible = this.state.settings.camera !== 1 || v.spec.mass > 5000;
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
    const heading = this.walking ? this.walker.heading : v.heading;
    const target = this.focus();
    const yaw = heading + this.camYaw;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    let desired: THREE.Vector3;
    let look: THREE.Vector3;
    if (mode === 1 && !this.walking) {
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
      look = desired.clone().add(new THREE.Vector3(fx * 30, -2 - v.pitch * 30, fz * 30));
      this.camera.position.copy(desired);
      this.camera.lookAt(look);
      this.camera.fov = 70;
      this.camera.updateProjectionMatrix();
      return;
    }
    const base = (this.walking ? 4.5 : Math.max(7, v.spec.length * 1.25)) * (this.camera.aspect < 1 ? 1.5 : 1);
    const dist = base * this.camDist * (mode === 2 ? 3.2 : 1);
    const pitch = mode === 2 ? Math.max(this.camPitch, 0.7) : this.camPitch;
    desired = target.clone().add(new THREE.Vector3(-fx * dist * Math.cos(pitch), dist * Math.sin(pitch) + (this.walking ? 1.6 : v.spec.height * 0.6), -fz * dist * Math.cos(pitch)));
    // Nepodlézt pod terén.
    const gx = desired.x + this.world.origin.x, gz = desired.z + this.world.origin.z;
    const gh = this.world.terrainHeight(gx, gz);
    if (!Number.isNaN(gh)) desired.y = Math.max(desired.y, gh + 1.2);
    // Kamera nesmí skončit ve zdi: když mezi vozidlem a kamerou stojí budova, přiblížit se.
    {
      const o = this.world.origin;
      const th = this.world.terrainHeight(desired.x + o.x, desired.z + o.z);
      if (Number.isNaN(th) || desired.y < th + 22) {
        const hit = this.world.segmentHit(target.x + o.x, target.z + o.z, desired.x + o.x, desired.z + o.z);
        if (hit < 1) {
          const t = Math.max(0.05, hit - 0.6 / Math.max(1, target.distanceTo(desired)));
          desired.x = target.x + (desired.x - target.x) * t;
          desired.z = target.z + (desired.z - target.z) * t;
          desired.y = Math.max(desired.y, target.y + 2.5);
        }
      }
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
        const profile = this.walking ? 'walk' : this.vehicle.spec.mass > 5000 ? 'bus' : 'car';
        const r = this.world.graph.route(this.px, this.pz, t.x, t.z, profile, 40000);
        this.navPts = r ? r.pts : null;
        this.setNavMesh(this.navPts);
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
    const w = 1.1;
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
        const h0 = this.world.groundHeight(p0x, p0z, 9999) + 0.45;
        const h1 = this.world.groundHeight(p1x, p1z, 9999) + 0.45;
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
      if (['city', 'town', 'village', 'hamlet'].includes(p.cls) && d < 2500 * w && (!best || d / w < best.d / best.w)) best = { name: p.name, d, w };
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
    $('weather-label').textContent = `${this.env.weather}, ${this.env.season}`;
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
      this.urbanT -= 0.1;
      if (this.urbanT <= 0) {
        this.urbanT = 1.5;
        this.urban = this.world.buildingVolume(v.x, v.z, 120) > 60000;
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
      if (!hint && !this.walking && v.speed < 0.5 && v.spec.mass > 5000) hint = v.doorsOpen ? 'O – zavřít dveře' : 'O – otevřít dveře';
      if (!hint && !this.walking && this.world.graph.version > 0 && !v.onRoad && v.speed < 1 && this.clock > 5) hint = 'R – zpět na silnici';
    }
    $('hint').textContent = hint;
    $('hint').classList.toggle('hidden', !hint);
    if (!this.job) $('job').classList.add('hidden');
  }
}
