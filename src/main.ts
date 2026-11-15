import './style.css';
import { Game } from './game/game';
import { openPanel } from './ui/panels';

const canvas = document.getElementById('scene') as HTMLCanvasElement;

function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!webglOk()) {
  document.getElementById('load-text')!.textContent = 'Váš prohlížeč nepodporuje WebGL, hra nemůže běžet.';
} else {
  const game = new Game(canvas);
  // Dotykové ovládání.
  const touch = game.input.touch;
  document.querySelectorAll<HTMLButtonElement>('#touch [data-t]').forEach((b) => {
    const t = b.dataset.t!;
    const set = (v: boolean) => {
      if (t === 'left') touch.steer = v ? -1 : touch.steer === -1 ? 0 : touch.steer;
      if (t === 'right') touch.steer = v ? 1 : touch.steer === 1 ? 0 : touch.steer;
      if (t === 'gas') touch.throttle = v ? 1 : 0;
      if (t === 'brake') touch.brake = v ? 1 : 0;
      if (t === 'hand') touch.handbrake = v;
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      set(true);
    });
    b.addEventListener('pointerup', () => set(false));
    b.addEventListener('pointercancel', () => set(false));
  });
  document.querySelectorAll<HTMLButtonElement>('#touch [data-key]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: b.dataset.key }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: b.dataset.key })), 60);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('#menu-bar [data-panel]').forEach((b) => {
    b.addEventListener('click', () => {
      openPanel(game, b.dataset.panel!);
    });
  });
  (window as unknown as { game: Game }).game = game;
  void game.start();
}
