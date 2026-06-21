// Core game engine: world state, simulation step, waves, build rules, win/lose.
import { Option, Resource, TowerType, Difficulty } from './config.js';
import { Point, DIRS, rand, seed, choice } from './util.js';
import { GameMap, generateCity, findStart, Background } from './map.js';
import {
  computeFlowField, flowNext, revealCircle, ageFog, findPath,
} from './pathfinder.js';
import {
  Depot, Sniper, Barricade, Workshop, makeTower,
  buildBoardCost, buildSurvivorCost, loadSize,
} from './towers.js';
import { Truck, Zombie } from './actors.js';

export const GameState = { PLAY: 0, WIN: 1, LOSE: 2 };

export class Game {
  constructor(opts = {}) {
    this.difficulty = opts.difficulty ?? Difficulty.NOVICE;
    this.sandbox = opts.sandbox ?? false;
    this.maxWaves = opts.maxWaves ?? 8;
    this.seedValue = opts.seed ?? (Date.now() >>> 0);
    seed(this.seedValue);

    const size = Option.sizeList[Math.min(this.difficulty, Option.sizeList.length - 1)];
    this.map = new GameMap(size, size);
    generateCity(this.map, this.difficulty);

    this.towers = [];
    this.zombies = [];
    this.trucks = [];
    this.effects = [];          // transient visual effects (shots, deaths)
    this.noiseSources = new Map();
    this.zombieFlow = null;
    this.flowTimer = 0;

    this.frame = 0;
    this.state = GameState.PLAY;
    this.hordeCount = 0;
    this.waveTimer = Option.fps * 45; // first horde delay (s)
    this.activeWave = 0;            // zombies currently in an active horde
    this.cleared = false;

    this.totals = { zombies: 0, scavenged: 0, totalSalvage: 0, totalKilled: 0 };
    for (const b of this.map.buildings) this.totals.totalSalvage += b.totalSalvage;

    this.listeners = {};

    // place HQ
    const start = findStart(this.map);
    this.hq = this.placeTowerRaw(TowerType.HQ, start.x, start.y);
    this.hq.give(Resource.BOARDS, 45);
    this.hq.give(Resource.AMMO, 30);
    this.hq.give(Resource.SURVIVORS, 12);
    this.hq.give(Resource.FOOD, 10);
    this.start = start;
    this.recomputeFlow();
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, data) { (this.listeners[evt] || []).forEach((f) => f(data)); }

  // --- queries -------------------------------------------------------------
  towerAt(x, y) {
    const c = this.map.get(x, y);
    return c ? c.tower : null;
  }
  depots() { return this.towers.filter((t) => !t.dead && (t.type === TowerType.DEPOT || t.type === TowerType.HQ)); }
  aliveTowers() { return this.towers.filter((t) => !t.dead); }

  // --- noise & flow --------------------------------------------------------
  addNoise(pos, radius) {
    if (radius < Option.shootNoise) return; // only loud noises lure the horde
    const k = pos.y * this.map.width + pos.x;
    this.noiseSources.set(k, Math.max(this.noiseSources.get(k) || 0, radius));
  }
  recomputeFlow() {
    const sources = [];
    for (const t of this.depots()) sources.push(t.pos);
    // loud noise cells also attract zombies
    for (const [k, strength] of this.noiseSources) {
      if (strength >= Option.shootNoise) {
        sources.push(new Point(k % this.map.width, (k / this.map.width) | 0));
      }
    }
    if (sources.length === 0) sources.push(this.start);
    this.zombieFlow = computeFlowField(this.map, sources);
    // decay noise
    for (const [k, v] of this.noiseSources) {
      const nv = Math.floor(v / 2);
      if (nv < Option.shootNoise) this.noiseSources.delete(k);
      else this.noiseSources.set(k, nv);
    }
  }
  zombieNextStep(z) {
    let next = this.zombieFlow ? flowNext(this.map, this.zombieFlow, z.cell.x, z.cell.y) : null;
    if (next) return next;
    // wander
    const opts = [];
    for (const d of DIRS) {
      const c = this.map.get(z.cell.x + d.x, z.cell.y + d.y);
      if (c && !c.blocked && c.background !== Background.WATER && !c.hasZombies()) opts.push(new Point(z.cell.x + d.x, z.cell.y + d.y));
    }
    return opts.length ? choice(opts) : null;
  }

  // --- building / placement ------------------------------------------------
  canPlace(type, x, y) {
    const c = this.map.get(x, y);
    if (!c || c.hasTower() || c.hasZombies() || c.blocked) return false;
    if (c.background === Background.WATER || c.background === Background.BRIDGE) return false;
    const supplied = type === TowerType.WORKSHOP ? this.suppliedBy(x, y) : this.suppliedBy(x, y);
    if (type === TowerType.WORKSHOP) {
      const salvageable = (c.salvage > 0) || c.rubble || c.building != null;
      return salvageable && supplied != null;
    }
    // depot/sniper/barricade need a clear road-like cell
    const roadLike = c.background === Background.ROAD;
    return roadLike && !c.rubble && supplied != null;
  }
  // nearest supplying depot within supplyRange (Manhattan); returns Depot or null
  suppliedBy(x, y) {
    let best = null, bestD = 1e9;
    for (const t of this.depots()) {
      const d = Point.dist(new Point(x, y), t.pos);
      if (d <= Option.supplyRange && d < bestD) { best = t; bestD = d; }
    }
    return best;
  }
  // a depot within range that can actually pay for `type` (prefers nearest)
  supplierFor(type, x, y) {
    let best = null, bestD = 1e9;
    const board = buildBoardCost(type), surv = buildSurvivorCost(type);
    for (const t of this.depots()) {
      const d = Point.dist(new Point(x, y), t.pos);
      if (d > Option.supplyRange) continue;
      if (t.count[Resource.BOARDS] < board || t.count[Resource.SURVIVORS] < surv) continue;
      if (d < bestD) { best = t; bestD = d; }
    }
    return best;
  }
  // affordable(type, x, y) — true if any in-range depot can pay
  affordable(type, x, y) {
    return this.supplierFor(type, x, y) != null;
  }
  // Player build action: returns true on success.
  build(type, x, y) {
    if (this.state !== GameState.PLAY) return false;
    if (!this.canPlace(type, x, y)) return false;
    const supplier = this.supplierFor(type, x, y);
    if (!supplier) {
      this.emit('message', this.suppliedBy(x, y) ? 'Not enough resources nearby.' : 'Out of supply range.');
      return false;
    }
    supplier.take(Resource.BOARDS, buildBoardCost(type));
    supplier.take(Resource.SURVIVORS, buildSurvivorCost(type));
    const t = this.placeTowerRaw(type, x, y);
    // auto-link to supplier (two-way) so trucks flow
    t.link(supplier.pos);
    supplier.link(t.pos);
    this.addNoise(new Point(x, y), Option.buildNoise);
    this.emit('built', t);
    if (type === TowerType.DEPOT) this.recomputeFlow();
    return true;
  }
  placeTowerRaw(type, x, y) {
    const t = makeTower(this, type, x, y);
    const c = this.map.get(x, y);
    c.tower = t;
    if (type === TowerType.WORKSHOP && c.rubble === false && c.building) {
      // workshops sit on the building, not on a road
    }
    this.towers.push(t);
    revealCircle(this.map, x, y, 4);
    return t;
  }
  // create a manual supply link between two depots the player owns
  toggleLink(a, b) {
    const ta = this.towerAt(a.x, a.y), tb = this.towerAt(b.x, b.y);
    if (!ta || !tb || ta === tb) return false;
    if (Point.dist(a, b) > Option.supplyRange * 2) return false;
    if (ta.links.some((p) => p.equals(b))) {
      ta.unlink(b); tb.unlink(a);
    } else {
      ta.link(b); tb.link(a);
    }
    return true;
  }
  abandon(x, y) {
    const t = this.towerAt(x, y);
    if (!t || t.type === TowerType.HQ) return false;
    this.closeTower(t);
    return true;
  }

  // --- supply trucks -------------------------------------------------------
  spawnTruck(source, dest, res, amount) {
    if (amount <= 0) return null;
    const driver = res !== Resource.SURVIVORS;
    source.take(res, amount);
    dest.addIncoming(res, amount);
    if (driver) {
      source.take(Resource.SURVIVORS, 1);
      dest.addIncoming(Resource.SURVIVORS, 1);
    }
    const t = new Truck(this, source, dest, res, amount);
    if (!t.path) { // no route; refund
      dest.resolveIncoming(res, amount); source.give(res, amount);
      if (driver) { dest.resolveIncoming(Resource.SURVIVORS, 1); source.give(Resource.SURVIVORS, 1); }
      return null;
    }
    this.trucks.push(t);
    return t;
  }

  // --- zombie attack callbacks --------------------------------------------
  zombieAttackTower(pos) {
    const t = this.towerAt(pos.x, pos.y);
    if (!t || t.dead) return;
    if (t.type === TowerType.BARRICADE) {
      t.bash();
      this.emit('barricade-bash', t);
    } else {
      t.integrity--;
      this.emit('bash', t);
      if (t.integrity <= 0) {
        this.fleeTower(t);
        t.destroy();
      }
    }
  }
  zombieAttackTrucks(pos) {
    const c = this.map.get(pos.x, pos.y);
    if (!c) return;
    while (c.trucks.length) c.trucks[0].turncoat();
  }
  fleeTower(t) {
    // survivors abandon the tower and run to the nearest other depot
    const survivors = t.count[Resource.SURVIVORS];
    if (survivors <= 0) return;
    let nearest = null, nd = 1e9;
    for (const d of this.depots()) {
      if (d === t || d.dead) continue;
      const dist = Point.dist(t.pos, d.pos);
      if (dist < nd) { nd = dist; nearest = d; }
    }
    if (nearest) {
      const flee = Math.min(survivors, 4);
      const tr = this.spawnTruck(t, nearest, Resource.SURVIVORS, flee);
      if (tr) tr.fleeing = true;
    }
    t.count[Resource.SURVIVORS] = 0;
  }
  onTowerDestroyed(t) {
    // remove links pointing here
    for (const o of this.towers) o.unlink(t.pos);
    this.emit('tower-destroyed', t);
    if (t.type === TowerType.DEPOT || t.type === TowerType.HQ) {
      this.recomputeFlow();
      if (this.depots().length === 0) this.lose();
    }
  }
  closeTower(t) {
    // graceful removal (workshop done / abandon). Recover a few resources.
    const survivors = t.count[Resource.SURVIVORS];
    t.dead = true;
    const c = this.map.get(t.pos.x, t.pos.y);
    if (c && c.tower === t) c.tower = null;
    for (const o of this.towers) o.unlink(t.pos);
    if (survivors > 0) this.fleeReturn(t, survivors);
    this.emit('tower-closed', t);
  }
  fleeReturn(t, survivors) {
    let nearest = null, nd = 1e9;
    for (const d of this.depots()) {
      if (d === t || d.dead) continue;
      const dist = Point.dist(t.pos, d.pos);
      if (dist < nd) { nd = dist; nearest = d; }
    }
    if (nearest) this.spawnTruck(t, nearest, Resource.SURVIVORS, Math.min(survivors, 4));
  }

  // --- zombie spawning -----------------------------------------------------
  spawnZombieAt(x, y, type = Zombie.WAVE_SPAWN) {
    const z = new Zombie(this, x, y, type);
    this.zombies.push(z);
    this.totals.zombies++;
    return z;
  }
  startHorde() {
    this.hordeCount++;
    const bridges = this.map.bridges.length;
    const size = Option.wanderingZombieBase +
      Option.wanderingZombieIncrement * this.hordeCount * (bridges + 1);
    const mult = Option.zombieMultiplier[Math.min(this.difficulty, Option.zombieMultiplier.length - 1)];
    const count = Math.floor(size * mult);
    for (let i = 0; i < count; i++) {
      const bridge = choice(this.map.bridges);
      // spread spawns around the bridge mouth
      const sx = bridge.x + rand(3) - 1;
      const sy = bridge.y + rand(2);
      const c = this.map.get(sx, sy);
      if (c && c.isPassable()) this.spawnZombieAt(sx, sy, Zombie.WAVE_SPAWN);
      else this.spawnZombieAt(bridge.x, bridge.y, Zombie.WAVE_SPAWN);
    }
    this.emit('horde', { wave: this.hordeCount, count });
  }
  // occasional lone wanderer emerging from an un-scavenged building near a depot
  trickleWanderer() {
    const buildings = this.map.buildings.filter((b) => !b.cleared && b.cells.some((c) => c.salvage > 0));
    if (!buildings.length) return;
    const b = choice(buildings);
    const cell = choice(b.cells);
    this.spawnZombieAt(cell.x, cell.y, Zombie.BUILDING_SPAWN);
  }

  // --- callbacks used for effects / audio ---------------------------------
  onScavenge(ws) { this.emit('scavenge', ws); }
  onSniperShot(sniper, zombie) {
    this.effects.push({ type: 'shot', x1: sniper.pos.x, y1: sniper.pos.y, x2: zombie.cell.x, y2: zombie.cell.y, t: 4 });
    this.emit('shot', sniper);
  }
  onBarricadeBash(t) { this.emit('bash', t); }
  onZombieKilled(z, from) {
    this.totals.zombies--;
    this.totals.totalKilled++;
    this.effects.push({ type: 'headshot', x: z.cell.x, y: z.cell.y, t: 10 });
    this.emit('zombie-killed', z);
  }
  onTruckArrive() {}
  onTurncoat(t) { this.emit('turncoat', t); }

  win() { if (this.state === GameState.PLAY) { this.state = GameState.WIN; this.emit('win'); } }
  lose() { if (this.state === GameState.PLAY) { this.state = GameState.LOSE; this.emit('lose'); } }

  // --- main simulation step (one fixed frame) -----------------------------
  step() {
    if (this.state !== GameState.PLAY) return;
    this.frame++;

    // flow field refresh
    if (this.flowTimer-- <= 0) { this.recomputeFlow(); this.flowTimer = 20; }

    // waves
    if (!this.sandbox && this.hordeCount >= this.maxWaves) {
      // final stretch: win once the map is clear of zombies
      if (this.zombies.filter((z) => !z.dead).length === 0 && this.frame > 60) {
        this.cleared = true; this.win();
      }
    } else {
      this.waveTimer--;
      if (this.waveTimer <= 0) {
        this.startHorde();
        // hordes come faster as the colony grows
        this.waveTimer = Math.max(Option.fps * 18, Option.fps * 45 - this.hordeCount * Option.fps * 3);
      }
    }
    // occasional building wanderers
    if (this.frame % (Option.fps * 8) === 0 && rand(3) === 0) this.trickleWanderer();

    // step towers
    for (const t of this.towers) if (!t.dead) t.step();
    // step trucks
    for (const tr of this.trucks) if (!tr.dead) tr.step();
    // step zombies
    for (const z of this.zombies) if (!z.dead || z.deathTimer > 0) {
      if (z.dead) { z.deathTimer--; }
      else z.step();
    }

    // fog memory: visible cells fade to "explored" unless re-revealed below
    for (const c of this.map.cells) if (c.fog >= 2) c.fog = 1;

    // reveal fog around owned towers
    for (const t of this.towers) {
      if (t.dead) continue;
      let r = 4;
      if (t.type === TowerType.DEPOT || t.type === TowerType.HQ) r = Option.supplyRange;
      else if (t.type === TowerType.SNIPER) r = t.range + 1;
      revealCircle(this.map, t.pos.x, t.pos.y, r);
    }
    // trucks light up their immediate surroundings as they travel
    for (const tr of this.trucks) if (!tr.dead) revealCircle(this.map, tr.cell.x, tr.cell.y, 2);

    // reap dead
    this.trucks = this.trucks.filter((t) => !t.dead);
    this.zombies = this.zombies.filter((z) => !z.dead || z.deathTimer > 0);
    this.towers = this.towers.filter((t) => !t.dead);
    this.effects = this.effects.filter((e) => (e.t-- > 0));

    // win by total scavenge (sandbox-friendly secondary goal)
    this.totals.scavenged = this.totals.totalSalvage - this.remainingSalvage();
  }

  remainingSalvage() {
    let s = 0;
    for (const c of this.map.cells) s += c.salvage;
    return s;
  }

  // --- save / load (used by the mock "server" via localStorage) -----------
  serialize() {
    return {
      version: 1,
      difficulty: this.difficulty,
      sandbox: this.sandbox,
      seed: this.seedValue,
      frame: this.frame,
      hordeCount: this.hordeCount,
      waveTimer: this.waveTimer,
      towers: this.towers.map((t) => ({
        type: t.type, x: t.pos.x, y: t.pos.y, level: t.level,
        count: t.count.slice(), reserve: t.reserve.slice(),
        links: t.links.map((p) => [p.x, p.y]),
      })),
      fog: Array.from(this.map.cells, (c) => (c.fog >= 1 ? 1 : 0)),
      salvage: Array.from(this.map.cells, (c) => c.salvage),
    };
  }
}
