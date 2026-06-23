// Bootstrap: menu, fixed-timestep game loop (20 fps like the original SWF),
// input handling, audio wiring.
import { Option, Difficulty } from './config.js';
import { Game, GameState } from './game.js';
import { Renderer } from './render.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { Net } from './net.js';

const canvas = document.getElementById('game');
const menu = document.getElementById('menu');
const renderer = new Renderer(canvas);
const audio = new Audio();

let game = null;
let hud = null;
let paused = false;
let fast = false;
let selectedDifficulty = Difficulty.NOVICE;

const STEP_MS = 1000 / Option.fps;
let acc = 0;
let last = performance.now();
const keys = new Set();

function resize() {
  renderer.resize();              // match the canvas's real displayed size
  if (game) renderer.clampCamera(game.map);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// Map a client (CSS px) point to canvas buffer coordinates. With the buffer
// sized to the displayed element these scale factors are ~1, but computing
// them explicitly keeps hit-testing correct under any DPR / layout.
function ptr(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    sx: (clientX - r.left) * (canvas.width / Math.max(1, r.width)),
    sy: (clientY - r.top) * (canvas.height / Math.max(1, r.height)),
  };
}

// --- menu wiring -----------------------------------------------------------
document.querySelectorAll('#difficulty button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#difficulty button').forEach((x) => x.classList.remove('sel'));
    b.classList.add('sel');
    selectedDifficulty = parseInt(b.dataset.diff, 10);
  });
});

document.getElementById('btn-start').addEventListener('click', () => {
  const sandbox = document.getElementById('sandbox').checked;
  newGame({ difficulty: selectedDifficulty, sandbox });
});

const continueBtn = document.getElementById('btn-continue');
continueBtn.disabled = !Net.hasSave();
continueBtn.addEventListener('click', () => {
  const save = Net.loadGame();
  if (save) loadGame(save);
});

document.getElementById('btn-share').addEventListener('click', async () => {
  const out = document.getElementById('share-result');
  out.textContent = 'Uploading seed to (mock) server…';
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const res = await Net.uploadMap({ seed, difficulty: selectedDifficulty, sandbox: document.getElementById('sandbox').checked });
  out.innerHTML = `Share code <b>${res.code}</b>${res.mock ? ' (local mock)' : ''}<br/>${res.url}`;
});

async function showLeaderboard() {
  const el = document.getElementById('leaderboard');
  const scores = await Net.leaderboard();
  if (!scores.length) { el.innerHTML = '<b>Leaderboard</b><div class="row"><span>No runs yet — survive a few waves!</span></div>'; return; }
  el.innerHTML = '<b>Leaderboard</b>' + scores.slice(0, 6).map((s) =>
    `<div class="row"><span>${Difficulty.names[s.difficulty] || '?'}</span><span>${s.waves} waves · ${s.killed} kills</span></div>`).join('');
}
Net.ping().finally(showLeaderboard);

// --- game lifecycle --------------------------------------------------------
function wireAudio(g) {
  g.on('shot', () => audio.shot());
  g.on('bash', () => audio.bash());
  g.on('zombie-killed', () => audio.death());
  g.on('built', () => audio.build());
  g.on('tower-destroyed', () => audio.destroyed());
  g.on('horde', () => audio.horde());
  g.on('win', () => onGameEnd());
  g.on('lose', () => onGameEnd());
}

function wireHudControls(h) {
  h.onTogglePause = () => { paused = !paused; };
  h.onToggleFast = () => { fast = !fast; };
  h.onRestart = () => newGame({ difficulty: game.difficulty, sandbox: game.sandbox });
  h.onMenu = () => backToMenu();
}

function newGame(opts) {
  audio.ensure();
  game = new Game(opts);
  hud = new Hud(game, renderer);
  wireHudControls(hud);
  wireAudio(game);
  renderer.centerOn(game.hq.pos.x * Option.cellPixels, game.hq.pos.y * Option.cellPixels);
  renderer.clampCamera(game.map);
  menu.classList.add('hidden');
  paused = false; fast = false;
  hud.flash('Defend the colony. Scavenge, build, survive.');
}

function loadGame(save) {
  // The serialized save replays the same seed/difficulty and restores towers,
  // fog and salvage — a faithful "Continue" using localStorage as the
  // SharedObject replacement.
  newGame({ difficulty: save.difficulty, sandbox: save.sandbox, seed: save.seed });
  game.frame = save.frame || 0;
  game.hordeCount = save.hordeCount || 0;
  game.waveTimer = save.waveTimer || game.waveTimer;
  // wipe auto-created HQ towers, rebuild from save
  for (const t of game.towers) { const c = game.map.get(t.pos.x, t.pos.y); if (c) c.tower = null; }
  game.towers = [];
  for (const ts of save.towers) {
    const t = game.placeTowerRaw(ts.type, ts.x, ts.y);
    t.level = ts.level || 0;
    t.count = ts.count.slice();
    t.reserve = ts.reserve.slice();
    t.links = ts.links.map(([x, y]) => ({ x, y, equals(p){return p&&this.x===p.x&&this.y===p.y;}, clone(){return {x:this.x,y:this.y,equals:this.equals,clone:this.clone,key:this.key};}, key(){return this.x*100000+this.y;} }));
  }
  game.hq = game.depots()[0] || game.hq;
  if (save.salvage) save.salvage.forEach((v, i) => { game.map.cells[i].salvage = v; });
  if (save.fog) save.fog.forEach((v, i) => { game.map.cells[i].fog = v ? 1 : 0; });
  game.recomputeFlow();
  renderer.centerOn(game.hq.pos.x * Option.cellPixels, game.hq.pos.y * Option.cellPixels);
}

let lastModerateMoan = 0;
function onGameEnd() {
  // submit a (mock) leaderboard score
  Net.submitScore({ difficulty: game.difficulty, waves: game.hordeCount, killed: game.totals.totalKilled });
  Net.saveGame(game.serialize());
}

function backToMenu() {
  menu.classList.remove('hidden');
  document.getElementById('btn-continue').disabled = !Net.hasSave();
  showLeaderboard();
  game = null; hud = null;
}

// --- input -----------------------------------------------------------------
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousemove', (e) => {
  if (!hud) return;
  const p = ptr(e.clientX, e.clientY);
  hud.onMove(p.sx, p.sy);
});
canvas.addEventListener('mousedown', (e) => {
  if (!hud) return;
  audio.ensure();
  const p = ptr(e.clientX, e.clientY);
  hud.shiftHeld = e.shiftKey;
  hud.onClick(p.sx, p.sy, e.button);
});

window.addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (!game) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { paused = !paused; e.preventDefault(); }
  else if (k === 'f') fast = !fast;
  else if (k === 'd') hud.setBuild(2);  // Depot
  else if (k === 's') hud.setBuild(1);  // Sniper
  else if (k === 'b') hud.setBuild(0);  // Barricade
  else if (k === 'w') hud.setBuild(3);  // Workshop
  else if (k === 'escape') { hud.buildType = null; hud.selected = null; hud.linkMode = false; }
  else if (k === 'r' && game.state !== GameState.PLAY) newGame({ difficulty: game.difficulty, sandbox: game.sandbox });
  else if (k === 'm' && game.state !== GameState.PLAY) backToMenu();
  else if (k === 'g') { Net.saveGame(game.serialize()); hud.flash('Game saved.'); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// --- touch input (mobile): tap = click, drag = pan camera ------------------
let touch = null;
canvas.addEventListener('touchstart', (e) => {
  if (!hud) return;
  e.preventDefault();
  audio.ensure();
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  const p = ptr(t.clientX, t.clientY);
  touch = {
    startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY,
    sx: p.sx, sy: p.sy, moved: false,
  };
  hud.onMove(touch.sx, touch.sy);
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  if (!hud || !touch || e.touches.length !== 1) return;
  e.preventDefault();
  const t = e.touches[0];
  const r = canvas.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(1, r.width), scaleY = canvas.height / Math.max(1, r.height);
  const dx = (t.clientX - touch.lastX) * scaleX, dy = (t.clientY - touch.lastY) * scaleY;
  touch.lastX = t.clientX; touch.lastY = t.clientY;
  touch.sx = (t.clientX - r.left) * scaleX; touch.sy = (t.clientY - r.top) * scaleY;
  if (Math.abs(t.clientX - touch.startX) > 8 || Math.abs(t.clientY - touch.startY) > 8) touch.moved = true;
  if (touch.moved && game) {
    renderer.cam.x -= dx; renderer.cam.y -= dy;
    renderer.clampCamera(game.map);
  }
  if (hud.buildType != null) hud.onMove(touch.sx, touch.sy);
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  if (!hud || !touch) return;
  e.preventDefault();
  if (!touch.moved) {
    // a tap: keep build mode active after placing so several can be dropped
    hud.shiftHeld = hud.buildType != null;
    hud.onMove(touch.sx, touch.sy);
    hud.onClick(touch.sx, touch.sy, 0);
  }
  touch = null;
}, { passive: false });
// belt-and-braces: stop the page itself from scrolling on touch devices
document.addEventListener('touchmove', (e) => { if (game) e.preventDefault(); }, { passive: false });

function handleScroll() {
  const sp = 14;
  if (keys.has('w') && hud?.buildType == null) {} // W is build; don't scroll with it
  if (keys.has('arrowup')) renderer.cam.y -= sp;
  if (keys.has('arrowdown')) renderer.cam.y += sp;
  if (keys.has('arrowleft')) renderer.cam.x -= sp;
  if (keys.has('arrowright')) renderer.cam.x += sp;
  // edge scroll
  if (hud?.pointer) {
    const { sx, sy } = hud.pointer;
    const m = 24;
    if (sx < m) renderer.cam.x -= sp;
    if (sx > canvas.width - m) renderer.cam.x += sp;
    if (sy < m) renderer.cam.y -= sp;
    if (sy > canvas.height - m) renderer.cam.y += sp;
  }
  renderer.clampCamera(game.map);
}

// --- main loop -------------------------------------------------------------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(250, now - last);
  last = now;
  if (game) {
    handleScroll();
    if (!paused && game.state === GameState.PLAY) {
      acc += dt;
      const mult = fast ? Option.fastFrames : 1;
      let steps = 0;
      while (acc >= STEP_MS && steps < 60) {
        for (let i = 0; i < mult; i++) game.step();
        acc -= STEP_MS;
        steps++;
      }
      // ambient moans
      if (game.zombies.length && now - lastModerateMoan > 1500) {
        audio.moan(); lastModerateMoan = now;
      }
      // autosave occasionally
      if (game.frame % (Option.fps * 30) === 0) Net.saveGame(game.serialize());
    }
    hud.paused = paused; hud.fast = fast;
    renderer.render(game, hud);
    hud.draw(renderer.ctx);
    if (paused) drawPaused();
  }
}
function drawPaused() {
  const ctx = renderer.ctx;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('PAUSED — press Space', canvas.width / 2, canvas.height / 2);
}
requestAnimationFrame(frame);

// debug/inspection hook (handy for testing and the browser console)
window.SC = {
  get game() { return game; },
  get hud() { return hud; },
  get renderer() { return renderer; },
  get paused() { return paused; },
  get fast() { return fast; },
};

// support ?map=CODE deep links from the mock share feature
(async function maybeLoadShared() {
  const code = new URLSearchParams(location.search).get('map');
  if (!code) return;
  const data = await Net.downloadMap(code);
  if (data) {
    selectedDifficulty = data.difficulty ?? Difficulty.NOVICE;
    document.getElementById('sandbox').checked = !!data.sandbox;
    newGame({ difficulty: selectedDifficulty, sandbox: !!data.sandbox, seed: data.seed });
  }
})();
