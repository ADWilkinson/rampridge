import type { Tile } from "@shared/protocol";
import type { PathGoal } from "./pathfinding";

/**
 * Re-planning while walking to something that moves (following a player,
 * trading with a merchant or a stall). Every route the local player picks is
 * a move the server fans out to the whole room, so a chaser plans towards
 * where the target's route ends rather than the tile it is crossing: one
 * route per destination of the target, not one per step it takes. A new
 * route goes out only when that destination changes, at most every
 * REPLAN_MS, and only when the chaser's current route no longer ends next
 * to it.
 */

export const REPLAN_MS = 1_200;

export class Chase {
  /** Destination tile ("x,y") of the target that the current route was checked against. */
  private plannedFor = "";
  /** performance.now() of the last route sent; -Infinity before the first. */
  plannedAt = -Infinity;

  /**
   * True when a new route towards `goal` (next to `destination`, the end of
   * the target's route) should be planned now. The first call always plans;
   * later calls plan only when the destination has changed, REPLAN_MS have
   * passed since the last route, and the chaser's route, ending on
   * `routeEnd`, does not already reach the goal.
   */
  shouldPlan(perfNow: number, destination: Tile, goal: PathGoal, routeEnd: Tile): boolean {
    const key = `${destination.x},${destination.y}`;
    if (this.plannedAt === -Infinity) {
      this.plannedFor = key;
      this.plannedAt = perfNow;
      return true;
    }
    if (key === this.plannedFor || perfNow - this.plannedAt < REPLAN_MS) return false;
    this.plannedFor = key;
    if (goal.reached(routeEnd.x, routeEnd.y)) return false;
    this.plannedAt = perfNow;
    return true;
  }
}
