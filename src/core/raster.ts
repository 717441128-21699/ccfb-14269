import type { LabelRaster, RGBImage } from './types';
import { LayerKind } from './types';
import { clamp } from './geometry';

export function createImage(width: number, height: number, fill: RGB = [255, 255, 255]): RGBImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

export type RGB = [number, number, number];

export function getPixel(img: RGBImage, x: number, y: number): RGB {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

export function setPixel(img: RGBImage, x: number, y: number, c: RGB, alpha = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
  img.data[i + 3] = alpha;
}

/** 整数坐标画圆（填充），带裁剪 */
export function fillCircle(img: RGBImage, cx: number, cy: number, r: number, c: RGB): void {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setPixel(img, x, y, c);
    }
  }
}

/** Bresenham 线段；value 对图像为 RGB 三元组，对标签栅格为 LayerKind 数字 */
export function drawLine(
  target: RGBImage | LabelRaster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: RGB | number,
  thickness = 1,
): void {
  const isLabel = 'labels' in target;
  const pts = bresenham(x0, y0, x1, y1);
  const half = Math.floor(thickness / 2);
  for (const [x, y] of pts) {
    for (let oy = -half; oy <= half; oy++) {
      for (let ox = -half; ox <= half; ox++) {
        const xx = x + ox;
        const yy = y + oy;
        if (xx < 0 || yy < 0 || xx >= target.width || yy >= target.height) continue;
        if (isLabel) {
          target.labels[yy * target.width + xx] = value as number;
        } else {
          setPixel(target, xx, yy, value as RGB);
        }
      }
    }
  }
}

export function bresenham(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  // 统一取整：调用方可能传浮点坐标，图像与标签栅格必须落在同一组像素上
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const out: Array<[number, number]> = [];
  // 零长度线段直接返回单点，避免误差项为 0 时步进条件永不满足导致死循环
  if (x0 === x1 && y0 === y1) {
    out.push([x0, y0]);
    return out;
  }
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  // 步数上限：网格上两点间的步数不会超过 |dx|+|dy|+1，超出即说明退化，强制退出
  const maxSteps = dx + Math.abs(dy) + 2;
  for (let step = 0; step < maxSteps; step++) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** 多边形栅格化（边表扫描线，O(边数 + 像素数)）；label 模式写标签，图像模式写颜色 */
export function fillPolygon(
  target: RGBImage | LabelRaster,
  poly: Array<{ x: number; y: number }>,
  value: RGB | number,
): void {
  const isLabel = 'labels' in target;
  const w = target.width;
  const h = target.height;
  if (poly.length < 3) return;

  // 构建边表：忽略水平边，每条非水平边按上端 y 入桶
  interface Edge {
    yMax: number;
    x: number; // 当前扫描线与边交点（x）
    slope: number; // dx/dy
  }
  const buckets: Edge[][] = new Array(h);
  const yMinGlobal = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.y))));
  const yMaxGlobal = Math.min(h - 1, Math.ceil(Math.max(...poly.map((p) => p.y))));
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y === b.y) continue;
    const [lo, hi] = a.y < b.y ? [a, b] : [b, a];
    const y0 = Math.max(0, Math.floor(lo.y));
    const edge: Edge = {
      yMax: Math.min(h, Math.ceil(hi.y)),
      x: lo.x + (y0 + 0.5 - lo.y) * ((hi.x - lo.x) / (hi.y - lo.y)),
      slope: (hi.x - lo.x) / (hi.y - lo.y),
    };
    (buckets[y0] ??= []).push(edge);
  }

  // 活化边表扫描
  let active: Edge[] = [];
  for (let y = yMinGlobal; y <= yMaxGlobal; y++) {
    if (buckets[y]) {
      for (const e of buckets[y]) active.push(e);
    }
    // 边覆盖扫描行 y 的条件是 y < yMax；到期的边直接淘汰（不会再入桶）
    active = active.filter((e) => e.yMax > y);
    if (active.length >= 2) {
      active.sort((p, q) => p.x - q.x);
      for (let k = 0; k + 1 < active.length; k += 2) {
        const x0 = Math.max(0, Math.ceil(active[k].x - 0.5));
        const x1 = Math.min(w - 1, Math.floor(active[k + 1].x - 0.5));
        for (let x = x0; x <= x1; x++) {
          if (isLabel) target.labels[y * w + x] = value as number;
          else setPixel(target, x, y, value as RGB);
        }
      }
    }
    // 无论是否成对，所有存活边都推进到下一条扫描线
    for (const e of active) e.x += e.slope;
  }
}

export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 双线性采样，越界返回纸白 */
export function sampleBilinear(img: RGBImage, x: number, y: number): RGB {
  const w = img.width;
  const h = img.height;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return [255, 255, 255];
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const out: RGB = [0, 0, 0];
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let k = 0; k < 3; k++) {
    const top = img.data[i00 + k] * (1 - tx) + img.data[i10 + k] * tx;
    const bot = img.data[i01 + k] * (1 - tx) + img.data[i11 + k] * tx;
    out[k] = clamp(Math.round(top * (1 - ty) + bot * ty), 0, 255);
  }
  return out;
}

export function createLabelRaster(width: number, height: number, fill = LayerKind.Paper): LabelRaster {
  return { width, height, labels: new Uint8Array(width * height).fill(fill) };
}

/** 把某一标签层提取成透明底 RGBA 图（保留原始颜色，便于查看与导出） */
export function extractLayer(source: RGBImage, labels: LabelRaster, kind: LayerKind): RGBImage {
  const out = createImage(source.width, source.height, [0, 0, 0]);
  out.data.fill(0);
  for (let i = 0; i < labels.labels.length; i++) {
    if (labels.labels[i] !== kind) continue;
    const o = i * 4;
    out.data[o] = source.data[o];
    out.data[o + 1] = source.data[o + 1];
    out.data[o + 2] = source.data[o + 2];
    out.data[o + 3] = 255;
  }
  return out;
}

/** 复制 RGBA 图 */
export function cloneImage(img: RGBImage): RGBImage {
  return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
}
