// Fyzika vozidla: jednostopý dynamický model s pneumatikami, gravitací na svahu,
// skoky přes horizonty, mosty, kolizemi s budovami a stromy.

import type { World } from '../world/world';

export type VehicleType = 'auto' | 'taxi' | 'dodávka' | 'autobus' | 'meziměstský' | 'kamion';

export interface VehicleSpec {
  type: VehicleType;
  name: string;
  mass: number;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  power: number; // W
  vmax: number; // m/s
  steerMax: number;
  brake: number; // m/s² max zpomalení
  gears: number[];
  price: number;
  seats: number;
  /** Nádrž (l) a průměrná spotřeba (l/100 km). */
  tank: number;
  consumption: number;
}

export const SPECS: Record<VehicleType, VehicleSpec> = {
  auto: {
    type: 'auto', name: 'Osobní auto', mass: 1300, length: 4.4, width: 1.8, height: 1.45, wheelbase: 2.65,
    power: 110e3, vmax: 55, steerMax: 0.6, brake: 9, gears: [3.6, 2.1, 1.4, 1.05, 0.85, 0.7], price: 0, seats: 4, tank: 50, consumption: 7,
  },
  taxi: {
    type: 'taxi', name: 'Taxi', mass: 1450, length: 4.7, width: 1.83, height: 1.47, wheelbase: 2.8,
    power: 120e3, vmax: 55, steerMax: 0.58, brake: 9, gears: [3.6, 2.1, 1.4, 1.05, 0.85, 0.7], price: 180000, seats: 4, tank: 55, consumption: 7.5,
  },
  dodávka: {
    type: 'dodávka', name: 'Dodávka', mass: 2600, length: 5.9, width: 2.05, height: 2.55, wheelbase: 3.66,
    power: 105e3, vmax: 42, steerMax: 0.55, brake: 7.5, gears: [4.2, 2.4, 1.5, 1.05, 0.8, 0.65], price: 450000, seats: 3, tank: 80, consumption: 10,
  },
  autobus: {
    type: 'autobus', name: 'Městský autobus', mass: 12500, length: 12, width: 2.55, height: 3.1, wheelbase: 5.9,
    power: 220e3, vmax: 22.5, steerMax: 0.62, brake: 5.5, gears: [3.4, 1.9, 1.4, 1.0, 0.75], price: 1200000, seats: 90, tank: 250, consumption: 35,
  },
  meziměstský: {
    type: 'meziměstský', name: 'Meziměstský autobus', mass: 14000, length: 12.9, width: 2.55, height: 3.4, wheelbase: 6.3,
    power: 290e3, vmax: 27.7, steerMax: 0.58, brake: 5.5, gears: [3.4, 2.1, 1.5, 1.15, 0.9, 0.72], price: 2200000, seats: 55, tank: 400, consumption: 30,
  },
  kamion: {
    type: 'kamion', name: 'Nákladní auto', mass: 16000, length: 10, width: 2.55, height: 3.6, wheelbase: 5.2,
    power: 300e3, vmax: 25, steerMax: 0.55, brake: 5, gears: [5, 3, 2, 1.5, 1.2, 1, 0.8], price: 1800000, seats: 2, tank: 400, consumption: 32,
  },
};

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1 (doprava kladně)
  handbrake: boolean;
}

export interface ImpactEvent {
  speed: number;
}

const G = 9.81;

export class Vehicle {
  x = 0;
  z = 0;
  y = 0;
  vy = 0;
  heading = 0; // 0 = sever, kladně po směru hodinových ručiček
  vF = 0; // podélná rychlost
  vL = 0; // příčná rychlost (doprava)
  yawRate = 0;
  steer = 0;
  pitch = 0;
  roll = 0;
  airborne = false;
  gear = 1;
  rpm = 800;
  onRoad: string | null = null;
  odometer = 0;
  /** Zrychlení pro hodnocení plynulosti jízdy. */
  accel = 0;
  latAccel = 0;
  doorsOpen = false;
  impacts: ImpactEvent[] = [];
  private prevGround = 0;
  private roadCheckT = 0;

  constructor(public spec: VehicleSpec) {}

  get speed() {
    return Math.hypot(this.vF, this.vL);
  }

  forward(): [number, number] {
    return [Math.sin(this.heading), -Math.cos(this.heading)];
  }

  place(x: number, z: number, heading: number, world: World) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.vF = this.vL = this.yawRate = this.vy = 0;
    const h = world.groundHeight(x, z, 99999);
    this.y = Number.isNaN(h) ? 0 : h;
    this.prevGround = this.y;
    this.airborne = false;
  }

  update(dt: number, c: Controls, world: World, gripMul: number, obstacles: { x: number; z: number; r: number }[] = []) {
    const s = this.spec;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    this.roadCheckT -= dt;
    if (this.roadCheckT <= 0) {
      this.onRoad = world.graph.surfaceAt(this.x, this.z);
      this.roadCheckT = 0.15;
    }
    const road = this.onRoad;
    const offroad = !road || road === 'path';
    const surfGrip = (offroad ? 0.72 : road === 'track' ? 0.8 : 1) * gripMul;
    const rolling = offroad ? 0.06 : 0.013;
    // Řízení: plynulé natočení, menší rejd ve vyšších rychlostech.
    const v = Math.abs(this.vF);
    const steerLimit = s.steerMax / (1 + v * v * (s.mass > 5000 ? 0.0012 : 0.0035));
    const target = c.steer * steerLimit;
    const rate = 2.4;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer));
    const prevVF = this.vF;
    const prevVL = this.vL;
    for (let i = 0; i < steps; i++) this.step(h, c, world, surfGrip, rolling);
    this.accel = (this.vF - prevVF) / dt;
    this.latAccel = this.vF * this.yawRate;
    void prevVL;
    this.collide(world, obstacles);
    this.updateEngine(c);
  }

  private step(dt: number, c: Controls, world: World, grip: number, rolling: number) {
    const s = this.spec;
    const m = s.mass;
    const a = s.wheelbase * 0.5;
    const b = s.wheelbase * 0.5;
    const Iz = m * (s.length * s.length + s.width * s.width) / 12;
    const v = this.vF;
    const av = Math.abs(v);
    // Svah.
    const [fx, fz] = this.forward();
    const e = 0.8;
    const hx1 = world.terrainHeight(this.x + e, this.z), hx0 = world.terrainHeight(this.x - e, this.z);
    const hz1 = world.terrainHeight(this.x, this.z + e), hz0 = world.terrainHeight(this.x, this.z - e);
    let gx = 0, gz = 0;
    if (!Number.isNaN(hx1 + hx0 + hz1 + hz0) && !this.onBridge(world)) {
      gx = (hx1 - hx0) / (2 * e);
      gz = (hz1 - hz0) / (2 * e);
    }
    const slopeF = gx * fx + gz * fz;
    const gravF = this.airborne ? 0 : (-G * slopeF) / Math.sqrt(1 + slopeF * slopeF);

    // Podélná síla.
    let Fx = 0;
    const eng = Math.min(m * 4.5, s.power / Math.max(av, 4));
    const wantReverse = c.brake > 0.1 && av < 0.6 && c.throttle < 0.1;
    if (this.doorsOpen) {
      // Se otevřenými dveřmi autobus nepojede.
    } else if (c.throttle > 0) {
      if (v < -0.5) Fx += m * s.brake * c.throttle;
      else if (v < s.vmax) Fx += eng * c.throttle * (v > s.vmax * 0.95 ? Math.max(0, (s.vmax - v) / (s.vmax * 0.05)) : 1);
    }
    if (c.brake > 0) {
      if (v > 0.6) Fx -= m * s.brake * c.brake;
      else if (wantReverse || v <= 0.6) {
        if (v > -6) Fx -= eng * 0.5 * c.brake;
      }
    }
    if (c.handbrake) Fx -= Math.sign(v) * m * 3.5;
    if (this.doorsOpen) Fx -= Math.sign(v) * m * 6;
    Fx -= Math.sign(v) * rolling * m * G;
    Fx -= 0.42 * (s.width * s.height) * v * av * 0.6;
    if (this.airborne) Fx = 0;

    // Boční síly.
    const delta = this.steer;
    const Cf = m * 9 * grip;
    const Cr = m * 10 * grip;
    const muN = grip * m * G * 0.5;
    let ax: number, al: number, ar: number;
    if (av < 3) {
      // Kinematický model při malých rychlostech.
      const r = (v * Math.tan(delta)) / s.wheelbase;
      ax = Fx / m + gravF;
      this.yawRate += (r - this.yawRate) * Math.min(1, dt * 12);
      this.vL += (0 - this.vL) * Math.min(1, dt * 10);
      al = 0;
      ar = 0;
    } else {
      const sv = Math.sign(v);
      const af = Math.atan2(this.vL + a * this.yawRate, av) - delta * sv;
      const arr = Math.atan2(this.vL - b * this.yawRate, av);
      let Fyf = Math.max(-muN, Math.min(muN, -Cf * af));
      let Fyr = Math.max(-muN, Math.min(muN, -Cr * arr));
      if (c.handbrake) Fyr *= 0.35;
      if (this.airborne) {
        Fyf = 0;
        Fyr = 0;
      }
      ax = (Fx - Fyf * Math.sin(delta)) / m + this.vL * this.yawRate + gravF;
      al = (Fyr + Fyf * Math.cos(delta)) / m - v * this.yawRate;
      ar = (a * Fyf * Math.cos(delta) - b * Fyr) / Iz;
      if (v < 0) ar = -ar;
      this.vL += al * dt;
      this.yawRate += ar * dt;
      // Tlumení, aby model nebyl nestabilní.
      this.yawRate *= 1 - Math.min(1, dt * 0.8);
    }
    const before = this.vF;
    this.vF += ax * dt;
    // Brzdění neotáčí směr jízdy.
    if (c.brake > 0 && before > 0 && this.vF < 0 && c.throttle === 0 && before > 0.6) this.vF = 0;
    if (c.handbrake && Math.abs(this.vF) < 0.5) this.vF = 0;
    if (!c.throttle && !c.brake && Math.abs(this.vF) < 0.15 && Math.abs(gravF) < 1.2) this.vF = 0;

    this.heading += this.yawRate * dt;
    const [nfx, nfz] = this.forward();
    const rx = -nfz, rz = nfx;
    const dx = (nfx * this.vF + rx * this.vL) * dt;
    const dz = (nfz * this.vF + rz * this.vL) * dt;
    this.x += dx;
    this.z += dz;
    this.odometer += Math.hypot(dx, dz);

    // Svislý pohyb.
    let ground = world.groundHeight(this.x, this.z, this.y);
    if (Number.isNaN(ground)) ground = this.y;
    if (this.airborne) {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      if (this.y <= ground) {
        this.y = ground;
        if (this.vy < -6) this.impacts.push({ speed: -this.vy * 0.3 });
        this.vy = 0;
        this.airborne = false;
      }
    } else {
      const follow = (ground - this.prevGround) / dt;
      // Pokud terén klesá rychleji, než by auto padalo, odlepí se (skok přes horizont).
      if (follow < this.vy - G * dt * 1.5 && ground < this.y - 0.25 && Math.abs(this.vF) > 12) {
        this.airborne = true;
        this.vy = Math.min(this.vy, 8);
        this.y += this.vy * dt;
      } else {
        this.vy = Math.max(-30, Math.min(20, follow));
        this.y = ground;
      }
    }
    this.prevGround = ground;
  }

  private onBridge(world: World): boolean {
    const t = world.terrainHeight(this.x, this.z);
    return this.y > t + 1.2;
  }

  private collide(world: World, obstacles: { x: number; z: number; r: number }[]) {
    const s = this.spec;
    const [fx, fz] = this.forward();
    const r = s.width / 2;
    const n = Math.max(2, Math.ceil(s.length / s.width));
    let hit: { nx: number; nz: number; depth: number } | null = null;
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1) - 0.5) * (s.length - s.width);
      const cx = this.x + fx * t;
      const cz = this.z + fz * t;
      let res = this.y < world.terrainHeight(cx, cz) + 4 ? world.collide(cx, cz, r) : null;
      for (const o of obstacles) {
        const d = Math.hypot(cx - o.x, cz - o.z);
        const rr = r + o.r;
        if (d < rr && d > 1e-3) {
          const depth = rr - d;
          if (!res || depth > res.depth) res = { px: ((cx - o.x) / d) * depth, pz: ((cz - o.z) / d) * depth, nx: (cx - o.x) / d, nz: (cz - o.z) / d, depth };
        }
      }
      if (res) {
        this.x += res.px;
        this.z += res.pz;
        if (!hit || res.depth > hit.depth) hit = res;
      }
    }
    if (hit) {
      const rx = -fz, rz = fx;
      let vx = fx * this.vF + rx * this.vL;
      let vz = fz * this.vF + rz * this.vL;
      const vn = vx * hit.nx + vz * hit.nz;
      if (vn < 0) {
        if (-vn > 2) this.impacts.push({ speed: -vn });
        vx -= 1.25 * vn * hit.nx;
        vz -= 1.25 * vn * hit.nz;
        vx *= 0.8;
        vz *= 0.8;
        this.vF = vx * fx + vz * fz;
        this.vL = vx * rx + vz * rz;
        this.yawRate *= 0.5;
      }
    }
  }

  private updateEngine(c: Controls) {
    const s = this.spec;
    const v = Math.abs(this.vF);
    const ratioTop = s.vmax / s.gears.length;
    // Automatická převodovka.
    const gi = Math.min(s.gears.length, Math.max(1, Math.floor(v / ratioTop) + 1));
    this.gear = this.vF < -0.3 ? -1 : gi;
    const inGear = v - (gi - 1) * ratioTop;
    const base = s.mass > 5000 ? 650 : 800;
    const top = s.mass > 5000 ? 2300 : 6200;
    this.rpm = base + (inGear / ratioTop) * (top - base) * 0.85 + c.throttle * 300;
  }

  /** Body kol pro náklon karoserie. */
  updateAttitude(world: World, dt: number) {
    const s = this.spec;
    const [fx, fz] = this.forward();
    const rx = -fz, rz = fx;
    const L = s.wheelbase / 2;
    const W = s.width / 2;
    const hf = world.groundHeight(this.x + fx * L, this.z + fz * L, this.y);
    const hb = world.groundHeight(this.x - fx * L, this.z - fz * L, this.y);
    const hr = world.groundHeight(this.x + rx * W, this.z + rz * W, this.y);
    const hl = world.groundHeight(this.x - rx * W, this.z - rz * W, this.y);
    if (Number.isNaN(hf + hb + hr + hl)) return;
    let tp = Math.atan2(hf - hb, s.wheelbase);
    let tr = Math.atan2(hl - hr, s.width);
    // Náklon ze setrvačnosti.
    tp += -this.accel * 0.004;
    tr += this.latAccel * (s.mass > 5000 ? 0.006 : 0.008);
    if (this.airborne) {
      tp = this.pitch;
      tr = this.roll;
    }
    const k = Math.min(1, dt * 8);
    this.pitch += (tp - this.pitch) * k;
    this.roll += (tr - this.roll) * k;
  }
}
