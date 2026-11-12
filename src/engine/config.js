export class MatchError extends Error {
  constructor(status, message, code = 'match_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const FACTIONS = {
  A: { id: 'A', name: '赤焰', color: '#ff6363' },
  B: { id: 'B', name: '苍蓝', color: '#58a6ff' },
  C: { id: 'C', name: '金戈', color: '#ffc857' }
};

export const ROLES = {
  vanguard: {
    id: 'vanguard',
    name: '突击手',
    short: '突',
    captureWeight: 1,
    canCapture: true,
    description: '标准占领权重 1'
  },
  engineer: {
    id: 'engineer',
    name: '工兵',
    short: '工',
    captureWeight: 1.5,
    canCapture: true,
    description: '占领权重 1.5，推进更快'
  },
  support: {
    id: 'support',
    name: '支援',
    short: '支',
    captureWeight: 0,
    canCapture: false,
    description: '可以争夺但无占领资格'
  }
};

export const DEFAULT_CONFIG = {
  map: { width: 900, height: 900, margin: 28 },
  point: { x: 450, y: 450, radius: 112 },
  spawns: {
    A: { x: 140, y: 140 },
    B: { x: 760, y: 760 },
    C: { x: 760, y: 140 }
  },
  captureRate: 20,
  decayRate: 8,
  recoverRate: 6,
  contestedFactor: 0.6,
  captureBonus: 25,
  holdPointsPerSec: 3,
  scoreIntervalMs: 1000,
  scoreToWin: 200,
  durationMs: 5 * 60 * 1000,
  keyframeIntervalMs: 500,
  maxStepMs: 500,
  respawnMs: 12000,
  moveSpeed: 120,
  suppressedMoveFactor: 0.45,
  fire: {
    range: 230,
    damage: 22,
    cooldownMs: 1200,
    suppressMs: 2500
  },
  hpMax: 100,
  maxPlayersPerFaction: 6,
  maxPlayersTotal: 18,
  playerRadius: 13,
  obstacles: [
    { x: 250, y: 218, w: 96, h: 44 },
    { x: 554, y: 218, w: 96, h: 44 },
    { x: 250, y: 638, w: 96, h: 44 },
    { x: 554, y: 638, w: 96, h: 44 },
    { x: 620, y: 428, w: 36, h: 96 },
    { x: 244, y: 428, w: 36, h: 96 }
  ]
};

export function resolveConfig(overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    map: { ...DEFAULT_CONFIG.map, ...(overrides.map || {}) },
    point: { ...DEFAULT_CONFIG.point, ...(overrides.point || {}) },
    spawns: { ...DEFAULT_CONFIG.spawns, ...(overrides.spawns || {}) },
    fire: { ...DEFAULT_CONFIG.fire, ...(overrides.fire || {}) }
  };
  return config;
}
