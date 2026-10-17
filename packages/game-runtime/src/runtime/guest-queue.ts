// Pure play-session motion logic, engine-free so it is testable headless. A guest walks its
// waypoint list in world space at the authored speed; arrival is acknowledged inside
// arrivalRadius; the list loops when `loop` is authored, otherwise the guest stops at the
// last waypoint. Waypoint positions are resolved by the play session before stepping starts
// (authored waypoint entity world positions at play start).

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface GuestQueueDefinition {
  /** World-space waypoint positions in walk order. */
  readonly waypoints: readonly Vec3Like[];
  /** Authored waypoint entity ids, parallel to `waypoints` (used for arrival events). */
  readonly waypointIds: readonly string[];
  /** Meters per second. Non-finite or <= 0 means the guest does not move. */
  readonly speed: number;
  /** Distance at which a waypoint counts as reached. */
  readonly arrivalRadius: number;
  /** After the last waypoint, restart at the first instead of stopping. */
  readonly loop: boolean;
}

export interface GuestMoverState {
  position: Vec3Like;
  /** Index of the waypoint currently being walked to. */
  waypointIndex: number;
  /** Set once a non-looping guest reaches the end of its list. */
  finished: boolean;
}

export type GuestStepEvent =
  | { type: 'arrival'; waypointIndex: number }
  | { type: 'path-complete' };

export function createGuestMover(definition: GuestQueueDefinition, start: Vec3Like): GuestMoverState {
  return {
    position: { x: start.x, y: start.y, z: start.z },
    waypointIndex: 0,
    finished: definition.waypoints.length === 0,
  };
}

/**
 * Advances a guest by `dt` seconds, appending arrival/path-complete events to `events`.
 * Returns nothing; mutate the returned state position (the session writes it to the entity).
 * Over-speed steps snap arrivals exactly onto the waypoint so positions never drift.
 */
export function stepGuestMover(
  state: GuestMoverState,
  definition: GuestQueueDefinition,
  dt: number,
  events: GuestStepEvent[],
): void {
  const { waypoints, speed, arrivalRadius, loop } = definition;
  if (state.finished || waypoints.length === 0 || !(speed > 0) || !(dt > 0) || !Number.isFinite(dt)) return;

  let budget = speed * dt;
  let stationaryArrivals = 0;
  while (budget > 0) {
    const target = waypoints[state.waypointIndex]!;
    const dx = target.x - state.position.x;
    const dy = target.y - state.position.y;
    const dz = target.z - state.position.z;
    const remaining = Math.hypot(dx, dy, dz);

    if (remaining <= arrivalRadius + 1e-8) {
      if (++stationaryArrivals > waypoints.length) return;
      events.push({ type: 'arrival', waypointIndex: state.waypointIndex });
      const nextIndex = state.waypointIndex + 1;
      if (nextIndex >= waypoints.length) {
        if (loop) {
          state.waypointIndex = 0;
        } else {
          state.finished = true;
          events.push({ type: 'path-complete' });
          return;
        }
      } else {
        state.waypointIndex = nextIndex;
      }
      continue;
    }

    stationaryArrivals = 0;
    const stepSize = Math.min(budget, remaining - arrivalRadius);
    const ratio = stepSize / remaining;
    state.position.x += dx * ratio;
    state.position.y += dy * ratio;
    state.position.z += dz * ratio;
    budget -= stepSize;

    if (budget <= 0) break;
  }
}

/** Reads a guestQueue component document into the runtime definition, with safe defaults. */
export function guestQueueDefinition(
  properties: {
    waypoints?: unknown;
    speed?: unknown;
    arrivalRadius?: unknown;
    loop?: unknown;
  },
  resolveWaypoint: (entityId: string) => Vec3Like | null,
): GuestQueueDefinition | null {
  const ids = Array.isArray(properties.waypoints) ? properties.waypoints.filter((id): id is string => typeof id === 'string') : [];
  const waypoints: Vec3Like[] = [];
  const waypointIds: string[] = [];
  for (const id of ids) {
    const point = resolveWaypoint(id);
    if (point) {
      waypoints.push(point);
      waypointIds.push(id);
    }
  }
  if (waypoints.length === 0) return null;
  const speed = typeof properties.speed === 'number' && Number.isFinite(properties.speed) ? properties.speed : 1.2;
  const arrivalRadius = typeof properties.arrivalRadius === 'number' && Number.isFinite(properties.arrivalRadius)
    ? Math.max(properties.arrivalRadius, 0.01)
    : 0.15;
  const loop = properties.loop !== false;
  return { waypoints, waypointIds, speed, arrivalRadius, loop };
}
