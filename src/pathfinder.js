// Fog-of-war reveal + truck pathfinding + zombie flow field ("scent").
import { Point, DIRS } from './util.js';
import { Background } from './map.js';

// --- Fog of war: reveal cells within radius with simple line-of-sight. -----
// Buildings/water block sight. Towers reveal a radius around themselves.
export function revealCircle(map, cx, cy, radius) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const tx = cx + dx, ty = cy + dy;
      if (!map.inBounds(tx, ty)) continue;
      if (hasLineOfSight(map, cx, cy, tx, ty)) {
        const c = map.get(tx, ty);
        c.fog = 2;
      }
    }
  }
}

function blocksSight(cell) {
  return cell.background === Background.BUILDING;
}

function hasLineOfSight(map, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  while (true) {
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === x1 && y === y1) return true;
    const c = map.get(x, y);
    if (c && blocksSight(c)) return false;
  }
}

// At the end of each visible frame, downgrade fully-visible cells to "explored"
// unless re-revealed; this keeps a memory of the map.
export function ageFog(map) {
  for (const c of map.cells) {
    if (c.fog === 2) c.fog = 1.5; // transient; renderer treats >=2 as bright
  }
}

// --- Truck pathfinding (BFS, avoids other towers + zombies) ----------------
export function findPath(map, start, goal, opts = {}) {
  const W = map.width, H = map.height;
  const startK = start.y * W + start.x;
  const goalK = goal.y * W + goal.x;
  if (startK === goalK) return [goal.clone()];
  const came = new Int32Array(W * H).fill(-1);
  const seen = new Uint8Array(W * H);
  const queue = [startK];
  seen[startK] = 1;
  let head = 0;
  while (head < queue.length) {
    const k = queue[head++];
    const x = k % W, y = (k / W) | 0;
    for (const d of DIRS) {
      const nx = x + d.x, ny = y + d.y;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nk = ny * W + nx;
      if (seen[nk]) continue;
      const c = map.cells[nk];
      const isGoal = nk === goalK;
      if (!isGoal) {
        if (!c.isPassable()) continue;
        if (c.background === Background.ENTRANCE && !opts.allowEntrance) continue;
        if (c.hasTower()) continue;
        if (c.hasZombies() && !opts.ignoreZombies) continue;
      }
      seen[nk] = 1;
      came[nk] = k;
      if (isGoal) {
        return reconstruct(came, startK, goalK, W);
      }
      queue.push(nk);
    }
  }
  return null;
}

function reconstruct(came, startK, goalK, W) {
  const path = [];
  let k = goalK;
  while (k !== -1 && k !== startK) {
    path.push(new Point(k % W, (k / W) | 0));
    k = came[k];
  }
  path.reverse();
  return path;
}

// --- Zombie flow field toward depots --------------------------------------
// BFS distance from every depot over passable cells. Zombies greedily descend
// the gradient; "noise" events can re-seed extra sources to lure them.
export function computeFlowField(map, sources) {
  const W = map.width, H = map.height;
  const dist = new Int32Array(W * H).fill(-1);
  const queue = [];
  let head = 0;
  for (const s of sources) {
    if (!map.inBounds(s.x, s.y)) continue;
    const k = s.y * W + s.x;
    if (dist[k] === -1) { dist[k] = 0; queue.push(k); }
  }
  while (head < queue.length) {
    const k = queue[head++];
    const x = k % W, y = (k / W) | 0;
    const base = dist[k];
    for (const d of DIRS) {
      const nx = x + d.x, ny = y + d.y;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nk = ny * W + nx;
      if (dist[nk] !== -1) continue;
      const c = map.cells[nk];
      // zombies can shamble across roads, parks, bridges and through building
      // interiors (they don't care about doors); only water/explicit blocks stop them
      if (c.blocked || c.background === Background.WATER) continue;
      dist[nk] = base + 1;
      queue.push(nk);
    }
  }
  return dist;
}

// Given a flow field, return the best next step from (x,y) descending the gradient.
export function flowNext(map, dist, x, y) {
  const W = map.width;
  const here = dist[y * W + x];
  if (here <= 0) return null;
  let best = null, bestD = here;
  for (const d of DIRS) {
    const nx = x + d.x, ny = y + d.y;
    if (!map.inBounds(nx, ny)) continue;
    const nk = ny * W + nx;
    const nd = dist[nk];
    if (nd === -1) continue;
    if (nd < bestD) { bestD = nd; best = new Point(nx, ny); }
  }
  return best;
}
