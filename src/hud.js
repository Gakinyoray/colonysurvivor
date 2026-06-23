// Heads-up display + pointer interaction. Draws the resource bar, build menu,
// minimap, selection panel, messages and the win/lose overlay, and translates
// clicks into game actions (build, select, supply links, abandon).
import { Option, Resource, TowerType, Difficulty } from './config.js';
import { buildBoardCost, buildSurvivorCost } from './towers.js';

const CP = Option.cellPixels;

const BUILD_BUTTONS = [
  { type: TowerType.DEPOT, key: 'D', label: 'Depot', desc: 'Extends your supply network. Wall it in!' },
  { type: TowerType.SNIPER, key: 'S', label: 'Sniper', desc: 'Shoots zombies in range. Needs ammo + survivors.' },
  { type: TowerType.BARRICADE, key: 'B', label: 'Barricade', desc: 'Blocks zombies. Soaks hits with boards.' },
  { type: TowerType.WORKSHOP, key: 'W', label: 'Workshop', desc: 'Scavenge a building for resources.' },
];

export class Hud {
  constructor(game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.selected = null;
    this.buildType = null;
    this.hoverCell = null;
    this.message = '';
    this.messageTimer = 0;
    this.linkMode = false;     // when a depot is selected, click another to link
    this.buttonRects = [];     // computed each draw for hit-testing
    this.minimap = { x: 0, y: 0, w: 150, h: 150, scale: 1 };

    // on-screen control state + callbacks (wired by main.js for touch devices)
    this.paused = false;
    this.fast = false;
    this.onTogglePause = () => {};
    this.onToggleFast = () => {};
    this.onRestart = () => {};
    this.onMenu = () => {};

    game.on('message', (m) => this.flash(m));
    game.on('horde', (d) => this.flash(`Wave ${d.wave}! ${d.count} zombies incoming.`));
    game.on('win', () => this.flash('The colony survives. Victory!'));
    game.on('lose', () => this.flash('All depots lost. The colony has fallen.'));
  }

  flash(msg) { this.message = msg; this.messageTimer = 240; }

  // --- pointer handling ----------------------------------------------------
  onMove(sx, sy) {
    this.pointer = { sx, sy };
    if (this.buildType != null) {
      this.hoverCell = this.renderer.screenToCell(sx, sy);
    } else {
      this.hoverCell = null;
    }
  }

  onClick(sx, sy, button) {
    // 1) HUD hit-testing first
    for (const r of this.buttonRects) {
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
        r.action();
        return;
      }
    }
    // minimap click -> recenter
    const mm = this.minimap;
    if (sx >= mm.x && sx <= mm.x + mm.w && sy >= mm.y && sy <= mm.y + mm.h) {
      const wx = (sx - mm.x) / mm.scale;
      const wy = (sy - mm.y) / mm.scale;
      this.renderer.centerOn(wx * CP, wy * CP);
      return;
    }

    const cell = this.renderer.screenToCell(sx, sy);
    if (!this.game.map.inBounds(cell.x, cell.y)) return;

    if (button === 2) { // right click cancels build / clears selection
      this.buildType = null; this.selected = null; this.linkMode = false; return;
    }

    if (this.buildType != null) {
      const ok = this.game.build(this.buildType, cell.x, cell.y);
      if (ok && !this.shiftHeld) this.buildType = null; // hold shift to place many
      return;
    }

    const tower = this.game.towerAt(cell.x, cell.y);
    if (this.linkMode && this.selected && tower && tower !== this.selected) {
      this.game.toggleLink(this.selected.pos, tower.pos);
      this.linkMode = false;
      return;
    }
    this.selected = tower || null;
    this.linkMode = false;
  }

  setBuild(type) {
    this.buildType = this.buildType === type ? null : type;
    this.selected = null;
  }

  // --- drawing -------------------------------------------------------------
  draw(ctx) {
    this.buttonRects = [];
    const W = this.renderer.canvas.width;
    const H = this.renderer.canvas.height;
    this.compact = W < 760;       // phone / narrow layout

    this.drawResourceBar(ctx, W);
    this.drawBuildBar(ctx, W, H);
    this.drawSelectionPanel(ctx, H);
    this.drawMinimap(ctx, W, H);
    this.drawControls(ctx, W);
    this.drawWave(ctx, W);
    this.drawMessage(ctx, W, H);
    if (this.game.state !== 0) this.drawEndScreen(ctx, W, H);
  }

  totalResources() {
    const sum = [0, 0, 0, 0];
    for (const t of this.game.towers) for (let r = 0; r < 4; r++) sum[r] += t.count[r];
    return sum;
  }

  drawResourceBar(ctx, W) {
    ctx.fillStyle = 'rgba(15,17,20,0.88)';
    ctx.fillRect(0, 0, W, 36);
    ctx.strokeStyle = '#2a2e36'; ctx.beginPath(); ctx.moveTo(0, 36.5); ctx.lineTo(W, 36.5); ctx.stroke();
    const sums = this.totalResources();
    const colors = Resource.colors;
    // leave room on the right for the pause/fast buttons
    const rightReserve = 96;
    const step = Math.min(150, Math.floor((W - rightReserve - 14) / 4));
    const labelled = step >= 108;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${labelled ? 14 : 12}px monospace`;
    let x = 12;
    for (let r = 0; r < 4; r++) {
      ctx.fillStyle = colors[r];
      ctx.fillRect(x, 11, 14, 14);
      ctx.fillStyle = '#e8ecf2';
      ctx.fillText(labelled ? `${Resource.names[r]}: ${sums[r]}` : `${sums[r]}`, x + 18, 19);
      x += step;
    }
    // colony stats: inline on wide layouts, otherwise folded into the wave line
    this.scavPct = this.game.totals.totalSalvage
      ? Math.floor(100 * this.game.totals.scavenged / this.game.totals.totalSalvage) : 0;
    if (!this.compact && x + 220 < W - rightReserve) {
      ctx.fillStyle = '#9fb0c4'; ctx.font = '12px monospace';
      ctx.fillText(`Depots: ${this.game.depots().length}   Scavenged: ${this.scavPct}%   Zombies: ${this.game.totals.zombies}`, x + 10, 19);
    }
  }

  drawBuildBar(ctx, W, H) {
    const gap = this.compact ? 5 : 8;
    const bw = Math.min(98, Math.floor((W - 24) / BUILD_BUTTONS.length) - gap);
    const bh = this.compact ? 52 : 46;     // taller hit targets on touch
    const total = BUILD_BUTTONS.length * (bw + gap) - gap;
    let x = (W - total) / 2;
    const y = H - bh - 10;
    for (const b of BUILD_BUTTONS) {
      const active = this.buildType === b.type;
      ctx.fillStyle = active ? '#3b5a8a' : 'rgba(20,24,30,0.92)';
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = active ? '#7fb0ff' : '#3a4150';
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
      ctx.fillStyle = '#e8ecf2'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = 'bold 12px monospace';
      ctx.fillText(this.compact ? b.label : `${b.label} [${b.key}]`, x + bw / 2, y + 7);
      ctx.fillStyle = '#9fb0c4'; ctx.font = '10px monospace';
      const bc = buildBoardCost(b.type), sc = Math.max(1, buildSurvivorCost(b.type));
      ctx.fillText(`B${bc} S${sc}`, x + bw / 2, y + 24);
      this.buttonRects.push({ x, y, w: bw, h: bh, action: () => this.setBuild(b.type) });
      x += bw + gap;
    }
    // hint (desktop only — touch has on-screen buttons)
    if (!this.compact) {
      ctx.fillStyle = '#7f8a99'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.fillText('WASD/arrows or drag: scroll · Space: pause · F: fast · Esc: cancel · hold Shift to place multiple',
        W / 2, y - 13);
    }
  }

  // on-screen Pause / Fast buttons (top-right) for touch devices
  drawControls(ctx, W) {
    const bw = 40, bh = 24, y = 6;
    const fx = W - bw - 6, px = fx - bw - 6;
    const btn = (x, label, on, action) => {
      ctx.fillStyle = on ? '#2f6fd0' : 'rgba(40,48,60,0.95)';
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = '#5a6678'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
      ctx.fillStyle = '#e8ecf2'; ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x + bw / 2, y + bh / 2);
      this.buttonRects.push({ x, y, w: bw, h: bh, action });
    };
    btn(px, this.paused ? '▶' : 'II', this.paused, () => this.onTogglePause());
    btn(fx, '»', this.fast, () => this.onToggleFast());
  }

  drawSelectionPanel(ctx, H) {
    const t = this.selected;
    if (!t) return;
    const x = 12, y = H - 168, w = 220, h = 142;
    ctx.fillStyle = 'rgba(15,17,20,0.92)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#3a4150'; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.fillStyle = '#e8ecf2'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = 'bold 13px monospace';
    const name = { [TowerType.HQ]: 'Headquarters', [TowerType.DEPOT]: 'Depot', [TowerType.SNIPER]: 'Sniper Post', [TowerType.BARRICADE]: 'Barricade', [TowerType.WORKSHOP]: 'Workshop' }[t.type];
    ctx.fillText(name, x + 10, y + 8);
    ctx.font = '11px monospace'; ctx.fillStyle = '#aebccd';
    let ly = y + 30;
    for (let r = 0; r < 4; r++) {
      ctx.fillStyle = Resource.colors[r];
      ctx.fillRect(x + 10, ly + 2, 9, 9);
      ctx.fillStyle = '#cdd8e4';
      ctx.fillText(`${Resource.names[r]}: ${t.count[r]}  (want ${t.reserve[r]})`, x + 24, ly);
      ly += 16;
    }
    // actions
    this.panelButton(ctx, x + 10, y + h - 30, 92, 22, this.linkMode ? 'Linking…' : 'Supply link', () => {
      if (t.type === TowerType.DEPOT || t.type === TowerType.HQ) this.linkMode = !this.linkMode;
      else this.flash('Only depots can form supply links.');
    });
    if (t.type !== TowerType.HQ) {
      this.panelButton(ctx, x + 112, y + h - 30, 92, 22, 'Abandon', () => {
        this.game.abandon(t.pos.x, t.pos.y); this.selected = null;
      });
    }
  }

  panelButton(ctx, x, y, w, h, label, action) {
    ctx.fillStyle = 'rgba(40,48,60,0.95)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#5a6678'; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.fillStyle = '#e8ecf2'; ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
    this.buttonRects.push({ x, y, w, h, action });
  }

  drawMinimap(ctx, W, H) {
    const map = this.game.map;
    const size = this.compact ? Math.min(110, Math.floor(W * 0.28)) : 156;
    const scale = size / Math.max(map.width, map.height);
    const mx = W - map.width * scale - 10, my = 38;
    this.minimap = { x: mx, y: my, w: map.width * scale, h: map.height * scale, scale };
    ctx.fillStyle = 'rgba(8,9,11,0.9)';
    ctx.fillRect(mx - 4, my - 4, map.width * scale + 8, map.height * scale + 8);
    // terrain
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const c = map.get(x, y);
        if (c.fog <= 0) { ctx.fillStyle = '#000'; }
        else if (c.background === 3) ctx.fillStyle = '#1b3a5a';
        else if (c.building) ctx.fillStyle = c.fog >= 2 ? c.building.type.mini : '#2a2a2e';
        else ctx.fillStyle = c.fog >= 2 ? '#43474e' : '#26282d';
        ctx.fillRect(mx + x * scale, my + y * scale, Math.ceil(scale), Math.ceil(scale));
      }
    }
    // towers
    for (const t of this.game.towers) {
      ctx.fillStyle = { [TowerType.HQ]: '#5aa0ff', [TowerType.DEPOT]: '#3b78c0', [TowerType.SNIPER]: '#3fd06a', [TowerType.BARRICADE]: '#caa050', [TowerType.WORKSHOP]: '#ff9a3a' }[t.type];
      ctx.fillRect(mx + t.pos.x * scale - 1, my + t.pos.y * scale - 1, 3, 3);
    }
    // zombies (only where visible)
    ctx.fillStyle = '#ff5a5a';
    for (const z of this.game.zombies) {
      if (z.dead) continue;
      const c = map.get(z.cell.x, z.cell.y);
      if (c && c.fog >= 2) ctx.fillRect(mx + z.cell.x * scale, my + z.cell.y * scale, 2, 2);
    }
    // viewport rect
    const cam = this.renderer.cam;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.strokeRect(mx + (cam.x / CP) * scale, my + (cam.y / CP) * scale,
      (this.renderer.canvas.width / CP) * scale, (this.renderer.canvas.height / CP) * scale);
  }

  drawWave(ctx, W) {
    const g = this.game;
    ctx.textBaseline = 'top'; ctx.font = 'bold 13px monospace';
    let txt;
    if (g.sandbox) txt = `Sandbox · Wave ${g.hordeCount}`;
    else if (g.hordeCount >= g.maxWaves) txt = `Final stretch — clear the city!`;
    else txt = `Wave ${g.hordeCount}/${g.maxWaves} · next ${Math.ceil(g.waveTimer / Option.fps)}s`;
    ctx.fillStyle = '#ffd24a';
    if (this.compact) {
      // left-aligned, with colony stats folded in (no room for the wide bar)
      ctx.textAlign = 'left';
      ctx.fillText(txt, 12, 42);
      ctx.fillStyle = '#9fb0c4'; ctx.font = '11px monospace';
      ctx.fillText(`Depots ${g.depots().length} · Scav ${this.scavPct}% · Zeds ${g.totals.zombies}`, 12, 58);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(txt, W / 2, 44);
    }
  }

  drawMessage(ctx, W, H) {
    if (this.messageTimer <= 0) return;
    this.messageTimer--;
    ctx.globalAlpha = Math.min(1, this.messageTimer / 40);
    // smaller and lower on narrow screens so it clears the stats line
    const fs = this.compact ? 12 : 16;
    const y = this.compact ? 84 : 60;
    ctx.font = `bold ${fs}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = Math.min(W - 12, ctx.measureText(this.message).width + 24);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect((W - w) / 2, y, w, fs + 12);
    ctx.fillStyle = '#fff';
    ctx.fillText(this.message, W / 2, y + (fs + 12) / 2);
    ctx.globalAlpha = 1;
  }

  drawEndScreen(ctx, W, H) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = this.game.state === 1 ? '#7fffa0' : '#ff7676';
    ctx.font = 'bold 42px monospace';
    ctx.fillText(this.game.state === 1 ? 'VICTORY' : 'COLONY LOST', W / 2, H / 2 - 30);
    ctx.fillStyle = '#cdd8e4'; ctx.font = '16px monospace';
    ctx.fillText(`Waves survived: ${this.game.hordeCount}   Zombies killed: ${this.game.totals.totalKilled || 0}`, W / 2, H / 2 + 12);
    // tappable buttons (also bound to R / M on desktop)
    const bw = 150, bh = 40, gap = 16, by = H / 2 + 44;
    const rx = W / 2 - bw - gap / 2, mx = W / 2 + gap / 2;
    const endBtn = (x, label, action) => {
      ctx.fillStyle = 'rgba(40,48,60,0.95)'; ctx.fillRect(x, by, bw, bh);
      ctx.strokeStyle = '#5a6678'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, by + 0.5, bw, bh);
      ctx.fillStyle = '#e8ecf2'; ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x + bw / 2, by + bh / 2);
      this.buttonRects.push({ x, y: by, w: bw, h: bh, action });
    };
    endBtn(rx, 'Play again [R]', () => this.onRestart());
    endBtn(mx, 'Menu [M]', () => this.onMenu());
  }
}
