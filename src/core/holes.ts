import type { AffineTransform, Point, RGBImage } from './types';
import { LayerKind } from './types';
import { applyAffine, fitAffine, identityAffine } from './geometry';
import { labelComponents, type ComponentsResult } from './regions';
import { createImage, createLabelRaster, luma, sampleBilinear } from './raster';

export interface PegHole {
  centroid: Point;
  radius: number;
  area: number;
}

export interface RegistrationResult {
  holes: PegHole[];
  /** 把当前扫描件坐标映射到标准参考坐标的仿射变换；找不到孔时为单位变换 */
  transform: AffineTransform;
  holeLabel: { width: number; height: number; labels: Uint8Array };
  score: number;
}

export interface HoleDetectionOptions {
  /** 降采样倍率（A4 @150dpi 约 1240x1754，2 倍降采样仍有足够精度） */
  downsample: number;
  /** 暗像素亮度阈值 */
  darkLuma: number;
  /** 合格定位孔的圆度下限 = 4πA / P² 的近似替代：面积/外接方框面积 */
  minFillRatio: number;
  maxFillRatio: number;
  /** 孔面积占整图比例的允许区间（按降采样后分辨率） */
  minAreaRatio: number;
  maxAreaRatio: number;
}

export const DEFAULT_HOLE_OPTIONS: HoleDetectionOptions = {
  downsample: 2,
  darkLuma: 100,
  minFillRatio: 0.55,
  maxFillRatio: 1.05,
  minAreaRatio: 0.0002,
  maxAreaRatio: 0.02,
};

/**
 * 检测动画纸底部定位孔（标准三孔条 pegbar）。
 * 定位孔在扫描图上是深色近圆块，用降采样 + 连通块几何筛选，避免与墨线混淆。
 */
export function detectPegHoles(image: RGBImage, options: HoleDetectionOptions = DEFAULT_HOLE_OPTIONS): PegHole[] {
  const ds = options.downsample;
  const sw = Math.ceil(image.width / ds);
  const sh = Math.ceil(image.height / ds);
  const dark = new Uint8Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) {
    for (let sx = 0; sx < sw; sx++) {
      const x = Math.min(image.width - 1, sx * ds);
      const y = Math.min(image.height - 1, sy * ds);
      const o = (y * image.width + x) * 4;
      dark[sy * sw + sx] = luma(image.data[o], image.data[o + 1], image.data[o + 2]) < options.darkLuma ? 1 : 0;
    }
  }

  const comp = labelComponents(dark, sw, sh, (v) => v !== 0);
  const total = sw * sh;
  const candidates: PegHole[] = [];
  for (let id = 1; id <= comp.count; id++) {
    const area = comp.areas[id];
    const ratio = area / total;
    if (ratio < options.minAreaRatio || ratio > options.maxAreaRatio) continue;
    const box = componentBox(comp, id, sw);
    const boxArea = Math.max(1, box.w * box.h);
    const fill = area / boxArea;
    if (fill < options.minFillRatio || fill > options.maxFillRatio) continue;
    // 圆度：近圆块 fill ratio 约 π/4 ≈ 0.785，长条墨线远低于此
    const c = comp.centroids[id];
    const radius = Math.sqrt(area / Math.PI) * ds;
    candidates.push({
      centroid: { x: c.x * ds, y: c.y * ds },
      radius,
      area: area * ds * ds,
    });
  }

  // 标准三孔：取最靠近底部、x 间距近似均匀的三个近圆点
  candidates.sort((a, b) => b.centroid.y - a.centroid.y);
  const bottom = candidates.slice(0, Math.min(8, candidates.length));
  return chooseThreePegs(bottom);
}

function componentBox(comp: ComponentsResult, id: number, w: number): { x: number; y: number; w: number; h: number } {
  let minX = w;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  const ids = comp.ids;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== id) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 从候选点中选出最接近"等间距水平三孔"的组合 */
function chooseThreePegs(candidates: PegHole[]): PegHole[] {
  if (candidates.length < 3) return candidates;
  let best: PegHole[] = candidates.slice(0, 3);
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        const trio = [candidates[i], candidates[j], candidates[k]].sort((a, b) => a.centroid.x - b.centroid.x);
        const ySpread = Math.max(...trio.map((t) => t.centroid.y)) - Math.min(...trio.map((t) => t.centroid.y));
        const d1 = trio[1].centroid.x - trio[0].centroid.x;
        const d2 = trio[2].centroid.x - trio[1].centroid.x;
        const gapPenalty = Math.abs(d1 - d2) / Math.max(1, (d1 + d2) / 2);
        const rVar =
          (Math.abs(trio[0].radius - trio[1].radius) + Math.abs(trio[1].radius - trio[2].radius)) /
          Math.max(1, trio.reduce((s, t) => s + t.radius, 0) / 3);
        const score = ySpread + gapPenalty * 50 + rVar * 30;
        if (score < bestScore) {
          bestScore = score;
          best = trio;
        }
      }
    }
  }
  return best;
}

/**
 * 以参考帧的三孔位置为基准做仿射配准。
 * 所有扫描纸对齐到同一坐标系，后续帧间差异与色块追踪才有意义。
 */
export function estimateRegistration(image: RGBImage, referenceHoles?: PegHole[]): RegistrationResult {
  const holes = detectPegHoles(image);
  const holeLabel = createLabelRaster(image.width, image.height);
  for (const hole of holes) {
    const r = Math.round(hole.radius);
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r) continue;
        const px = Math.round(hole.centroid.x) + x;
        const py = Math.round(hole.centroid.y) + y;
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
        holeLabel.labels[py * image.width + px] = LayerKind.PegHole;
      }
    }
  }

  if (!referenceHoles || holes.length < 3 || referenceHoles.length < 3) {
    return { holes, transform: identityAffine(), holeLabel, score: holes.length >= 3 ? 1 : 0 };
  }
  const src = [...holes].sort((a, b) => a.centroid.x - b.centroid.x).map((h) => h.centroid);
  const dst = [...referenceHoles].sort((a, b) => a.centroid.x - b.centroid.x).map((h) => h.centroid);
  const n = Math.min(src.length, dst.length);
  const transform = fitAffine(src.slice(0, n), dst.slice(0, n));
  // 配准分数 = 配准后孔心残差（像素），越小越好，归一到 0..1
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const p = applyAffine(transform, src[i]);
    residual += Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
  }
  residual /= n;
  return { holes, transform, holeLabel, score: Math.max(0, 1 - residual / 10) };
}

/** 用仿射变换把图像重采样到对齐坐标系（双线性） */
export function warpImage(image: RGBImage, transform: AffineTransform): RGBImage {
  const out = createImage(image.width, image.height);
  const inv = invertAffine(transform);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const src = applyAffine(inv, { x, y });
      const [r, g, b] = sampleBilinear(image, src.x, src.y);
      const o = (y * image.width + x) * 4;
      out.data[o] = r;
      out.data[o + 1] = g;
      out.data[o + 2] = b;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 仿射矩阵求逆（3x3 齐次形式） */
export function invertAffine(t: AffineTransform): AffineTransform {
  const det = t.a * t.d - t.b * t.c;
  if (Math.abs(det) < 1e-12) return identityAffine();
  const invDet = 1 / det;
  const a = t.d * invDet;
  const b = -t.b * invDet;
  const c = -t.c * invDet;
  const d = t.a * invDet;
  const e = (t.c * t.f - t.d * t.e) * invDet;
  const f = (t.b * t.e - t.a * t.f) * invDet;
  return { a, b, c, d, e, f };
}
