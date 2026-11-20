/** 可种子化的确定性随机数（mulberry32），保证测试图可复现 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  pick<T>(items: T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  gaussian(): number {
    // Box-Muller
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}
