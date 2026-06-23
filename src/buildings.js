// Building catalogue. Each building type carries a salvage profile telling the
// workshop what resources it yields, mirroring the original `salvageDistribution`
// table ([ammo, boards, food, survivors] weights) and `buildingDistribution`.
import { Resource } from './config.js';

// Resource weight order: [AMMO, BOARDS, FOOD, SURVIVORS]
export const BUILDING_TYPES = [
  { id: 0, name: 'House',          color: '#6b6f57', mini: '#8a8f70', salvage: [50, 28, 0, 16],  size: [2, 2] },
  { id: 1, name: 'Apartment',      color: '#7a6f5a', mini: '#9a8f78', salvage: [2, 2, 0, 94],    size: [3, 3] },
  { id: 2, name: 'Generic',        color: '#67675f', mini: '#86867c', salvage: [2, 2, 0, 2],     size: [3, 2] },
  { id: 3, name: 'Police Station', color: '#3b4a6b', mini: '#52679a', salvage: [94, 2, 0, 2],    size: [3, 2] },
  { id: 4, name: 'Hardware Store', color: '#6b5333', mini: '#9a7a4a', salvage: [2, 94, 0, 2],    size: [3, 2] },
  { id: 5, name: 'Hospital',       color: '#7a3b3b', mini: '#b85252', salvage: [2, 2, 0, 94],    size: [3, 3] },
  { id: 6, name: 'Mall',           color: '#4a5a4a', mini: '#6a8a6a', salvage: [60, 33, 0, 1],   size: [4, 3] },
  { id: 7, name: 'Office',         color: '#55606b', mini: '#76849a', salvage: [50, 28, 0, 16],  size: [3, 3] },
  { id: 8, name: 'Plant',          color: '#5a5340', mini: '#7a7050', salvage: [60, 40, 0, 10],  size: [4, 3] },
  { id: 9, name: 'Church',         color: '#6b6450', mini: '#9a9070', salvage: [1, 1, 0, 1],     size: [2, 3] },
];

export function buildingName(typeId) {
  return BUILDING_TYPES[typeId]?.name ?? 'Building';
}

// Choose a resource yield from a salvage weight profile.
export function rollSalvage(profile, randFn) {
  let total = profile[0] + profile[1] + profile[2] + profile[3];
  if (total <= 0) return null;
  let r = randFn(total);
  for (let i = 0; i < 4; i++) {
    r -= profile[i];
    if (r < 0) return i; // returns a Resource index
  }
  return Resource.SURVIVORS;
}
