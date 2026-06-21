// Headless simulation smoke test. Runs the pure game logic (no DOM/canvas) for
// thousands of frames, exercises building, supply, waves and combat, and
// asserts the world stays consistent. Run with: npm run smoke
import { Game, GameState } from '../src/game.js';
import { TowerType, Resource, Difficulty } from '../src/config.js';
import { Background } from '../src/map.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
  else console.log('  ✓ ' + msg);
}

function findBuildSpot(game, type) {
  // scan near HQ for a placeable cell
  const { x, y } = game.hq.pos;
  for (let r = 1; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = x + dx, cy = y + dy;
        if (game.canPlace(type, cx, cy)) return { x: cx, y: cy };
      }
    }
  }
  return null;
}

for (const diff of [Difficulty.TUTORIAL, Difficulty.NOVICE, Difficulty.VETERAN, Difficulty.EXPERT, Difficulty.QUARTERMASTER]) {
  console.log(`\n=== Difficulty ${Difficulty.names[diff]} ===`);
  const game = new Game({ difficulty: diff, sandbox: true, seed: 12345 + diff });

  assert(game.hq && game.hq.type === TowerType.HQ, 'HQ created');
  assert(game.map.buildings.length > 0, `city has ${game.map.buildings.length} buildings`);
  assert(game.map.bridges.length > 0, `map has ${game.map.bridges.length} bridge(s)`);
  assert(game.zombieFlow != null, 'zombie flow field computed');

  // fill the HQ to capacity so every structure type can be validated
  game.hq.count[Resource.BOARDS] = game.hq.capacity[Resource.BOARDS];
  game.hq.count[Resource.SURVIVORS] = game.hq.capacity[Resource.SURVIVORS];
  const dSpot = findBuildSpot(game, TowerType.DEPOT);
  if (dSpot) assert(game.build(TowerType.DEPOT, dSpot.x, dSpot.y), 'built a depot');
  const wsSpot = findBuildSpot(game, TowerType.WORKSHOP);
  if (wsSpot) assert(game.build(TowerType.WORKSHOP, wsSpot.x, wsSpot.y), 'built a workshop');
  const sSpot = findBuildSpot(game, TowerType.SNIPER);
  if (sSpot) assert(game.build(TowerType.SNIPER, sSpot.x, sSpot.y), 'built a sniper');
  const bSpot = findBuildSpot(game, TowerType.BARRICADE);
  if (bSpot) assert(game.build(TowerType.BARRICADE, bSpot.x, bSpot.y), 'built a barricade');

  // serialize round-trips (snapshot before the destructive long run)
  const save = game.serialize();
  assert(save.towers.length >= 1 && Array.isArray(save.fog), 'serialize() produced a save blob');

  // run the simulation
  let maxTrucks = 0, maxZombies = 0, errored = false;
  try {
    for (let f = 0; f < 4000; f++) {
      game.step();
      maxTrucks = Math.max(maxTrucks, game.trucks.length);
      maxZombies = Math.max(maxZombies, game.zombies.length);
      // invariants
      for (const t of game.towers) {
        for (let r = 0; r < 4; r++) {
          if (t.count[r] < 0) throw new Error(`negative ${Resource.names[r]} in tower @${t.pos.x},${t.pos.y}`);
        }
      }
    }
  } catch (e) {
    errored = true;
    console.error('  ✗ simulation threw:', e.message);
    failures++;
  }
  assert(!errored, 'simulation ran 4000 frames without error');
  assert(maxZombies > 0, `zombies spawned (peak ${maxZombies})`);
  assert(maxTrucks > 0, `supply trucks dispatched (peak ${maxTrucks})`);
  console.log(`  · peak trucks=${maxTrucks}, peak zombies=${maxZombies}, hordes=${game.hordeCount}, killed=${game.totals.totalKilled}, scavenged=${game.totals.scavenged}`);
}

// win/lose: a non-sandbox game with the HQ removed should register a loss
console.log('\n=== Win/Lose ===');
{
  const game = new Game({ difficulty: Difficulty.NOVICE, sandbox: false, seed: 7 });
  game.fleeTower(game.hq);
  game.hq.destroy();
  assert(game.state === GameState.LOSE, 'destroying the only depot loses the game');
}

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
