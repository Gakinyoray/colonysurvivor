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
  }
  rect() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
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
      map.buildings.push(b);
    }
  }

  // 3) place a river + bridges along one edge to act as horde spawn lanes
  placeRiverAndBridges(map, difficulty);

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

function placeRiverAndBridges(map, difficulty) {
  const W = map.width, H = map.height;
  const nBridges = Option.bridgeCount[Math.min(difficulty, Option.bridgeCount.length - 1)] || 1;
  // river along the top two rows
  const riverRows = 2;
  for (let y = 0; y < riverRows; y++) {
    for (let x = 0; x < W; x++) {
      const c = map.get(x, y);
      c.background = Background.WATER;
      c.blocked = true;
      c.building = null;
      c.salvage = 0;
    }
  }
  // bridges: pick columns aligned to road lanes
  const roadCols = [];
  for (let x = 0; x < W; x++) if (map.get(x, riverRows).isRoad()) roadCols.push(x);
  const chosen = [];
  for (let i = 0; i < nBridges && roadCols.length; i++) {
    const idx = Math.floor(((i + 0.5) / nBridges) * roadCols.length);
    const col = roadCols[Math.min(idx, roadCols.length - 1)];
    chosen.push(col);
  }
  for (const col of chosen) {
    for (let y = 0; y < riverRows; y++) {
      const c = map.get(col, y);
      c.background = Background.BRIDGE;
      c.blocked = false;
    }
    map.bridges.push(new Point(col, 0));
  }
  if (map.bridges.length === 0) {
    // guarantee at least one entry lane on the left edge
    const c = map.get(0, Math.floor(H / 2));
    c.background = Background.BRIDGE; c.blocked = false;
    map.bridges.push(new Point(0, Math.floor(H / 2)));
  }
}

// Find a good HQ start: a road cell near the centre, far from the river.
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
