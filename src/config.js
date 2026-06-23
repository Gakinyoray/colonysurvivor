// Balance constants, ported from the original Shattered Colony `Option.as`.
// Values kept verbatim where they affect gameplay so the recreation feels faithful.
export const Option = {
  fps: 20,
  cellPixels: 32,
  halfCell: 16,
  tileCells: 3,

  // Resources -----------------------------------------------------------
  resourceCount: 4,
  truckLoad: 10,            // units carried per truck / per "load"
  startingResources: 30,    // starting boards/ammo/survivors in the HQ

  // Supply / network ----------------------------------------------------
  supplyRange: 7,           // a structure must be within this of a depot
  hqInfluence: 11,

  // Build costs (in "loads"; multiply by truckLoad for unit cost) -------
  // [unused, boards, survivors]
  depotCost: [0, 3, 3],
  sniperCost: [0, 1, 1],
  barricadeCost: [0, 1, 1],
  workshopCost: [0, 1, 0],
  sniperBuildCost: 2,       // extra board loads kept in a sniper

  // Tower capacities / upgrades [ammo, boards, food, survivors] ---------
  depotMaxInit: [40, 40, 30, 4],
  depotMaxUpgrade: [30, 30, 10, 3],
  sniperMaxInit: [15, 0, 0, 1],
  sniperMaxUpgrade: [5, 0, 0, 0],
  barricadeMaxInit: [0, 15, 0, 0],
  barricadeMaxUpgrade: [0, 10, 0, 0],
  workshopMaxInit: [10, 10, 10, 2],

  // Tower speeds (frames between actions) -------------------------------
  depotSpeed: [150, 150, 150],
  sniperSpeed: [150, 150, 150],
  barricadeSpeed: [50, 50, 50],
  workshopSpeed: [40, 40, 80],     // 4*truckLoad ...
  workshopSpeedFactor: 50,
  hqSpeed: [200, 200, 200],

  // Sniper --------------------------------------------------------------
  sniperRange: [4, 6, 9],
  sniperAccuracy: [30, 30, 30],
  sniperLevelLimit: 2,
  shootCost: 1,             // ammo per shot
  shootNoise: 10,
  survivorBonus: 7,         // accuracy per extra survivor in tower
  foodBonus: 24,
  foodShootCost: 2,
  vulnerableBonus: 49,      // bonus accuracy vs. attacking zombie
  accuracyMax: 100,
  sniperIdleMin: 50,
  sniperIdleRange: 500,

  // Barricade -----------------------------------------------------------
  barricadeHitCost: 1,      // boards consumed per zombie bash

  // Noise (zombie attraction radius) ------------------------------------
  towerNoise: 3,
  buildNoise: 4,
  truckNoise: 2,

  // Trucks --------------------------------------------------------------
  truckSpeedMin: 300,
  truckSpeedRange: 100,
  truckRetries: 3,
  survivorDeathFrameCount: 50,
  foodTransportCost: 2,

  // Zombies -------------------------------------------------------------
  // base speed (frames per cell) by difficulty: tutorial..quartermaster
  zombieSpeed: [80, 80, 104, 135, 175],
  zombieSpeedRange: 50,
  zombieMultiplier: [1, 1, 2, 2, 3],
  spawnFrameCount: 50,
  wanderingZombieBase: 10,
  wanderingZombieIncrement: 2,

  // Map sizes by difficulty --------------------------------------------
  sizeList: [46, 46, 56, 66, 76],
  bridgeCount: [1, 1, 2, 3, 4],

  // City generation -----------------------------------------------------
  // building type weights (index -> see buildings.js TYPES)
  buildingDistribution: [70, 8, 0, 4, 4, 0, 4, 0, 0, 2],
  fastFrames: 5,
};

export const Difficulty = {
  TUTORIAL: 0,
  NOVICE: 1,
  VETERAN: 2,
  EXPERT: 3,
  QUARTERMASTER: 4,
  names: ['Tutorial', 'Novice', 'Veteran', 'Expert', 'Quartermaster'],
};

// Resource enum (matches original index ordering) ----------------------
export const Resource = {
  AMMO: 0,
  BOARDS: 1,
  FOOD: 2,
  SURVIVORS: 3,
  names: ['Ammo', 'Boards', 'Food', 'Survivors'],
  // bar colours pulled from Option.as (0xRRGGBB)
  colors: ['#ccccccs', '#874a1f', '#0000cc', '#33cc33'],
};
// fix ammo colour string typo above
Resource.colors = ['#cccccc', '#874a1f', '#0000cc', '#33cc33'];

export const TowerType = {
  BARRICADE: 0,
  SNIPER: 1,
  DEPOT: 2,
  WORKSHOP: 3,
  HQ: 4, // recreation: HQ is a special depot
};

// Build-menu actions that aren't towers.
export const DEMOLISH = 5;          // set charges on a bridge to drop it

// Bridge demolition: cost paid from a supplying depot, plus a fuse delay.
export const CHARGE_BOARDS = 10;
export const CHARGE_SURVIVORS = 1;
export const CHARGE_FUSE = Option.fps * 6;  // frames until the bridge collapses
