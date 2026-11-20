import type { AffineTransform, Point } from './types';

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 应用仿射变换 */
export function applyAffine(t: AffineTransform, p: Point): Point {
  return {
    x: t.a * p.x + t.c * p.y + t.e,
    y: t.b * p.x + t.d * p.y + t.f,
  };
}

export function identityAffine(): AffineTransform {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/**
 * 由两组对应点求最小二乘**相似变换**（旋转 + 均匀缩放 + 平移，4 自由度）。
 * 动画定位孔三孔共线，完整 6 自由度仿射会奇异；配准本身也只需要刚性运动。
 * 至少需要 2 个非重合点（三孔时为超定最小二乘，对单个孔的检测误差更鲁棒）。
 */
export function fitAffine(from: Point[], to: Point[]): AffineTransform {
  if (from.length !== to.length || from.length < 2) {
    throw new Error('相似变换至少需要 2 对对应点');
  }
  const n = from.length;
  const cf = centroid(from);
  const ct = centroid(to);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let syx = 0;
  let varFrom = 0;
  for (let i = 0; i < n; i++) {
    const px = from[i].x - cf.x;
    const py = from[i].y - cf.y;
    const qx = to[i].x - ct.x;
    const qy = to[i].y - ct.y;
    sxx += px * qx;
    syy += py * qy;
    sxy += px * qy;
    syx += py * qx;
    varFrom += px * px + py * py;
  }
  if (varFrom < 1e-9) throw new Error('对应点重合，无法估计变换');
  // Kabsch/Umeyama 的二维闭式解
  const a = (sxx + syy) / varFrom; // cosθ * scale
  const b = (sxy - syx) / varFrom; // sinθ * scale
  const cos = a;
  const sin = b;
  const tx = ct.x - (cos * cf.x - sin * cf.y);
  const ty = ct.y - (sin * cf.x + cos * cf.y);
  // 仿射矩阵形式：x' = a*x + c*y + e; y' = b*x + d*y + f
  return { a: cos, b: sin, c: -sin, d: cos, e: tx, f: ty };
}

/** 质心 */
export function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
