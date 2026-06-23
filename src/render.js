// Canvas renderer: draws the world (tiles, fog, towers, trucks, zombies,
// supply lines, effects) for a given camera. HUD is drawn separately.
import { Option, Resource, TowerType } from './config.js';
import { Background } from './map.js';

const CP = Option.cellPixels;

const BG_COLORS = {
  [Background.ROAD]: '#3a3a3e',
  [Background.BUILDING]: '#2b2b30',
  [Background.ENTRANCE]: '#46413a',
  [Background.WATER]: '#1b3a5a',
  [Background.BRIDGE]: '#54473a',
  [Background.PARK]: '#2f4030',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0 };
  }
  // Size the drawing buffer to the canvas's actual displayed CSS size so the
  // buffer and the on-screen element match 1:1 (otherwise touch/click hit-
  // testing drifts, badly near the bottom on mobile). Call with no args.
  resize(w, h) {
    if (w == null && this.canvas.getBoundingClientRect) {
      const r = this.canvas.getBoundingClientRect();
      w = Math.round(r.width); h = Math.round(r.height);
    }
    this.canvas.width = Math.max(1, w || 1);
    this.canvas.height = Math.max(1, h || 1);
  }

  clampCamera(map) {
    const maxX = map.width * CP - this.canvas.width;
    const maxY = map.height * CP - this.canvas.height;
    this.cam.x = Math.max(-20, Math.min(this.cam.x, Math.max(0, maxX) + 20));
    this.cam.y = Math.max(-20, Math.min(this.cam.y, Math.max(0, maxY) + 20));
  }
  centerOn(px, py) {
    this.cam.x = px - this.canvas.width / 2;
    this.cam.y = py - this.canvas.height / 2;
  }
  screenToCell(sx, sy) {
    return { x: Math.floor((sx + this.cam.x) / CP), y: Math.floor((sy + this.cam.y) / CP) };
  }
  cellToScreen(cx, cy) {
    return { x: cx * CP - this.cam.x, y: cy * CP - this.cam.y };
  }

  render(game, ui) {
    const ctx = this.ctx;
    const { map } = game;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const x0 = Math.max(0, Math.floor(this.cam.x / CP));
    const y0 = Math.max(0, Math.floor(this.cam.y / CP));
    const x1 = Math.min(map.width - 1, Math.ceil((this.cam.x + this.canvas.width) / CP));
    const y1 = Math.min(map.height - 1, Math.ceil((this.cam.y + this.canvas.height) / CP));

    // --- terrain + fog ---
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = map.get(x, y);
        const sx = x * CP - this.cam.x;
        const sy = y * CP - this.cam.y;
        if (c.fog <= 0) { continue; } // unseen = black
        let col = c.building ? c.building.type.color : BG_COLORS[c.background];
        ctx.fillStyle = col;
        ctx.fillRect(sx, sy, CP, CP);
        // entrance doorway hint
        if (c.background === Background.ENTRANCE && c.salvage > 0) {
          ctx.fillStyle = 'rgba(255,210,120,0.18)';
          ctx.fillRect(sx + 6, sy + 6, CP - 12, CP - 12);
        }
        if (c.rubble) {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(sx + 3, sy + 3, CP - 6, CP - 6);
        }
        // road grid lines
        if (c.background === Background.ROAD) {
          ctx.strokeStyle = 'rgba(255,255,255,0.04)';
          ctx.strokeRect(sx + 0.5, sy + 0.5, CP, CP);
        }
        // explored-but-not-visible dimming
        if (c.fog < 2) {
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(sx, sy, CP, CP);
        }
      }
    }

    // --- supply links ---
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(90,170,255,0.55)';
    ctx.setLineDash([6, 4]);
    for (const t of game.towers) {
      for (const dest of t.links) {
        if (t.pos.key() > dest.key()) continue; // draw once
        const a = this.cellToScreen(t.pos.x, t.pos.y);
        const b = this.cellToScreen(dest.x, dest.y);
        ctx.beginPath();
        ctx.moveTo(a.x + CP / 2, a.y + CP / 2);
        ctx.lineTo(b.x + CP / 2, b.y + CP / 2);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // --- sniper ranges (subtle) ---
    for (const t of game.towers) {
      if (t.type === TowerType.SNIPER) {
        const s = this.cellToScreen(t.pos.x, t.pos.y);
        ctx.strokeStyle = 'rgba(120,255,160,0.18)';
        ctx.beginPath();
        ctx.arc(s.x + CP / 2, s.y + CP / 2, (t.range + 0.5) * CP, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- towers ---
    for (const t of game.towers) this.drawTower(ctx, t, game);

    // --- trucks ---
    for (const tr of game.trucks) {
      const cell = map.get(tr.cell.x, tr.cell.y);
      if (cell && cell.fog < 2 && !tr.fleeing) continue;
      this.drawTruck(ctx, tr);
    }

    // --- zombies ---
    for (const z of game.zombies) {
      const cell = map.get(z.cell.x, z.cell.y);
      if (cell && cell.fog < 2) continue; // hidden in fog
      this.drawZombie(ctx, z);
    }

    // --- effects ---
    for (const e of game.effects) this.drawEffect(ctx, e);

    // --- build ghost / selection ---
    if (ui) this.drawInteraction(ctx, game, ui);
  }

  drawTower(ctx, t, game) {
    const s = this.cellToScreen(t.pos.x, t.pos.y);
    const cxp = s.x + CP / 2, cyp = s.y + CP / 2;
    let col = '#888';
    switch (t.type) {
      case TowerType.HQ: col = '#2f6fd0'; break;
      case TowerType.DEPOT: col = '#3b78c0'; break;
      case TowerType.SNIPER: col = '#2f7d3f'; break;
      case TowerType.BARRICADE: col = '#8a6a30'; break;
      case TowerType.WORKSHOP: col = '#c07a2a'; break;
    }
    ctx.fillStyle = col;
    if (t.type === TowerType.BARRICADE) {
      ctx.fillRect(s.x + 4, s.y + 10, CP - 8, CP - 20);
      // posts
      ctx.fillStyle = '#5a4520';
      ctx.fillRect(s.x + 4, s.y + 8, 4, CP - 16);
      ctx.fillRect(s.x + CP - 8, s.y + 8, 4, CP - 16);
    } else {
      ctx.fillRect(s.x + 3, s.y + 3, CP - 6, CP - 6);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + 3.5, s.y + 3.5, CP - 7, CP - 7);
    }
    // icon glyph
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const glyph = { [TowerType.HQ]: '★', [TowerType.DEPOT]: '⌂', [TowerType.SNIPER]: '✚', [TowerType.WORKSHOP]: '⚙' }[t.type];
    if (glyph) ctx.fillText(glyph, cxp, cyp);

    // sniper barrel
    if (t.type === TowerType.SNIPER) {
      ctx.strokeStyle = '#cfe';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cxp, cyp);
      ctx.lineTo(cxp + Math.cos(t.angle * Math.PI / 180) * 12, cyp + Math.sin(t.angle * Math.PI / 180) * 12);
      ctx.stroke();
    }
    // need indicator (flashing dot)
    if (t.hasNeeds && t.hasNeeds() && Math.floor(performance.now() / 400) % 2 === 0) {
      ctx.fillStyle = '#ff5555';
      ctx.beginPath();
      ctx.arc(s.x + CP - 5, s.y + 5, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // survivor count for depots
    if (t.type === TowerType.DEPOT || t.type === TowerType.HQ) {
      ctx.fillStyle = '#cde';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(String(t.count[Resource.SURVIVORS]), cxp, s.y + CP - 11);
    }
  }

  drawTruck(ctx, tr) {
    const col = ['#cccccc', '#a86b2a', '#5577ff', '#33cc44'][tr.res];
    const x = tr.px - this.cam.x, y = tr.py - this.cam.y;
    ctx.fillStyle = tr.fleeing ? '#ffd24a' : '#dfe6ee';
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    // cargo dot
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, 2.3, 0, Math.PI * 2); ctx.fill();
  }

  drawZombie(ctx, z) {
    const x = z.px - this.cam.x, y = z.py - this.cam.y;
    if (z.dead) {
      ctx.globalAlpha = Math.max(0, z.deathTimer / 30);
      ctx.fillStyle = '#7a2a2a';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.globalAlpha = z.alpha;
    ctx.fillStyle = z.attacking ? '#9adb5a' : '#6f9e3f';
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    // little head
    ctx.fillStyle = '#cfe39a';
    ctx.beginPath(); ctx.arc(x, y - 1.5, 2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawEffect(ctx, e) {
    if (e.type === 'shot') {
      const a = this.cellToScreen(e.x1, e.y1);
      const b = this.cellToScreen(e.x2, e.y2);
      ctx.strokeStyle = `rgba(255,240,180,${e.t / 4})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x + CP / 2, a.y + CP / 2);
      ctx.lineTo(b.x + CP / 2, b.y + CP / 2);
      ctx.stroke();
    } else if (e.type === 'headshot') {
      const s = this.cellToScreen(e.x, e.y);
      ctx.fillStyle = `rgba(200,40,40,${e.t / 10})`;
      ctx.beginPath();
      ctx.arc(s.x + CP / 2, s.y + CP / 2, (10 - e.t) + 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawInteraction(ctx, game, ui) {
    // selection highlight
    if (ui.selected) {
      const s = this.cellToScreen(ui.selected.pos.x, ui.selected.pos.y);
      ctx.strokeStyle = '#ffe14a';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 1, s.y + 1, CP - 2, CP - 2);
      // show supply radius for depots
      if (ui.selected.type === TowerType.DEPOT || ui.selected.type === TowerType.HQ) {
        ctx.strokeStyle = 'rgba(90,170,255,0.25)';
        ctx.beginPath();
        ctx.arc(s.x + CP / 2, s.y + CP / 2, Option.supplyRange * CP, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // build ghost
    if (ui.buildType != null && ui.hoverCell) {
      const { x, y } = ui.hoverCell;
      const s = this.cellToScreen(x, y);
      const ok = game.canPlace(ui.buildType, x, y) && game.affordable(ui.buildType, x, y);
      ctx.fillStyle = ok ? 'rgba(80,220,120,0.4)' : 'rgba(220,70,70,0.4)';
      ctx.fillRect(s.x + 2, s.y + 2, CP - 4, CP - 4);
      // supply range from nearest depot
      const sup = game.suppliedBy(x, y);
      if (sup) {
        const ss = this.cellToScreen(sup.pos.x, sup.pos.y);
        ctx.strokeStyle = 'rgba(90,170,255,0.25)';
        ctx.beginPath();
        ctx.arc(ss.x + CP / 2, ss.y + CP / 2, Option.supplyRange * CP, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
