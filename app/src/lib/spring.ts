// Numbers that glide to where they're told, and can be told somewhere else on the way: they go on
// from where they are, at the speed they have. Nothing else about what they stand for.

const STIFFNESS = 40; // per second: about 150 ms to get there
const LONGEST = 1 / 20; // s: one step at most (after a stall, it goes on rather than jumps)

/** A critically damped spring, `dt` seconds on: its new value and velocity. (Exact, at any `dt`.) */
export function step(value: number, velocity: number, target: number, dt: number): [number, number] {
  const a = value - target;
  const b = velocity + STIFFNESS * a;
  const fade = Math.exp(-STIFFNESS * dt);
  return [target + (a + b * dt) * fade, (b - STIFFNESS * (a + b * dt)) * fade];
}

/** Named numbers gliding together. `rest`: how near each counts as there. */
export class Springs<K extends string> {
  readonly values: Record<K, number>;
  private velocities = {} as Record<K, number>;
  private targets: Record<K, number>;
  private keys: K[];
  private rest: Record<K, number>;

  constructor(values: Record<K, number>, rest: Record<K, number>) {
    this.values = { ...values };
    this.targets = { ...values };
    this.rest = rest;
    this.keys = Object.keys(values) as K[];
    for (const k of this.keys) this.velocities[k] = 0;
  }

  /** Where to go now. */
  set(targets: Partial<Record<K, number>>) {
    Object.assign(this.targets, targets);
  }

  tick(seconds: number) {
    const dt = Math.min(seconds, LONGEST);
    for (const k of this.keys) [this.values[k], this.velocities[k]] = step(this.values[k], this.velocities[k], this.targets[k], dt);
    if (this.settled) this.jump();
  }

  /** There at once. */
  jump() {
    for (const k of this.keys) {
      this.values[k] = this.targets[k];
      this.velocities[k] = 0;
    }
  }

  get settled() {
    return this.keys.every((k) => Math.abs(this.values[k] - this.targets[k]) < this.rest[k] && Math.abs(this.velocities[k]) < this.rest[k] * STIFFNESS);
  }
}
