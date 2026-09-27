// The seeded generator both the fuzz and simulation suites draw from. A fixed
// seed has to yield the same stream here as anywhere else, or a seed printed by
// a failing run replays a different run, which is the one thing it is for.

/** mulberry32: small, and a fixed seed always yields the same stream. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
