// Procedurální modely vozidel a chodce (bez externích assetů).

import * as THREE from 'three';
import type { VehicleSpec } from './vehicle';

export interface VehicleModel {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  frontWheels: THREE.Object3D[];
  headlights: THREE.SpotLight | null;
  lightMats: THREE.MeshStandardMaterial[];
  brakeMat: THREE.MeshStandardMaterial;
  doors: THREE.Object3D[];
  sign?: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture };
}

const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.08, metalness: 0.6, envMapIntensity: 2.5 });
const tyre = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
const rim = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.35, metalness: 0.8 });
const dark = new THREE.MeshStandardMaterial({ color: 0x222326, roughness: 0.7 });
const wheelGeo = new THREE.CylinderGeometry(1, 1, 1, 16).rotateZ(Math.PI / 2);

function box(w: number, h: number, l: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function wheel(r: number, w: number): THREE.Group {
  const g = new THREE.Group();
  const t = new THREE.Mesh(wheelGeo, tyre);
  t.scale.set(w, r, r);
  t.castShadow = true;
  const rm = new THREE.Mesh(wheelGeo, rim);
  rm.scale.set(w * 1.02, r * 0.58, r * 0.58);
  g.add(t, rm);
  return g;
}

export function signCanvas(text: string, sub: string, w = 512, h = 64): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffb21e';
  ctx.font = `bold ${h * 0.62}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 10, h / 2);
  ctx.font = `bold ${h * 0.45}px sans-serif`;
  const tw = ctx.measureText(text).width;
  ctx.fillText(sub.slice(0, 32), tw + 28, h / 2);
  return c;
}

export function buildVehicleModel(spec: VehicleSpec, color: number, withLights: boolean): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.45, envMapIntensity: 2.2 });
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const wheels: THREE.Object3D[] = [];
  const frontWheels: THREE.Object3D[] = [];
  const doors: THREE.Object3D[] = [];
  const lightMats: THREE.MeshStandardMaterial[] = [];
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfafaf0, emissive: 0xfff4d0, emissiveIntensity: 0.2 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x700000, emissive: 0xff1010, emissiveIntensity: 0.3 });
  lightMats.push(headMat);
  let sign: VehicleModel['sign'];
  const wr = spec.mass > 5000 ? 0.5 : spec.type === 'dodávka' ? 0.38 : 0.33;
  // Osa Z modelu míří dozadu (-Z = dopředu), aby odpovídala heading = 0 na sever.
  if (spec.type === 'autobus' || spec.type === 'meziměstský') {
    const floor = 0.35;
    body.add(box(W, H - floor - 0.05, L, paint, 0, floor + (H - floor) / 2, 0));
    // Okna po stranách.
    const winH = spec.type === 'autobus' ? 1.15 : 0.95;
    const winY = H - 0.35 - winH / 2;
    body.add(box(W + 0.02, winH, L - 1.4, glass, 0, winY, 0.3));
    body.add(box(W - 0.2, 1.3, 0.05, glass, 0, H - 1.2, -L / 2 - 0.01));
    body.add(box(W + 0.03, 0.3, L * 0.98, new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.5 }), 0, floor + 0.55, 0));
    // Dveře na pravé straně.
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x30363d, roughness: 0.3, metalness: 0.3 });
    const doorZs = spec.type === 'autobus' ? [-L / 2 + 1.2, -0.3, L / 2 - 2.6] : [-L / 2 + 1.2];
    for (const dz of doorZs) {
      const d = box(0.06, H - floor - 0.5, 1.2, doorMat, W / 2 + 0.02, floor + (H - floor - 0.5) / 2 + 0.1, dz);
      doors.push(d);
      body.add(d);
    }
    // Panel s linkou.
    const c = signCanvas('---', '', 512, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sm = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9 });
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.4, 0.28), sm);
    sp.position.set(0, H - 0.25, -L / 2 - 0.02);
    sp.rotation.y = Math.PI;
    body.add(sp);
    sign = { canvas: c, tex };
    const axles = [-L / 2 + 2.6, -L / 2 + 2.6 + spec.wheelbase];
    axles.forEach((az, i) => {
      for (const sx of [-1, 1]) {
        const w = wheel(wr, 0.32);
        w.position.set(sx * (W / 2 - 0.25), wr, az);
        body.add(w);
        wheels.push(w);
        if (i === 0) frontWheels.push(w);
      }
    });
    body.add(box(W * 0.8, 0.25, 0.08, headMat, 0, floor + 0.45, -L / 2 - 0.02));
    body.add(box(W * 0.8, 0.22, 0.08, brakeMat, 0, floor + 0.5, L / 2 + 0.02));
  } else if (spec.type === 'dodávka' || spec.type === 'kamion') {
    const cabL = spec.type === 'kamion' ? 2.3 : 1.9;
    const cabH = spec.type === 'kamion' ? H : H * 0.82;
    body.add(box(W, cabH - 0.4, cabL, paint, 0, 0.4 + (cabH - 0.4) / 2, -L / 2 + cabL / 2));
    body.add(box(W - 0.1, (cabH - 0.4) * 0.4, 0.05, glass, 0, cabH - (cabH - 0.4) * 0.3, -L / 2 - 0.01));
    body.add(box(W + 0.02, (cabH - 0.4) * 0.35, cabL * 0.6, glass, 0, cabH - (cabH - 0.4) * 0.3, -L / 2 + cabL * 0.4));
    const cargoMat = new THREE.MeshStandardMaterial({ color: spec.type === 'kamion' ? 0xd8d8d8 : color, roughness: 0.5 });
    body.add(box(W, H - 0.45, L - cabL - 0.1, cargoMat, 0, 0.45 + (H - 0.45) / 2, -L / 2 + cabL + 0.1 + (L - cabL - 0.1) / 2));
    const axles = [-L / 2 + 0.9, -L / 2 + 0.9 + spec.wheelbase];
    axles.forEach((az, i) => {
      for (const sx of [-1, 1]) {
        const w = wheel(wr, 0.25);
        w.position.set(sx * (W / 2 - 0.15), wr, az);
        body.add(w);
        wheels.push(w);
        if (i === 0) frontWheels.push(w);
      }
    });
    for (const sx of [-1, 1]) {
      body.add(box(0.3, 0.15, 0.06, headMat, sx * (W / 2 - 0.3), 0.85, -L / 2 - 0.02));
      body.add(box(0.2, 0.25, 0.06, brakeMat, sx * (W / 2 - 0.2), 0.8, L / 2 + 0.02));
    }
  } else {
    // Osobní auto / taxi: vytažené boční profily (spodek, kabina, skla).
    const ku = L / 4.4;
    const kv = H / 1.45;
    const prof = (pts: number[][], width: number, mat: THREE.Material, bevel: number) => {
      const sh = new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u * ku, v * kv)));
      const g = new THREE.ExtrudeGeometry(sh, {
        depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4,
      });
      g.rotateY(-Math.PI / 2);
      g.translate(width / 2 - bevel, 0, 0);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      body.add(m);
      return m;
    };
    prof([[-2.2, 0.3], [-2.2, 0.72], [-2.05, 0.86], [-0.9, 0.98], [1.85, 1.0], [2.2, 0.95], [2.2, 0.3]], W, paint, 0.06);
    prof([[-0.9, 0.96], [-0.25, 1.42], [0.95, 1.42], [1.85, 0.98]], W * 0.84, paint, 0.05);
    prof([[-0.95, 0.97], [-0.3, 1.395], [1.0, 1.395], [1.93, 0.97]], W * 0.87, glass, 0);
    body.add(box(W * 0.98, 0.16, 0.12, dark, 0, 0.36, -L / 2 + 0.02));
    body.add(box(W * 0.98, 0.16, 0.12, dark, 0, 0.36, L / 2 - 0.02));
    for (const sx of [-1, 1]) {
      body.add(box(0.36, 0.12, 0.08, headMat, sx * (W / 2 - 0.3), 0.66 * kv, -L / 2 + 0.03));
      body.add(box(0.34, 0.14, 0.08, brakeMat, sx * (W / 2 - 0.28), 0.8 * kv, L / 2 + 0.01));
      // Zpětná zrcátka.
      body.add(box(0.16, 0.1, 0.08, paint, sx * (W / 2 + 0.06), 1.0 * kv, -0.75 * ku));
    }
    const cabinTop = 1.42 * kv;
    if (spec.type === 'taxi') {
      const tm = new THREE.MeshStandardMaterial({ color: 0xffe14d, emissive: 0xffd000, emissiveIntensity: 0.5 });
      lightMats.push(tm);
      body.add(box(0.7, 0.18, 0.25, tm, 0, cabinTop + 0.09, 0.3 * ku));
    }
    const axles = [-spec.wheelbase / 2 - 0.05, spec.wheelbase / 2 - 0.05];
    axles.forEach((az, i) => {
      for (const sx of [-1, 1]) {
        const w = wheel(wr, 0.22);
        w.position.set(sx * (W / 2 - 0.12), wr, az);
        body.add(w);
        wheels.push(w);
        if (i === 0) frontWheels.push(w);
      }
    });
  }
  let headlights: THREE.SpotLight | null = null;
  if (withLights) {
    headlights = new THREE.SpotLight(0xfff2d8, 0, 90, 0.5, 0.45, 1.2);
    headlights.position.set(0, 0.9, -L / 2);
    headlights.target.position.set(0, 0, -L / 2 - 25);
    body.add(headlights, headlights.target);
  }
  return { root, body, wheels, frontWheels, headlights, lightMats, brakeMat, doors, sign };
}

export function updateSign(m: VehicleModel, text: string, sub: string) {
  if (!m.sign) return;
  const c = signCanvas(text, sub, m.sign.canvas.width, m.sign.canvas.height);
  m.sign.canvas.getContext('2d')!.drawImage(c, 0, 0);
  m.sign.tex.needsUpdate = true;
}

export function buildPerson(color: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0b896, roughness: 0.7 });
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.6, 3, 8), new THREE.MeshStandardMaterial({ color: 0x2b3245 }));
  legs.position.y = 0.48;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.45, 3, 8), mat);
  torso.position.y = 1.18;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), skin);
  head.position.y = 1.66;
  for (const m of [legs, torso, head]) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}
