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

    this.drawResourceBar(ctx, W);
    this.drawBuildBar(ctx, W, H);
    this.drawSelectionPanel(ctx, H);
    this.drawMinimap(ctx, W, H);
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
    const icons = ['🔫', '🪵', '🍞', '👤'];
    const colors = Resource.colors;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = 'bold 14px monospace';
    let x = 14;
    for (let r = 0; r < 4; r++) {
      ctx.fillStyle = colors[r];
      ctx.fillRect(x, 11, 14, 14);
      ctx.fillStyle = '#e8ecf2';
      ctx.fillText(`${Resource.names[r]}: ${sums[r]}`, x + 20, 19);
      x += 150;
    }
    // colony stats
    ctx.fillStyle = '#9fb0c4'; ctx.font = '12px monospace';
    const scavPct = this.game.totals.totalSalvage ? Math.floor(100 * this.game.totals.scavenged / this.game.totals.totalSalvage) : 0;
    ctx.fillText(`Depots: ${this.game.depots().length}   Scavenged: ${scavPct}%   Zombies: ${this.game.totals.zombies}`, x + 10, 19);
  }

  drawBuildBar(ctx, W, H) {
    const bw = 92, bh = 46, gap = 8;
    const total = BUILD_BUTTONS.length * (bw + gap) - gap;
    let x = (W - total) / 2;
    const y = H - bh - 12;
    ctx.font = 'bold 12px monospace';
    for (const b of BUILD_BUTTONS) {
      const supplier = this.hoverCell ? this.game.suppliedBy(this.hoverCell.x, this.hoverCell.y) : null;
      const active = this.buildType === b.type;
      ctx.fillStyle = active ? '#3b5a8a' : 'rgba(20,24,30,0.9)';
      ctx.fillRect(x, y, bw, bh);
      ctx.strokeStyle = active ? '#7fb0ff' : '#3a4150';
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
      ctx.fillStyle = '#e8ecf2'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`${b.label} [${b.key}]`, x + bw / 2, y + 6);
      ctx.fillStyle = '#9fb0c4'; ctx.font = '10px monospace';
      const bc = buildBoardCost(b.type), sc = Math.max(1, buildSurvivorCost(b.type));
      ctx.fillText(`🪵${bc}  👤${sc}`, x + bw / 2, y + 24);
      ctx.font = 'bold 12px monospace';
      this.buttonRects.push({ x, y, w: bw, h: bh, action: () => this.setBuild(b.type) });
      x += bw + gap;
    }
    // hint
    ctx.fillStyle = '#7f8a99'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('WASD/arrows: scroll · Space: pause · F: fast · Esc: cancel · hold Shift to place multiple',
      W / 2, y - 14);
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
    const size = 156;
    const scale = size / Math.max(map.width, map.height);
    const mx = W - size - 12, my = 44;
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
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.font = 'bold 13px monospace';
    let txt;
    if (g.sandbox) txt = `Sandbox · Wave ${g.hordeCount}`;
    else if (g.hordeCount >= g.maxWaves) txt = `Final stretch — clear the city!`;
    else txt = `Wave ${g.hordeCount}/${g.maxWaves} · next in ${Math.ceil(g.waveTimer / Option.fps)}s`;
    ctx.fillStyle = '#ffd24a';
    ctx.fillText(txt, W / 2, 44);
  }

  drawMessage(ctx, W, H) {
    if (this.messageTimer <= 0) return;
    this.messageTimer--;
    ctx.globalAlpha = Math.min(1, this.messageTimer / 40);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(this.message).width + 30;
    ctx.fillRect((W - w) / 2, 60, w, 28);
    ctx.fillStyle = '#fff';
    ctx.fillText(this.message, W / 2, 74);
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
    ctx.fillText('Press R to play again · M for menu', W / 2, H / 2 + 40);
  }
}
