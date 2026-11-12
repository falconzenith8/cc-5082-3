export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function distanceSquared(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function rectContainsCircle(px, py, radius, rect) {
  const nearestX = clamp(px, rect.x, rect.x + rect.w);
  const nearestY = clamp(py, rect.y, rect.y + rect.h);
  return Math.hypot(px - nearestX, py - nearestY) < radius;
}
