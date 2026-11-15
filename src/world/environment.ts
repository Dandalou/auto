// Obloha, slunce, mlha, denní doba, roční období a počasí.

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { envUniforms } from './world';

export type Weather = 'jasno' | 'oblačno' | 'mlha' | 'déšť' | 'sníh';
export type Season = 'jaro' | 'léto' | 'podzim' | 'zima';

export class Environment {
  time = 10.5; // hodiny
  timeSpeed = 0; // herní minuty za sekundu (0 = zastaveno)
  weather: Weather = 'jasno';
  season: Season = 'léto';
  /** 0 = den, 1 = noc. */
  night = 0;
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbcd4ff, 0x5b5040, 1.1);
  private sky = new Sky();
  private rain: THREE.LineSegments;
  private snow: THREE.Points;
  private sunDir = new THREE.Vector3();
  private fogDay = new THREE.Color();

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(80000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.2;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    scene.add(this.sky);
    scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -120;
    c.right = 120;
    c.top = 120;
    c.bottom = -120;
    c.near = 1;
    c.far = 1200;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.fog = new THREE.Fog(0xcfd8e0, 300, 9000);

    // Déšť: svislé čárky kolem kamery.
    const RN = 6000;
    const rp = new Float32Array(RN * 6);
    for (let i = 0; i < RN; i++) {
      const x = (Math.random() - 0.5) * 80, y = Math.random() * 40, z = (Math.random() - 0.5) * 80;
      rp.set([x, y, z, x + 0.05, y - 0.7, z], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.45 }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
    const SN = 5000;
    const sp = new Float32Array(SN * 3);
    for (let i = 0; i < SN; i++) sp.set([(Math.random() - 0.5) * 80, Math.random() * 40, (Math.random() - 0.5) * 80], i * 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.9 }));
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    scene.add(this.snow);
  }

  setShadows(on: boolean) {
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
  }

  /** Povrchová přilnavost podle počasí (1 = suchý asfalt). */
  grip(): number {
    if (this.weather === 'sníh' || (this.season === 'zima' && this.weather !== 'jasno')) return 0.55;
    if (this.season === 'zima') return 0.75;
    if (this.weather === 'déšť') return 0.78;
    return 1;
  }

  update(dt: number, camPos: THREE.Vector3, focus: THREE.Vector3) {
    this.time = (this.time + (dt * this.timeSpeed) / 60 + 24) % 24;
    // Jednoduchá dráha slunce pro střední Evropu podle ročního období.
    const dayLen = { jaro: 12.5, léto: 15.5, podzim: 11.5, zima: 8.5 }[this.season];
    const noonAlt = { jaro: 42, léto: 62, podzim: 36, zima: 18 }[this.season];
    const rise = 12.6 - dayLen / 2;
    const t = (this.time - rise) / dayLen; // 0..1 během dne
    const alt = Math.sin(t * Math.PI) * noonAlt - (t < 0 || t > 1 ? 10 * Math.min(1, Math.abs(t < 0 ? t : t - 1) * 4) : 0);
    const az = -90 + t * 180; // východ -> jih -> západ
    const phi = THREE.MathUtils.degToRad(90 - alt);
    const theta = THREE.MathUtils.degToRad(az + 180);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const day = THREE.MathUtils.smoothstep(alt, -6, 8);
    this.night = 1 - day;

    const overcast = this.weather === 'jasno' ? 0 : this.weather === 'oblačno' ? 0.6 : 0.85;
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3 + overcast * 12;
    u.rayleigh.value = 1.2 + overcast * 1.5;
    u.cloudCoverage.value = this.weather === 'jasno' ? 0.25 : this.weather === 'oblačno' ? 0.75 : 0.95;
    u.cloudDensity.value = 0.35 + overcast * 0.5;
    u.time.value += dt;

    const warm = THREE.MathUtils.smoothstep(alt, 0, 25);
    this.sun.color.setRGB(1, 0.75 + 0.25 * warm, 0.55 + 0.45 * warm);
    this.sun.intensity = day * (3.2 - overcast * 2.4) + 0.05;
    this.hemi.intensity = 0.15 + day * (1.1 - overcast * 0.25);
    this.hemi.color.setRGB(0.55 + day * 0.2, 0.6 + day * 0.22, 0.75 + day * 0.25);
    // Měsíc v noci.
    if (day < 0.05) {
      this.sun.color.setRGB(0.55, 0.65, 0.9);
      this.sun.intensity = 0.25;
      this.sunDir.set(0.3, 0.8, 0.4).normalize();
    }
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 500);
    this.sun.target.position.copy(focus);

    // Mlha.
    const fog = this.scene.fog as THREE.Fog;
    this.fogDay.setRGB(0.78 - overcast * 0.12, 0.84 - overcast * 0.12, 0.9 - overcast * 0.1);
    const nightCol = new THREE.Color(0.03, 0.04, 0.07);
    fog.color.copy(this.fogDay).lerp(nightCol, this.night);
    if (warm < 1 && day > 0.2) fog.color.lerp(new THREE.Color(0.95, 0.7, 0.5), (1 - warm) * 0.35);
    const vis = this.weather === 'mlha' ? 280 : this.weather === 'sníh' ? 900 : this.weather === 'déšť' ? 2500 : this.weather === 'oblačno' ? 7000 : 11000;
    fog.near = Math.min(250, vis * 0.1);
    fog.far = vis;
    this.renderer.toneMappingExposure = 0.55 + day * 0.15;
    this.sky.visible = this.weather !== 'mlha';
    this.scene.background = this.weather === 'mlha' || this.night > 0.9 ? fog.color : null;

    // Srážky sledují kameru.
    this.rain.visible = this.weather === 'déšť';
    this.snow.visible = this.weather === 'sníh';
    const fall = (obj: THREE.Object3D, speed: number) => {
      if (!obj.visible) return;
      obj.position.set(camPos.x, camPos.y - 20, camPos.z);
      const a = (obj as THREE.Points).geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = a.array as Float32Array;
      if (obj === this.rain) {
        for (let i = 0; i < arr.length; i += 6) {
          arr[i + 1] -= speed * dt;
          arr[i + 4] -= speed * dt;
          if (arr[i + 4] < 0) {
            arr[i + 1] += 40;
            arr[i + 4] += 40;
          }
        }
      } else {
        for (let i = 1; i < arr.length; i += 3) {
          arr[i] -= speed * dt;
          if (arr[i] < 0) arr[i] += 40;
        }
      }
      if (obj === this.snow) {
        for (let i = 0; i < arr.length; i += 3) arr[i] += Math.sin(arr[i + 1] * 0.7 + i) * dt * 0.4;
      }
      a.needsUpdate = true;
    };
    fall(this.rain, 22);
    fall(this.snow, 1.6);

    // Sníh a roční období v materiálech.
    const snowLine = { jaro: 1100, léto: 9999, podzim: 1250, zima: -100 }[this.season];
    envUniforms.uSnowLine.value = this.weather === 'sníh' ? Math.min(snowLine, 200) : snowLine;
    envUniforms.uSnowAmount.value = this.season === 'zima' || this.weather === 'sníh' ? 0.9 : snowLine < 2000 ? 0.85 : 0;
    envUniforms.uWet.value = this.weather === 'déšť' ? 1 : 0;
    const tint = { jaro: [0.98, 1.05, 0.95], léto: [1, 1, 1], podzim: [1.12, 0.98, 0.78], zima: [0.95, 0.95, 0.98] }[this.season];
    envUniforms.uSeasonTint.value.setRGB(tint[0], tint[1], tint[2]);
  }
}
