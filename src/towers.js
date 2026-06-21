// Towers: Depot/HQ, Sniper, Barricade, Workshop. These are the player's
// structures. Resource bookkeeping mirrors the original Storage model with
// count / reserve (desired minimum) / incoming (en-route) per resource.
import { Option, Resource, TowerType } from './config.js';
import { Point, DIRS, rand, angleBetween } from './util.js';
import { rollSalvage } from './buildings.js';
import { revealCircle } from './pathfinder.js';

// units carried per "load" for a given resource (survivors = 1, else 10)
export function loadSize(res) {
  return res === Resource.SURVIVORS ? 1 : Option.truckLoad;
}

// Build costs. The decompiled `*Cost` tables are upgrade-cost tables whose
// build slot (index 0) is always 0, so the original's exact build prices are
// ambiguous. These are tuned for the same economy feel: scavenge boards with
// cheap workshops, then expand with depots and wall up with barricades.
const BUILD_BOARDS = {
  [TowerType.WORKSHOP]: 5,
  [TowerType.BARRICADE]: 8,
  [TowerType.SNIPER]: 12,
  [TowerType.DEPOT]: 24,
};
const BUILD_SURVIVORS = {
  [TowerType.WORKSHOP]: 1,
  [TowerType.BARRICADE]: 0,
  [TowerType.SNIPER]: 1,
  [TowerType.DEPOT]: 2,
};
export function buildBoardCost(type) { return BUILD_BOARDS[type] || 0; }
export function buildSurvivorCost(type) { return BUILD_SURVIVORS[type] || 0; }

export class Tower {
  constructor(game, x, y, type) {
    this.game = game;
    this.pos = new Point(x, y);
    this.type = type;
    this.level = 0;
    this.count = [0, 0, 0, 0];
    this.reserve = [0, 0, 0, 0];
    this.incoming = [0, 0, 0, 0];
    this.capacity = [9999, 9999, 9999, 9999];
    this.waitCounter = 0;
    this.speed = 100;
    this.links = [];        // Point[] of linked tower positions
    this.dead = false;
    this.flashNeed = false;
    // Faithful to the original, an undefended structure falls fast — but we
    // give a few hit-points so a lone zombie doesn't delete the HQ in one
    // frame before the player can react. Barricades ignore this (boards = HP).
    this.maxIntegrity = 1;
    this.integrity = 1;
  }

  // resource helpers --------------------------------------------------------
  give(res, n) { this.count[res] = Math.min(this.capacity[res], this.count[res] + n); }
  take(res, n) { this.count[res] = Math.max(0, this.count[res] - n); }
  has(res, n) { return this.count[res] >= n; }
  avail(res) { return this.count[res] - this.reserve[res]; }
  need(res) { return Math.max(0, this.reserve[res] - this.count[res] - this.incoming[res]); }
  addReserve(res, n) { this.reserve[res] += n; }
  addIncoming(res, n) { this.incoming[res] += n; }
  resolveIncoming(res, n) { this.incoming[res] = Math.max(0, this.incoming[res] - n); }

  totalCount() { return this.count.reduce((a, b) => a + b, 0); }

  link(dest) {
    if (!this.links.some((p) => p.equals(dest))) this.links.push(dest.clone());
  }
  unlink(dest) {
    this.links = this.links.filter((p) => !p.equals(dest));
  }

  // returns true if this tower wants resources it lacks
  hasNeeds() {
    for (let r = 0; r < 4; r++) if (this.need(r) > 0) return true;
    return false;
  }

  emitNoise(radius) {
    this.game.addNoise(this.pos, radius);
  }

  // Common dispatch: depots push goods to linked towers/depots that need them.
  dispatchSupply() {
    // need a survivor to drive a truck
    if (this.count[Resource.SURVIVORS] < 1) return false;
    // First satisfy explicit needs of linked structures.
    let best = null;
    for (const dest of this.links) {
      const t = this.game.towerAt(dest.x, dest.y);
      if (!t || t.dead) continue;
      for (let r = 0; r < 4; r++) {
        const need = t.need(r);
        if (need <= 0) continue;
        // how much can we spare (don't drain our own driver survivor)
        const spareGuard = r === Resource.SURVIVORS ? 1 : 0;
        const spare = this.count[r] - this.reserve[r] - spareGuard;
        if (spare <= 0) continue;
        const amount = Math.min(spare, need, loadSize(r));
        if (amount <= 0) continue;
        const weight = amount * (r === Resource.SURVIVORS ? Option.truckLoad : 1);
        if (!best || weight > best.weight) best = { dest: t, res: r, amount, weight };
      }
    }
    if (best) {
      this.game.spawnTruck(this, best.dest, best.res, best.amount);
      return true;
    }
    return false;
  }

  step() {}
  destroy() {
    this.dead = true;
    const c = this.game.map.get(this.pos.x, this.pos.y);
    if (c && c.tower === this) c.tower = null;
    this.game.onTowerDestroyed(this);
  }
}

// --- Depot / HQ ------------------------------------------------------------
export class Depot extends Tower {
  constructor(game, x, y, isHQ = false) {
    super(game, x, y, isHQ ? TowerType.HQ : TowerType.DEPOT);
    this.isHQ = isHQ;
    // The HQ is a larger hub than a field depot so it can hold a starting
    // population and act as the colony's main warehouse.
    this.capacity = isHQ ? [80, 80, 40, 16] : Option.depotMaxInit.slice();
    this.speed = Option.depotSpeed[0];
    this.maxIntegrity = this.integrity = isHQ ? 8 : 5;
    // depots want a minimum stock so trucks keep topping them up
    this.addReserve(Resource.BOARDS, Option.truckLoad);
    this.addReserve(Resource.AMMO, Option.truckLoad);
    this.addReserve(Resource.SURVIVORS, 1);
    revealCircle(game.map, x, y, Option.supplyRange + 2);
  }
  step() {
    this.emitNoise(Option.towerNoise);
    if (this.waitCounter > 0) { this.waitCounter--; return; }
    this.waitCounter = this.speed;
    if (!this.dispatchSupply()) this.balanceDepots();
  }
  // Overflow balancing: ship surplus to a linked depot that has less.
  balanceDepots() {
    if (this.count[Resource.SURVIVORS] < 2) return;
    for (const dest of this.links) {
      const t = this.game.towerAt(dest.x, dest.y);
      if (!t || t.dead || !(t instanceof Depot)) continue;
      for (let r = 0; r < 4; r++) {
        const surplus = this.count[r] - this.reserve[r] - (r === Resource.SURVIVORS ? 1 : 0);
        if (surplus >= loadSize(r) && t.count[r] < this.count[r] - loadSize(r)) {
          this.game.spawnTruck(this, t, r, loadSize(r));
          return;
        }
      }
    }
  }
}

// --- Workshop: scavenges the building/rubble it stands on -----------------
export class Workshop extends Tower {
  constructor(game, x, y) {
    super(game, x, y, TowerType.WORKSHOP);
    this.capacity = Option.workshopMaxInit.slice();
    this.speed = Option.workshopSpeed[0];
    this.maxIntegrity = this.integrity = 3;
    this.addReserve(Resource.SURVIVORS, 1);
  }
  step() {
    this.emitNoise(Option.towerNoise);
    // ship anything we've gathered back to a depot
    if (this.waitCounter > 0) { this.waitCounter--; return; }
    this.waitCounter = this.speed;

    if (this.count[Resource.SURVIVORS] < 1) {
      this.shipToDepot(); // still try to deliver leftovers
      return;
    }
    const cell = this.game.map.get(this.pos.x, this.pos.y);
    if (cell && cell.salvage > 0 && cell.salvageProfile) {
      const res = rollSalvage(cell.salvageProfile, rand);
      cell.salvage--;
      if (cell.building) cell.building.harvested++;
      if (res === Resource.SURVIVORS) {
        this.give(Resource.SURVIVORS, 1);
      } else {
        this.give(res, 1);
      }
      this.game.onScavenge(this);
    } else {
      // building exhausted -> turn to rubble & close shop
      if (cell) { cell.rubble = true; }
      if (this.totalCount() <= this.reserve[Resource.SURVIVORS]) {
        this.shipToDepot(true);
        this.game.closeTower(this);
        return;
      }
    }
    this.shipToDepot();
  }
  shipToDepot(force = false) {
    if (this.count[Resource.SURVIVORS] < 1) return;
    for (const dest of this.links) {
      const t = this.game.towerAt(dest.x, dest.y);
      if (!t || t.dead) continue;
      // The operating survivor drives a full load of goods back to the depot;
      // the depot then sends a fresh survivor, creating a steady shuttle.
      for (const r of [Resource.AMMO, Resource.BOARDS, Resource.FOOD]) {
        if (this.count[r] >= loadSize(r) || (force && this.count[r] > 0)) {
          this.game.spawnTruck(this, t, r, this.count[r]);
          return;
        }
      }
      // surplus survivors (beyond the operator) head back to grow the colony
      if (this.count[Resource.SURVIVORS] > 1) {
        this.game.spawnTruck(this, t, Resource.SURVIVORS, this.count[Resource.SURVIVORS] - 1);
        return;
      }
    }
  }
}

// --- Sniper: shoots zombies within range ----------------------------------
export class Sniper extends Tower {
  constructor(game, x, y) {
    super(game, x, y, TowerType.SNIPER);
    this.capacity = Option.sniperMaxInit.slice();
    this.speed = Option.sniperSpeed[0];
    this.maxIntegrity = this.integrity = 3;
    this.range = Option.sniperRange[0];
    this.addReserve(Resource.AMMO, Option.truckLoad);
    this.addReserve(Resource.SURVIVORS, 1);
    this.addReserve(Resource.BOARDS, Option.truckLoad * Option.sniperBuildCost);
    this.angle = rand(360);
    this.cooldown = 0;
    revealCircle(game.map, x, y, this.range + 1);
  }
  canShoot() {
    return this.count[Resource.AMMO] >= Option.shootCost &&
      this.count[Resource.SURVIVORS] >= 1;
  }
  accuracy(zombie) {
    let acc = Option.sniperAccuracy[this.level];
    const surv = this.count[Resource.SURVIVORS];
    if (surv === 0) return 0;
    acc += (surv - 1) * Option.survivorBonus;
    if (this.count[Resource.FOOD] >= Option.foodShootCost) acc += Option.foodBonus;
    if (zombie && zombie.attacking) acc += Option.vulnerableBonus;
    return Math.min(100, acc);
  }
  findTarget() {
    let best = null, bestD = 1e9;
    for (const z of this.game.zombies) {
      if (z.dead) continue;
      const d = Point.dist(this.pos, z.cell);
      if (d <= this.range && d < bestD) { best = z; bestD = d; }
    }
    return best;
  }
  step() {
    this.emitNoise(Option.towerNoise);
    if (this.cooldown > 0) { this.cooldown--; }
    const target = this.findTarget();
    if (target) {
      this.angle = angleBetween(this.pos, target.cell);
      if (this.cooldown <= 0 && this.canShoot()) {
        this.shoot(target);
        this.cooldown = 6; // fire interval (frames)
      }
    }
  }
  shoot(zombie) {
    this.take(Resource.AMMO, Option.shootCost);
    if (this.count[Resource.FOOD] >= Option.foodShootCost) this.take(Resource.FOOD, Option.foodShootCost);
    this.emitNoise(Option.shootNoise);
    this.game.onSniperShot(this, zombie);
    if (rand(Option.accuracyMax) < this.accuracy(zombie)) {
      zombie.kill(this.pos);
    }
  }
}

// --- Barricade: blocks zombies; consumes boards when bashed ---------------
export class Barricade extends Tower {
  constructor(game, x, y) {
    super(game, x, y, TowerType.BARRICADE);
    this.capacity = Option.barricadeMaxInit.slice();
    this.speed = Option.barricadeSpeed[0];
    this.addReserve(Resource.BOARDS, Option.truckLoad);
  }
  // called by a zombie attack; returns true if destroyed
  bash() {
    if (this.count[Resource.BOARDS] >= Option.barricadeHitCost) {
      this.take(Resource.BOARDS, Option.barricadeHitCost);
      this.game.onBarricadeBash(this);
      return false;
    }
    this.destroy();
    return true;
  }
  step() {
    // barricades don't dispatch; they just hold the line.
  }
}

export function makeTower(game, type, x, y) {
  switch (type) {
    case TowerType.DEPOT: return new Depot(game, x, y, false);
    case TowerType.HQ: return new Depot(game, x, y, true);
    case TowerType.SNIPER: return new Sniper(game, x, y);
    case TowerType.BARRICADE: return new Barricade(game, x, y);
    case TowerType.WORKSHOP: return new Workshop(game, x, y);
  }
  return null;
}
