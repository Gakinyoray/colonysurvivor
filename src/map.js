// The city grid: cells, backgrounds, buildings, and procedural generation.
import { Option } from './config.js';
import { Point, DIRS, rand, weightedIndex } from './util.js';
import { BUILDING_TYPES } from './buildings.js';

export const Background = {
  ROAD: 0,
  BUILDING: 1,
  ENTRANCE: 2, // building doorway facing a road (where workshops attach)
  WATER: 3,
  BRIDGE: 4,
  PARK: 5,
};

export class MapCell {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.background = Background.ROAD;
    this.building = null;   // ref to Building instance
    this.tower = null;      // ref to Tower instance
    this.rubble = false;
    // salvage pool when this cell sits inside a salvageable building
    this.salvage = 0;
    this.salvageProfile = null;
    // fog of war: 0 unseen, 1 explored (dim), 2 visible
    this.fog = 0;
    // zombies currently standing on this cell (array)
    this.zombies = [];
    this.trucks = [];
    // zombie "scent"/guide direction set when noise propagates (Direction index or -1)
    this.scent = -1;
    this.blocked = false; // impassable terrain
  }
  isRoad() {
    return this.background === Background.ROAD || this.background === Background.BRIDGE;
  }
  hasTower() { return this.tower !== null; }
  hasZombies() { return this.zombies.length > 0; }
  hasTrucks() { return this.trucks.length > 0; }
  isPassable() {
    return !this.blocked && this.background !== Background.WATER &&
      this.background !== Background.BUILDING;
  }
}

export class Building {
  constructor(typeId, x, y, w, h) {
    this.type = BUILDING_TYPES[typeId];
    this.typeId = typeId;
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.cells = [];        // entrance cells that can be scavenged
    this.totalSalvage = 0;
    this.harvested = 0;
    this.cleared = false;
    this.hiddenZombies = 0;  // zombies lurking inside; must be flushed out to win
  }
  rect() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
}

// A bridge spanning the water ring: the only place zombies enter the city.
// Destroying every bridge (and clearing the map) is the win condition.
export class Bridge {
  constructor(cells, side) {
    this.cells = cells;        // Point[] from the outer edge inward
    this.side = side;          // 'N' | 'S' | 'E' | 'W'
    this.spawn = cells[0];     // outermost cell where a horde appears
    this.destroyed = false;
    this.charging = 0;         // frames left on a demolition fuse (0 = none)
  }
}

export class GameMap {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.cells = new Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        this.cells[y * width + x] = new MapCell(x, y);
    this.buildings = [];
    this.bridges = [];    // entry points for zombie hordes (Point list)
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
  get(x, y) {
    if (!this.inBounds(x, y)) return null;
    return this.cells[y * this.width + x];
  }

  forEachCell(fn) {
    for (let i = 0; i < this.cells.length; i++) fn(this.cells[i]);
  }

  // ---- noise: zombies are attracted to towers/shots; lay a scent gradient
  // We compute, on demand, a BFS distance field to all depots used for guiding
  // zombies (handled in pathfinder). Here we just expose neighbour helpers.
  neighbors4(x, y) {
    const out = [];
    for (const d of DIRS) {
      const c = this.get(x + d.x, y + d.y);
      if (c) out.push(c);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Procedural city generation.
// Lay a regular grid of road lanes; fill each block with one building of a
// weighted-random type, surrounded by an "entrance" ring on the road side.
// ---------------------------------------------------------------------------
export function generateCity(map, difficulty) {
  const W = map.width, H = map.height;
  const roadEvery = 6;      // block pitch
  const roadWidth = 2;

  // 1) carve roads on a grid, everything else starts as building-fill candidate
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cell = map.get(x, y);
      const onRoadX = (x % roadEvery) < roadWidth;
      const onRoadY = (y % roadEvery) < roadWidth;
      cell.background = (onRoadX || onRoadY) ? Background.ROAD : Background.BUILDING;
    }
  }

  // 2) fill blocks with buildings
  const dist = Option.buildingDistribution;
  for (let by = 0; by < H; by += roadEvery) {
    for (let bx = 0; bx < W; bx += roadEvery) {
      const x0 = bx + roadWidth;
      const y0 = by + roadWidth;
      const x1 = Math.min(bx + roadEvery, W) - 1;
      const y1 = Math.min(by + roadEvery, H) - 1;
      if (x1 < x0 || y1 < y0) continue;
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      if (w < 2 || h < 2) continue;

      const typeId = weightedIndex(dist);
      const type = BUILDING_TYPES[typeId];
      const b = new Building(typeId, x0, y0, w, h);

      // salvage pool scales with footprint
      const footprint = w * h;
      b.totalSalvage = footprint * 4;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const c = map.get(xx, yy);
          c.background = Background.BUILDING;
          c.building = b;
          c.salvageProfile = type.salvage;
        }
      }
      // entrance cells = building edge cells touching a road; these are
      // where a workshop can be placed (mark distributed salvage there)
      const perEntrance = Math.max(1, Math.floor(b.totalSalvage / Math.max(1, edgeCount(map, b))));
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (touchesRoad(map, xx, yy)) {
            const c = map.get(xx, yy);
            c.background = Background.ENTRANCE;
            c.salvage = perEntrance;
            b.cells.push(c);
          }
        }
      }
      if (b.cells.length === 0) {
        // landlocked block: make its first cell an entrance anyway
        const c = map.get(x0, y0);
        c.background = Background.ENTRANCE;
        c.salvage = b.totalSalvage;
        b.cells.push(c);
      }
      // some buildings harbour zombies that must be flushed out to win
      const lurkChance = 26 + difficulty * 6;
      if (rand(100) < lurkChance) {
        b.hiddenZombies = 1 + rand(2 + difficulty);
      }
      map.buildings.push(b);
    }
  }

  // 3) ring the city with water and place fixed bridges on all four sides —
  // the only entry points for zombies. Destroying them all is part of winning.
  placeWaterRingAndBridges(map, difficulty);

  map.totalHidden = map.buildings.reduce((a, b) => a + b.hiddenZombies, 0);
  return map;
}

function touchesRoad(map, x, y) {
  for (const d of DIRS) {
    const c = map.get(x + d.x, y + d.y);
    if (c && (c.background === Background.ROAD || c.background === Background.BRIDGE)) return true;
  }
  return false;
}

function edgeCount(map, b) {
  let n = 0;
  for (let yy = b.y; yy < b.y + b.h; yy++)
    for (let xx = b.x; xx < b.x + b.w; xx++)
      if (touchesRoad(map, xx, yy)) n++;
  return n;
}

function placeWaterRingAndBridges(map, difficulty) {
  const W = map.width, H = map.height;
  const ring = 2;
  const setWater = (x, y) => {
    const c = map.get(x, y);
    if (!c) return;
    c.background = Background.WATER;
    c.blocked = true;
    c.building = null;
    c.salvage = 0;
  };
  // 1) water moat on all four sides
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (x < ring || y < ring || x >= W - ring || y >= H - ring) setWater(x, y);

  // 2) collect road lanes that reach each edge of the interior
  const cols = [], rows = [];
  for (let x = ring; x < W - ring; x++) if (map.get(x, ring).isRoad()) cols.push(x);
  for (let y = ring; y < H - ring; y++) if (map.get(ring, y).isRoad()) rows.push(y);

  const perSide = Math.max(W, H) <= 48 ? 1 : 2;
  const pick = (lanes) => {
    const out = [];
    for (let i = 0; i < perSide && lanes.length; i++) {
      out.push(lanes[Math.min(lanes.length - 1, Math.floor(((i + 0.5) / perSide) * lanes.length))]);
    }
    return out;
  };

  const carve = (cells, side) => {
    for (const p of cells) {
      const c = map.get(p.x, p.y);
      c.background = Background.BRIDGE;
      c.blocked = false;
      c.building = null;
      c.salvage = 0;
    }
    map.bridges.push(new Bridge(cells, side));
  };

  // North / South bridges span the vertical moat at road columns
  for (const col of pick(cols)) {
    carve(Array.from({ length: ring }, (_, i) => new Point(col, i)), 'N');
    carve(Array.from({ length: ring }, (_, i) => new Point(col, H - 1 - i)), 'S');
  }
  // West / East bridges span the horizontal moat at road rows
  for (const row of pick(rows)) {
    carve(Array.from({ length: ring }, (_, i) => new Point(i, row)), 'W');
    carve(Array.from({ length: ring }, (_, i) => new Point(W - 1 - i, row)), 'E');
  }
  if (map.bridges.length === 0) {
    carve([new Point(0, Math.floor(H / 2)), new Point(1, Math.floor(H / 2))], 'W');
  }
}

// Find a good HQ start: a road cell near the centre, far from the water.
export function findStart(map) {
  const cx = Math.floor(map.width / 2);
  const cy = Math.floor(map.height * 0.65);
  for (let r = 0; r < Math.max(map.width, map.height); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const c = map.get(cx + dx, cy + dy);
        if (c && c.isRoad() && !c.hasTower()) return new Point(cx + dx, cy + dy);
      }
    }
  }
  return new Point(cx, cy);
}
