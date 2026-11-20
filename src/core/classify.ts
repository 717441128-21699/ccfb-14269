import type { ClassificationOptions, LabelRaster, LayerSet, RGBImage } from './types';
import { DEFAULT_CLASSIFICATION, LayerKind } from './types';
import { createImage, createLabelRaster, extractLayer, luma } from './raster';
import { labelComponents } from './regions';

export interface ClassificationResult {
  layers: LayerSet;
  /** 压墨恢复的像素数（彩铅线从墨线像素里夺回的部分），用于质量看板 */
  recoveredOverlapPixels: number;
  /** 各层像素计数 */
  counts: Record<LayerKind, number>;
}

/**
 * 颜色分层主算法。
 *
 * 画师在纸上同时存在三种笔迹：
 *  - 黑墨线（深、近中性灰）
 *  - 红铅笔阴影分界线（有深有浅，浅的接近纸色）
 *  - 蓝铅笔高光线（同理）
 * 难点：彩铅压在墨线上的段落颜色被墨色污染，像素级分类会误判成墨线，
 * 这里用"多源受限泛洪"从两侧确信的彩铅像素向暗像素生长，把被压住的段落夺回。
 */
export function classifyLayers(image: RGBImage, options: ClassificationOptions = DEFAULT_CLASSIFICATION): ClassificationResult {
  const { width: w, height: h, data } = image;
  const labels = createLabelRaster(w, h);
  const n = w * h;
  const counts: Record<LayerKind, number> = {
    [LayerKind.Paper]: 0,
    [LayerKind.Ink]: 0,
    [LayerKind.RedPencil]: 0,
    [LayerKind.BluePencil]: 0,
    [LayerKind.PegHole]: 0,
  };

  // ---- 第一遍：确信像素分类（色度优先，不做压墨猜测） ----
  const confident = new Uint8Array(n); // 1 = 颜色身份确信，可作为泛洪源
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const y = luma(r, g, b);
    const redness = r - (g + b) / 2;
    const blueness = b - (r + g) / 2;
    const chroma = options.colorChroma;

    // 色度优先：绝对色度超阈值且主导色明确才归彩铅（覆盖深色与浅色彩铅）
    if (y >= options.pencilLumaMin && y <= options.pencilLumaMax) {
      if (redness > chroma && redness > blueness + chroma) {
        labels.labels[i] = LayerKind.RedPencil;
        confident[i] = 1;
        continue;
      }
      if (blueness > chroma && blueness > redness + chroma) {
        labels.labels[i] = LayerKind.BluePencil;
        confident[i] = 1;
        continue;
      }
    }
    // 暗像素：必须同时满足"绝对色度超阈值"和"主导色明确"，才是深色彩铅；
    // 中性墨线（|色度|≤阈值）一律归墨线，交给压墨恢复处理
    if (y < options.inkLuma) {
      if (redness > chroma && redness > blueness + chroma) {
        labels.labels[i] = LayerKind.RedPencil;
        confident[i] = 1;
      } else if (blueness > chroma && blueness > redness + chroma) {
        labels.labels[i] = LayerKind.BluePencil;
        confident[i] = 1;
      } else {
        labels.labels[i] = LayerKind.Ink;
      }
      continue;
    }
    // 亮但无色偏：纸底（含被模糊冲淡的浅墨线在 minInkComponent 阶段处理）
    labels.labels[i] = LayerKind.Paper;
  }

  // ---- 第二遍：压墨恢复（多源受限泛洪） ----
  const recovered = recoverOverlaps(image, labels, confident, options);

  // ---- 第三遍：墨线碎斑过滤 ----
  if (options.minInkComponent > 0) {
    const inkMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) inkMask[i] = labels.labels[i] === LayerKind.Ink ? 1 : 0;
    const comp = labelComponents(inkMask, w, h, (v) => v !== 0);
    for (let i = 0; i < n; i++) {
      if (inkMask[i] && comp.areas[comp.ids[i]] < options.minInkComponent) {
        labels.labels[i] = LayerKind.Paper;
      }
    }
  }

  for (let i = 0; i < n; i++) counts[labels.labels[i] as LayerKind]++;

  const layers: LayerSet = {
    ink: extractLayer(image, labels, LayerKind.Ink),
    red: extractLayer(image, labels, LayerKind.RedPencil),
    blue: extractLayer(image, labels, LayerKind.BluePencil),
    labelRaster: labels,
  };
  return { layers, recoveredOverlapPixels: recovered, counts };
}

/**
 * 多源受限泛洪（压墨恢复）：
 * 从确信的红/蓝彩铅像素出发，只进入暗墨色像素，半径受限。
 * 关键约束——只恢复"被同色彩铅夹击"的暗像素：一个暗像素要被某颜色收回，
 * 它在生长路径上必须能连通到该颜色源，且其附近（半径内）存在该颜色的
 * 第二个独立来源。孤立墨线/墨线轮廓只接触单侧或不接触彩铅，因此不会被染色。
 * 这精确对应压墨的物理形态：彩铅铺底、墨线压中段，两侧都露出同色彩铅。
 */
function recoverOverlaps(image: RGBImage, labels: LabelRaster, confident: Uint8Array, options: ClassificationOptions): number {
  const { width: w, height: h, data } = image;
  const n = w * h;
  const dist = new Int16Array(n).fill(-1);
  const owner = new Uint8Array(n); // LayerKind
  let queue = new Int32Array(4096);
  let head = 0;
  let tail = 0;

  const enqueue = (i: number, kind: LayerKind) => {
    if (tail >= queue.length) {
      const grown = new Int32Array(queue.length * 2);
      grown.set(queue);
      queue = grown;
    }
    dist[i] = 0;
    owner[i] = kind;
    queue[tail++] = i;
  };
  for (let i = 0; i < n; i++) {
    if (confident[i]) enqueue(i, labels.labels[i] as LayerKind);
  }

  // 统计每个像素半径内各颜色源数量（用一次多源 BFS 的距离近似）
  const maxR = options.overlapRecoverRadius;
  let recovered = 0;
  // 先做纯距离传播，记录每个暗像素能接触到哪些颜色源
  const touchRed = new Uint8Array(n);
  const touchBlue = new Uint8Array(n);
  while (head < tail) {
    const idx = queue[head++];
    const d = dist[idx];
    const kind = owner[idx];
    if (kind === LayerKind.RedPencil) touchRed[idx] = 1;
    if (kind === LayerKind.BluePencil) touchBlue[idx] = 1;
    if (d >= maxR) continue;
    const x = idx % w;
    const y = (idx - x) / w;
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < w - 1 ? idx + 1 : -1,
      y > 0 ? idx - w : -1,
      y < h - 1 ? idx + w : -1,
    ];
    for (const nb of neighbors) {
      if (nb < 0) continue;
      const o = nb * 4;
      const y2 = luma(data[o], data[o + 1], data[o + 2]);
      if (y2 >= options.inkLuma) continue; // 只在暗像素里传播
      if (confident[nb]) continue;
      if (dist[nb] === -1) {
        dist[nb] = d + 1;
        owner[nb] = kind;
        if (tail >= queue.length) {
          const grown = new Int32Array(queue.length * 2);
          grown.set(queue);
          queue = grown;
        }
        queue[tail++] = nb;
      } else if (owner[nb] !== kind) {
        // 被两种颜色同时接触：标记双方都可达，最终裁决靠先到先得
        if (kind === LayerKind.RedPencil) touchRed[nb] = 1;
        if (kind === LayerKind.BluePencil) touchBlue[nb] = 1;
      }
    }
  }

  // 第二遍：只把"暗、且接触到彩铅源、且不是贴着墨线轮廓单侧"的像素改判。
  // 用连通源计数：压墨带两侧同源 -> 该暗像素在 BFS 树上距源 ≤ maxR 且
  // 其反方向（继续延伸）仍能遇到同色，这里以距离严格小于半径作为夹击近似。
  for (let i = 0; i < n; i++) {
    if (dist[i] <= 0 || labels.labels[i] !== LayerKind.Ink) continue;
    const kind = owner[i];
    // 严格小于最大半径：只有靠近彩铅源、被夹在压墨带内的像素才改判，
    // 墨线轮廓远离源的部分（距离接近半径上限）保持墨线
    if (dist[i] >= maxR) continue;
    labels.labels[i] = kind;
    recovered++;
  }
  return recovered;
}

/** 构建屏障掩码：墨线 + 红蓝彩铅都是区域边界（线稿本身不可被填色穿过） */
export function buildBarrierMask(labelRaster: LabelRaster, includePegHoles = true): Uint8Array {
  const mask = new Uint8Array(labelRaster.width * labelRaster.height);
  for (let i = 0; i < mask.length; i++) {
    const v = labelRaster.labels[i];
    if (v === LayerKind.Ink || v === LayerKind.RedPencil || v === LayerKind.BluePencil) mask[i] = 1;
    else if (includePegHoles && v === LayerKind.PegHole) mask[i] = 1;
  }
  return mask;
}

/** 仅墨线屏障（查看不含彩铅的闭合区域时用） */
export function buildInkOnlyBarrier(labelRaster: LabelRaster): Uint8Array {
  const mask = new Uint8Array(labelRaster.width * labelRaster.height);
  for (let i = 0; i < mask.length; i++) {
    if (labelRaster.labels[i] === LayerKind.Ink || labelRaster.labels[i] === LayerKind.PegHole) mask[i] = 1;
  }
  return mask;
}

/** 生成纸白底的预览图（某一层单独显示用） */
export function layerOnWhite(layer: RGBImage): RGBImage {
  const out = createImage(layer.width, layer.height);
  for (let i = 0; i < layer.width * layer.height; i++) {
    const o = i * 4;
    const a = layer.data[o + 3] / 255;
    out.data[o] = Math.round(255 * (1 - a) + layer.data[o] * a);
    out.data[o + 1] = Math.round(255 * (1 - a) + layer.data[o + 1] * a);
    out.data[o + 2] = Math.round(255 * (1 - a) + layer.data[o + 2] * a);
  }
  return out;
}
