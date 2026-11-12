import { ROLES } from './config.js';

export function memberEligibility(entity, nowMs, factionId) {
  const role = ROLES[entity.role] || ROLES.vanguard;
  const alive = entity.alive === true && entity.hp > 0;
  const suppressed = alive && entity.suppressedUntilMs > nowMs;
  const contest = alive ? 1 : 0;
  const capture = alive && !suppressed ? role.captureWeight : 0;

  let status = 'eligible';
  if (!alive) status = 'down';
  else if (suppressed) status = role.captureWeight > 0 ? 'suppressed' : 'suppressed_ineligible';
  else if (role.captureWeight <= 0) status = 'ineligible';

  return {
    entityId: entity.id,
    playerId: entity.playerId,
    slot: entity.slot,
    generation: entity.generation,
    faction: factionId ?? entity.faction,
    role: entity.role,
    roleName: role.name,
    roleShort: role.short,
    name: entity.name,
    alive,
    suppressed,
    contest,
    capture,
    captureWeight: role.captureWeight,
    status
  };
}

export function computePresenceWeights(factionIds, entities, records, nowMs) {
  const summary = {};
  for (const factionId of factionIds) {
    summary[factionId] = { contest: 0, capture: 0, members: [] };
  }

  for (const record of records) {
    const entity = entities.get(record.entityId);
    if (!entity || entity.generation !== record.generation) continue;
    if (!summary[entity.faction]) {
      summary[entity.faction] = { contest: 0, capture: 0, members: [] };
    }
    const row = memberEligibility(entity, nowMs, entity.faction);
    summary[entity.faction].contest += row.contest;
    summary[entity.faction].capture += row.capture;
    summary[entity.faction].members.push(row);
  }

  for (const factionId of Object.keys(summary)) {
    const faction = summary[factionId];
    faction.inside = faction.members.length;
    faction.count = faction.members.length;
    faction.icon = faction.capture > 0;
    faction.contested = faction.contest > 0;
    faction.eligible = faction.capture > 0;
    faction.effectiveCapture = faction.capture;
    faction.eligibleCount = faction.members.filter((member) => member.capture > 0).length;
    faction.suppressedCount = faction.members.filter((member) => member.suppressed).length;
    faction.downCount = faction.members.filter((member) => !member.alive).length;
  }

  const present = Object.keys(summary).filter((id) => summary[id].contest > 0);
  const eligible = Object.keys(summary).filter((id) => summary[id].capture > 0);
  return { factions: summary, present, eligible };
}

export function deriveMomentum(factions, presentIds, eligibleIds, contestedFactor) {
  if (presentIds.length === 0) {
    return { kind: 'empty', direction: null, magnitude: 0, net: 0, reason: '据点内没有存活成员，进度回落' };
  }
  if (eligibleIds.length === 0) {
    return {
      kind: 'pinned',
      direction: null,
      magnitude: 0,
      net: 0,
      reason: '在场成员均被压制或无占领资格，进度回落'
    };
  }
  if (eligibleIds.length >= 2) {
    const totals = eligibleIds
      .map((id) => ({ id, weight: factions[id].capture }))
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    const othersWeight = totals.slice(1).reduce((sum, row) => sum + row.weight, 0);
    // 多方争夺：领跑者需要压过其余所有阵营的资格权重之和，而不是只和单个对手相减。
    const net = totals[0].weight - othersWeight;
    if (net <= 0) {
      return {
        kind: 'deadlock',
        direction: null,
        magnitude: 0,
        net,
        contenders: totals,
        reason: '多方权重互相抵消，无人推进'
      };
    }
    return {
      kind: 'contested',
      direction: totals[0].id,
      magnitude: net * contestedFactor,
      net,
      contenders: totals,
      reason: `多方争夺，${totals[0].id} 阵营净优势 ${net}`
    };
  }
  return {
    kind: 'solo',
    direction: eligibleIds[0],
    magnitude: factions[eligibleIds[0]].capture,
    net: factions[eligibleIds[0]].capture,
    reason: '单方有效占领'
  };
}

export function decayTowardPole(value, pole, decayRate, dtSeconds) {
  const distance = pole - value;
  if (distance === 0) return value;
  const step = decayRate * dtSeconds;
  if (Math.abs(distance) <= step) return pole;
  return value + Math.sign(distance) * step;
}
