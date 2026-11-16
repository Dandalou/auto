// Stopy pneumatik na vozovce při smyku a prudkém brzdění (kruhový buffer pásů).

import * as THREE from 'three';
import type { World } from '../world/world';
import type { Vehicle } from './vehicle';

const MAX = 3000; // počet úseků

export class Skidmarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  private last: ({ lx: number; lz: number; rx: number; rz: number; y: number } | null)[] = [null, null];
  private anchor: { x: number; z: number } | null = null;

  constructor(private world: World) {
    this.pos = new Float32Array(MAX * 6 * 3);
    this.alpha = new Float32Array(MAX * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -16,
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.05, 0.05, 0.06, vA * 0.55); }',
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(v: Vehicle, active: boolean) {
    if (!this.anchor || Math.hypot(v.x - this.anchor.x, v.z - this.anchor.z) > 3000) {
      // Nové místo: staré stopy zahodit.
      this.anchor = { x: Math.round(v.x), z: Math.round(v.z) };
      this.alpha.fill(0);
      (this.mesh.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
      this.last = [null, null];
    }
    this.mesh.position.set(this.anchor.x - this.world.origin.x, 0, this.anchor.z - this.world.origin.z);
    const marking = active && !v.airborne && v.speed > 3 && (v.slip > 0.45 || v.accel < -7) && !!v.onRoad;
    const [fx, fz] = v.forward();
    const rx = -fz, rz = fx;
    const back = v.spec.wheelbase / 2;
    const half = v.spec.width / 2 - 0.2;
    const w = 0.12;
    let changed = false;
    for (let k = 0; k < 2; k++) {
      if (!marking) {
        this.last[k] = null;
        continue;
      }
      const side = k === 0 ? -1 : 1;
      const cx = v.x - fx * back + rx * half * side - this.anchor.x;
      const cz = v.z - fz * back + rz * half * side - this.anchor.z;
      const y = this.world.groundHeight(cx + this.anchor.x, cz + this.anchor.z, v.y + 1) + 0.25;
      const cur = { lx: cx + rx * w, lz: cz + rz * w, rx: cx - rx * w, rz: cz - rz * w, y };
      const prev = this.last[k];
      this.last[k] = cur;
      if (!prev || Math.hypot(cur.lx - prev.lx, cur.lz - prev.lz) < 0.3) {
        if (prev) this.last[k] = prev;
        continue;
      }
      changed = true;
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      const q = [
        [prev.lx, prev.y, prev.lz], [prev.rx, prev.y, prev.rz], [cur.lx, cur.y, cur.lz],
        [cur.lx, cur.y, cur.lz], [prev.rx, prev.y, prev.rz], [cur.rx, cur.y, cur.rz],
      ];
      q.forEach((p, j) => {
        this.pos.set(p, (i * 6 + j) * 3);
        this.alpha[i * 6 + j] = Math.min(1, v.slip + 0.3);
      });
    }
    if (!changed) return;
    const g = this.mesh.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
  }
}
