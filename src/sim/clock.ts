/**
 * PILLAR 2 — The Simulation Clock (brief §4).
 *
 * One authoritative sim-time, independent of framerate, with pause and
 * time-compression built in. Everything time-based (crop growth, wages, market,
 * contracts, agents) reads from this clock — never from wall-clock or frame count.
 *
 * Critically it supports QUEUED FUTURE ACTIONS (e.g. "dispatch 4 trucks on Oct 7"),
 * which the contract/scheduling mechanic (brief §6) depends on.
 *
 * This is a minimal stub for the data spike — enough to establish the shape.
 * It is deterministic and I/O-free so it stays unit-testable.
 */

/** Sim time measured in whole minutes since campaign start. */
export type SimTime = number;

interface QueuedAction {
  at: SimTime;
  run: () => void;
}

export class SimClock {
  private now: SimTime = 0;
  private paused = true;
  /** Sim-minutes advanced per real second when running. */
  private compression = 60;
  private queue: QueuedAction[] = [];

  time(): SimTime {
    return this.now;
  }

  /** Restore sim-time from a save. Does NOT fire queued actions in between. */
  setTime(t: SimTime): void {
    this.now = t;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setCompression(simMinutesPerRealSecond: number): void {
    this.compression = simMinutesPerRealSecond;
  }

  pause(): void {
    this.paused = true;
  }

  play(): void {
    this.paused = false;
  }

  /** Schedule an action to fire once sim-time reaches `at`. */
  schedule(at: SimTime, run: () => void): void {
    this.queue.push({ at, run });
    this.queue.sort((a, b) => a.at - b.at);
  }

  /**
   * Advance the sim by real elapsed seconds. Fires any queued actions whose time
   * has arrived, in order. Call from the render loop; math is framerate-independent.
   */
  advance(realSeconds: number): void {
    if (this.paused) return;
    this.now += realSeconds * this.compression;
    while (this.queue.length && this.queue[0]!.at <= this.now) {
      this.queue.shift()!.run();
    }
  }
}
