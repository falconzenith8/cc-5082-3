import { distanceSquared } from './util.js';

export function isInsidePoint(entity, point) {
  return distanceSquared(entity.x, entity.y, point.x, point.y) <= point.radius * point.radius;
}

export class PresenceTracker {
  constructor(point) {
    this.point = point;
    this.records = new Map();
  }

  sync(entities, nowMs) {
    const entered = [];
    const exited = [];
    const inside = new Set();

    for (const entity of entities.values()) {
      // 阵亡角色不参与据点争夺，也不会保留在场记录。
      if (entity.alive !== true) continue;
      if (!isInsidePoint(entity, this.point)) continue;
      inside.add(entity.id);
      const existing = this.records.get(entity.id);
      if (!existing) {
        this.records.set(entity.id, {
          entityId: entity.id,
          slot: entity.slot,
          generation: entity.generation,
          faction: entity.faction,
          role: entity.role,
          name: entity.name,
          enteredAtMs: nowMs
        });
        entered.push(entity);
      } else if (existing.generation !== entity.generation || existing.faction !== entity.faction) {
        // 身份复用或阵营切换：旧参与记录作废，按新身份重新登记。
        this.records.delete(entity.id);
        exited.push(existing);
        this.records.set(entity.id, {
          entityId: entity.id,
          slot: entity.slot,
          generation: entity.generation,
          faction: entity.faction,
          role: entity.role,
          name: entity.name,
          enteredAtMs: nowMs
        });
        entered.push(entity);
      }
    }

    for (const [entityId, record] of this.records) {
      if (!inside.has(entityId)) {
        this.records.delete(entityId);
        exited.push(record);
      }
    }

    return { entered, exited };
  }

  release(entityId) {
    const record = this.records.get(entityId);
    if (!record) return null;
    this.records.delete(entityId);
    return record;
  }

  has(entityId) {
    return this.records.has(entityId);
  }

  list() {
    return [...this.records.values()];
  }

  get size() {
    return this.records.size;
  }
}
