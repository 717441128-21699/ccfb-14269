import type { Point, RegionMap } from './types';
import { BARRIER } from './types';

export interface ComponentsResult {
  /** 0 = 背景，1..count 为连通块编号 */
  ids: Int32Array;
  count: number;
  areas: number[];
  seeds: Point[];
  /** 质心（用游程端点累加，避免逐像素对象分配） */
  centroids: Point[];
}

/**
 * 通用连通块标注（4 连通，游程编码 + 并查集，两遍扫描）。
 * 相对显式栈泛洪，这一实现：
 *  - 不为每个像素分配队列/对象，内存只与游程数相关；
 *  - 扫描噪声产生的单像素碎块在并查集阶段自然合并，不会产生百万级区域数组；
 *  - 复杂度 O(n·α(n))，适合 A4 尺寸（两百万像素以上）。
 */
export function labelComponents(
  mask: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  isForeground: (v: number) => boolean = (v) => v !== 0,
): ComponentsResult {
  const ids = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== x) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const newLabel = (): number => {
    const label = parent.length;
    parent.push(label);
    return label;
  };

  // 第一遍：逐行游程编码，游程内赋同一标签，与上一行重叠游程合并
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!isForeground(mask[row + x])) {
        x++;
        continue;
      }
      const xStart = x;
      while (x < w && isForeground(mask[row + x])) x++;
      const xEnd = x; // 游程 [xStart, xEnd)
      let label = 0;
      if (y > 0) {
        const prevRow = row - w;
        for (let px = xStart; px < xEnd; px++) {
          const up = ids[prevRow + px];
          if (up !== 0) {
            if (label === 0) label = find(up);
            else union(label, up);
          }
        }
      }
      if (label === 0) label = newLabel();
      for (let px = xStart; px < xEnd; px++) ids[row + px] = label;
    }
  }

  // 第二遍：收敛并查集，把临时标签压成连续编号
  const remap = new Map<number, number>();
  const areas: number[] = [0];
  const seeds: Point[] = [{ x: 0, y: 0 }];
  const sumX: number[] = [0];
  const sumY: number[] = [0];
  let count = 0;
  for (let i = 0; i < ids.length; i++) {
    const raw = ids[i];
    if (raw === 0) continue;
    const root = find(raw);
    let finalId = remap.get(root);
    if (finalId === undefined) {
      finalId = ++count;
      remap.set(root, finalId);
      areas.push(0);
      seeds.push({ x: i % w, y: (i - (i % w)) / w });
      sumX.push(0);
      sumY.push(0);
    }
    ids[i] = finalId;
    areas[finalId]++;
    const px = i % w;
    sumX[finalId] += px;
    sumY[finalId] += (i - px) / w;
  }
  const centroids: Point[] = [{ x: 0, y: 0 }];
  for (let id = 1; id <= count; id++) {
    centroids.push({ x: sumX[id] / areas[id], y: sumY[id] / areas[id] });
  }
  return { ids, count, areas, seeds, centroids };
}

/** 掩码膨胀（方形结构元，半径 radius 像素） */
export function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) out[row + xx] = 1;
      }
    }
  }
  return out;
}

/** 掩码腐蚀（与 dilate 互逆，用于闭运算） */
export function erode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      let allSet = true;
      for (let oy = -radius; oy <= radius && allSet; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const xx = x + ox;
          const yy = y + oy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (!mask[yy * w + xx]) {
            allSet = false;
            break;
          }
        }
      }
      if (allSet) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * 由屏障掩码构建区域图：屏障像素 id=0，其余按 4 连通标注闭合区域。
 * closeRadius>0 时先做形态学闭运算（膨胀→腐蚀）封闭线条接缝，
 * 避免扫描断笔/动作错位让本应独立的区域漏连。
 * minArea 以下的碎块（扫描噪声小洞）并入屏障，不输出为可填区域。
 */
export function buildRegionMap(
  barrier: Uint8Array,
  w: number,
  h: number,
  minArea = 32,
  closeRadius = 1,
): RegionMap {
  let closed = barrier;
  if (closeRadius > 0) {
    closed = erode(dilate(barrier, w, h, closeRadius), w, h, closeRadius);
  }
  const fillable = new Uint8Array(w * h);
  for (let i = 0; i < closed.length; i++) fillable[i] = closed[i] ? 0 : 1;
  const comp = labelComponents(fillable, w, h, (v) => v !== 0);
  const keep = new Uint8Array(comp.count + 1);
  for (let id = 1; id <= comp.count; id++) keep[id] = comp.areas[id] >= minArea ? 1 : 0;
  // 压缩编号：被丢弃的碎块 id 归 0
  const remap = new Int32Array(comp.count + 1);
  const areas = [0];
  const seeds: Point[] = [{ x: 0, y: 0 }];
  let count = 0;
  for (let id = 1; id <= comp.count; id++) {
    if (!keep[id]) continue;
    remap[id] = ++count;
    areas.push(comp.areas[id]);
    seeds.push(comp.seeds[id]);
  }
  const ids = new Int32Array(w * h);
  for (let i = 0; i < comp.ids.length; i++) {
    const raw = comp.ids[i];
    if (raw !== 0 && keep[raw]) ids[i] = remap[raw];
  }
  return { width: w, height: h, ids, areas, seeds };
}

/** 扫描线泛洪：返回种子点所在可填充区域的全部像素（点击填色用，天然防漏到屏障外） */
export function floodFillPixels(barrier: Uint8Array, w: number, h: number, seedX: number, seedY: number): number[] {
  const start = seedY * w + seedX;
  if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h || barrier[start]) return [];
  const visited = new Uint8Array(w * h);
  const pixels: number[] = [];
  let stack = new Int32Array(1024);
  let sp = 0;
  const push = (idx: number) => {
    if (sp >= stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[sp++] = idx;
  };
  push(start);
  visited[start] = 1;
  while (sp > 0) {
    const idx = stack[--sp];
    pixels.push(idx);
    const x = idx % w;
    const y = (idx - x) / w;
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < w - 1 ? idx + 1 : -1,
      y > 0 ? idx - w : -1,
      y < h - 1 ? idx + w : -1,
    ];
    for (const n of neighbors) {
      if (n >= 0 && !visited[n] && !barrier[n]) {
        visited[n] = 1;
        push(n);
      }
    }
  }
  return pixels;
}

/** 取某个区域 id 的二值掩码 */
export function regionMask(regionMap: RegionMap, regionId: number): Uint8Array {
  const mask = new Uint8Array(regionMap.width * regionMap.height);
  const ids = regionMap.ids;
  for (let i = 0; i < ids.length; i++) if (ids[i] === regionId) mask[i] = 1;
  return mask;
}

/** 把掩码覆盖到 RGBA 图上（半透明预览/正式填色共用） */
export function paintMask(image: { data: Uint8Array }, mask: Uint8Array, rgba: { r: number; g: number; b: number; a: number }): void {
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const a = rgba.a / 255;
    image.data[o] = Math.round(image.data[o] * (1 - a) + rgba.r * a);
    image.data[o + 1] = Math.round(image.data[o + 1] * (1 - a) + rgba.g * a);
    image.data[o + 2] = Math.round(image.data[o + 2] * (1 - a) + rgba.b * a);
    image.data[o + 3] = 255;
  }
}

export { BARRIER };
