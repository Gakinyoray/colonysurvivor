// Mobile actors: Truck (survivor courier) and Zombie.
import { Option, Resource, TowerType } from './config.js';
import { Point, DIRS, rand } from './util.js';
import { findPath } from './pathfinder.js';
import { loadSize } from './towers.js';

const CP = Option.cellPixels;
function cx(c) { return c.x * CP + CP / 2; }
function cy(c) { return c.y * CP + CP / 2; }

// ---------------------------------------------------------------------------
// Truck: a survivor carrying a load of one resource from source to dest tower.
// ---------------------------------------------------------------------------
export class Truck {
  constructor(game, source, dest, res, amount) {
    this.game = game;
    this.source = source;          // Tower
    this.dest = dest;              // Tower
    this.res = res;
    this.amount = amount;
    this.cell = source.pos.clone();
    this.px = cx(this.cell);
    this.py = cy(this.cell);
    this.dead = false;
    this.retries = 0;
    this.framesPerCell = 9;        // courier pace (playability-tuned)
    this.fleeing = false;          // survivors fleeing a fallen tower
    this.angle = 0;
    this.resetPath();
    this.driverCarried = res !== Resource.SURVIVORS; // a driver in addition to cargo
  }
  resetPath() {
    this.path = findPath(this.game.map, this.cell, this.dest.pos, { allowEntrance: true });
    this.pathIndex = 0;
    this.movingTo = null;
  }
  beginMove(next) {
    this.movingTo = next;
    this.fromX = this.px; this.fromY = this.py;
    this.toX = cx(next); this.toY = cy(next);
    this.progress = 0;
    this.angle = Math.atan2(this.toY - this.fromY, this.toX - this.fromX);
    // occupancy for zombie kill checks
    this.game.map.get(this.cell.x, this.cell.y)?.trucks.splice(
      this.game.map.get(this.cell.x, this.cell.y).trucks.indexOf(this), 1);
    this.cell = next.clone();
    const nc = this.game.map.get(next.x, next.y);
    if (nc) nc.trucks.push(this);
  }
  arrive() {
    // delivered
    this.dest.resolveIncoming(this.res, this.amount);
    this.dest.give(this.res, this.amount);
    if (this.driverCarried) {
      this.dest.resolveIncoming(Resource.SURVIVORS, 1);
      this.dest.give(Resource.SURVIVORS, 1);
    }
    this.game.onTruckArrive(this);
    this.cleanup();
  }
  cleanup() {
    this.dead = true;
    const c = this.game.map.get(this.cell.x, this.cell.y);
    if (c) {
      const i = c.trucks.indexOf(this);
      if (i >= 0) c.trucks.splice(i, 1);
    }
  }
  // turned by a zombie -> the cargo is lost and a zombie spawns here
  turncoat() {
    if (this.dead) return;
    // cargo never arrives
    this.dest.resolveIncoming(this.res, this.amount);
    if (this.driverCarried) this.dest.resolveIncoming(Resource.SURVIVORS, 1);
    this.cleanup();
    this.game.spawnZombieAt(this.cell.x, this.cell.y, Zombie.ATTACK_SPAWN);
    this.game.onTurncoat(this);
  }
  step() {
    if (this.dead) return;
    if (this.movingTo) {
      this.progress += 1 / this.framesPerCell;
      if (this.progress >= 1) {
        this.px = this.toX; this.py = this.toY;
        this.movingTo = null;
        this.game.addNoise(this.cell, Option.truckNoise);
      } else {
        this.px = this.fromX + (this.toX - this.fromX) * this.progress;
        this.py = this.fromY + (this.toY - this.fromY) * this.progress;
        return;
      }
    }
    // arrived at a cell -> decide next
    if (this.cell.equals(this.dest.pos)) { this.arrive(); return; }
    if (this.dest.dead) { this.cleanup(); return; }
    if (!this.path || this.pathIndex >= this.path.length) {
      this.retry(); return;
    }
    const next = this.path[this.pathIndex];
    const nc = this.game.map.get(next.x, next.y);
    const blocked = !nc || nc.hasZombies() ||
      (nc.hasTower() && !next.equals(this.dest.pos));
    if (blocked) { this.retry(); return; }
    this.pathIndex++;
    this.beginMove(next);
  }
  retry() {
    this.retries++;
    if (this.retries > Option.truckRetries) {
      // give up: return cargo bookkeeping and vanish
      this.dest.resolveIncoming(this.res, this.amount);
      if (this.driverCarried) this.dest.resolveIncoming(Resource.SURVIVORS, 1);
      // hand the load back to the source so resources aren't lost
      this.source.give(this.res, this.amount);
      if (this.driverCarried) this.source.give(Resource.SURVIVORS, 1);
      this.cleanup();
      return;
    }
    this.resetPath();
  }
}

// ---------------------------------------------------------------------------
// Zombie: shambles toward depots (via flow field) and attacks structures.
// ---------------------------------------------------------------------------
export class Zombie {
  static START_SPAWN = 0;
  static BUILDING_SPAWN = 1;
  static WAVE_SPAWN = 2;
  static ATTACK_SPAWN = 3;

  constructor(game, x, y, spawnType = Zombie.WAVE_SPAWN) {
    this.game = game;
    this.cell = new Point(x, y);
    this.px = cx(this.cell);
    this.py = cy(this.cell);
    this.dead = false;
    this.attacking = false;
    this.attackTimer = 0;
    this.movingTo = null;
    this.lastPos = this.cell.clone();
    this.type = rand(12);
    this.angle = 0;
    this.deathTimer = 0;
    const diff = game.difficulty;
    const base = Option.zombieSpeed[Math.min(diff, Option.zombieSpeed.length - 1)];
    // scale frames/cell down for playability (original units are finer-grained)
    this.framesPerCell = Math.max(8, Math.round((base + rand(Option.zombieSpeedRange)) / 4));
    // spawn fade-in
    this.spawnFrame = spawnType === Zombie.START_SPAWN ? 0 : Option.spawnFrameCount;
    this.alpha = this.spawnFrame > 0 ? 0 : 1;
    if (this.spawnFrame === 0) this.register();
    this.noiseDest = null;
  }
  register() {
    const c = this.game.map.get(this.cell.x, this.cell.y);
    if (c) c.zombies.push(this);
  }
  unregister() {
    const c = this.game.map.get(this.cell.x, this.cell.y);
    if (c) {
      const i = c.zombies.indexOf(this);
      if (i >= 0) c.zombies.splice(i, 1);
    }
  }
  kill(fromPos) {
    if (this.dead) return;
    this.unregister();
    this.dead = true;
    this.deathTimer = 30;
    this.game.onZombieKilled(this, fromPos);
  }
  beginMove(next) {
    this.movingTo = next;
    this.fromX = this.px; this.fromY = this.py;
    this.toX = cx(next); this.toY = cy(next);
    this.progress = 0;
    this.angle = Math.atan2(this.toY - this.fromY, this.toX - this.fromX);
    this.unregister();
    this.lastPos = this.cell.clone();
    this.cell = next.clone();
    this.register();
  }
  step() {
    if (this.dead) return;
    if (this.spawnFrame > 0) {
      this.spawnFrame--;
      this.alpha = 1 - this.spawnFrame / Option.spawnFrameCount;
      if (this.spawnFrame === 0) { this.alpha = 1; this.register(); }
      return;
    }
    if (this.attacking) {
      this.attackTimer--;
      if (this.attackTimer <= 0) { this.attacking = false; }
      return;
    }
    if (this.movingTo) {
      this.progress += 1 / this.framesPerCell;
      if (this.progress >= 1) {
        this.px = this.toX; this.py = this.toY; this.movingTo = null;
      } else {
        this.px = this.fromX + (this.toX - this.fromX) * this.progress;
        this.py = this.fromY + (this.toY - this.fromY) * this.progress;
        return;
      }
    }
    this.plan();
  }
  plan() {
    const next = this.game.zombieNextStep(this);
    if (!next) { this.attacking = true; this.attackTimer = 10; return; }
    const nc = this.game.map.get(next.x, next.y);
    if (!nc) { this.attacking = true; this.attackTimer = 10; return; }
    if (nc.hasTower()) {
      // attack the structure
      this.attacking = true;
      this.attackTimer = 12;
      this.angle = Math.atan2(cy(next) - this.py, cx(next) - this.px);
      this.game.zombieAttackTower(next);
      return;
    }
    if (nc.hasTrucks()) {
      this.attacking = true;
      this.attackTimer = 12;
      this.game.zombieAttackTrucks(next);
      return;
    }
    this.beginMove(next);
  }
}
