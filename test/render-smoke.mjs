// Render/HUD smoke test: drives the canvas-facing code with a stub 2D context
// to catch reference errors without a real browser.
import { Game } from '../src/game.js';
import { Renderer } from '../src/render.js';
import { Hud } from '../src/hud.js';
import { TowerType, Resource } from '../src/config.js';

let failures = 0;
const assert = (c, m) => { if (!c) { console.error('  ✗ ' + m); failures++; } else console.log('  ✓ ' + m); };

// minimal 2D context stub: every method is a no-op, measureText returns a width
function stubCtx() {
  const handler = {
    get(t, prop) {
      if (prop === 'measureText') return () => ({ width: 42 });
      if (prop === 'canvas') return t.canvas;
      if (prop in t) return t[prop];
      return () => {};
    },
    set(t, prop, v) { t[prop] = v; return true; },
  };
  return new Proxy({ canvas: null }, handler);
}
const canvas = { width: 1024, height: 640 };
canvas.getContext = () => { const c = stubCtx(); c.canvas = canvas; return c; };
// performance is global in Node 18+, but guard just in case
if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };

const renderer = new Renderer(canvas);
const game = new Game({ difficulty: 2, sandbox: false, seed: 99 });
const hud = new Hud(game, renderer);

// build something so towers/links/ranges/selection all draw
const { x, y } = game.hq.pos;
function spot(type) {
  for (let r = 1; r < 12; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (game.canPlace(type, x + dx, y + dy)) return { x: x + dx, y: y + dy };
  return null;
}
const ws = spot(TowerType.WORKSHOP); if (ws) game.build(TowerType.WORKSHOP, ws.x, ws.y);
const sn = spot(TowerType.SNIPER); if (sn) game.build(TowerType.SNIPER, sn.x, sn.y);
hud.selected = game.hq;
hud.buildType = TowerType.BARRICADE;
hud.onMove(500, 300);

let threw = null;
try {
  for (let f = 0; f < 600; f++) {
    game.step();
    renderer.render(game, hud);
    hud.draw(renderer.ctx);
  }
  // exercise interaction handlers
  hud.onClick(20, 20, 0);
  hud.onClick(renderer.canvas.width - 80, 60, 0); // minimap area
  hud.setBuild(TowerType.DEPOT);
} catch (e) { threw = e; }

assert(!threw, threw ? `render/HUD threw: ${threw.stack}` : 'render + HUD ran 600 frames without error');
console.log(failures === 0 ? '\nRENDER SMOKE PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
