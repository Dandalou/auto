// Klávesnice, gamepad a dotykové ovládání sjednocené do jednoho stavu.

export class Input {
  keys = new Set<string>();
  private pressed = new Set<string>();
  touch = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  mouseDX = 0;
  mouseDY = 0;
  dragging = false;
  wheel = 0;

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        this.dragging = true;
        el.setPointerCapture(e.pointerId);
      }
    });
    el.addEventListener('pointerup', () => (this.dragging = false));
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    el.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  /** Jednorázový stisk (od posledního volání endFrame). */
  hit(code: string): boolean {
    return this.pressed.has(code);
  }

  down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  gamepad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  axes(): { throttle: number; brake: number; steer: number; handbrake: boolean } {
    let throttle = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    let steer = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    let handbrake = this.down('Space');
    const gp = this.gamepad();
    if (gp) {
      const ax = gp.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = ax;
      throttle = Math.max(throttle, gp.buttons[7]?.value ?? 0);
      brake = Math.max(brake, gp.buttons[6]?.value ?? 0);
      handbrake ||= !!gp.buttons[0]?.pressed;
    }
    if (this.touch.throttle || this.touch.brake || this.touch.steer || this.touch.handbrake) {
      throttle = Math.max(throttle, this.touch.throttle);
      brake = Math.max(brake, this.touch.brake);
      if (this.touch.steer) steer = this.touch.steer;
      handbrake ||= this.touch.handbrake;
    }
    return { throttle, brake, steer, handbrake };
  }

  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
