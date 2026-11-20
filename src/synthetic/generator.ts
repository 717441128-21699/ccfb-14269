import type { LabelRaster, RGBImage } from '../core/types';
import { LayerKind } from '../core/types';
import { createImage, createLabelRaster, drawLine, bresenham, fillPolygon, type RGB } from '../core/raster';
import { Rng, hashSeed } from './rng';
import type { Archetype } from './archetypes';

/** 扫描噪声模型：模拟真实动画纸扫描的各类退化 */
export interface NoiseModel {
  /** 纸底不均匀幅度（0-30） */
  paperGrain: number;
  /** 高斯模糊半径（0 = 关闭，1 = 轻） */
  blurRadius: number;
  /** 墨线随机断点比例 0-1 */
  dropout: number;
  /** 线条位置抖动（像素） */
  jitter: number;
  /** 传感器加性噪声标准差 */
  sensorNoise: number;
  /** 椒盐噪声密度 */
  saltPepper: number;
  /** 光照倾斜（0-1，制造一侧偏暗） */
  illuminationTilt: number;
  /** 彩铅压墨：分界线与墨线相交处的墨色污染段长度（像素），0 = 不制造压墨 */
  inkOverlap: number;
}

export const CLEAN: NoiseModel = {
  paperGrain: 0,
  blurRadius: 0,
  dropout: 0,
  jitter: 0,
  sensorNoise: 0,
  saltPepper: 0,
  illuminationTilt: 0,
  inkOverlap: 0,
};

export const LIGHT_SCAN_NOISE: NoiseModel = {
  paperGrain: 6,
  blurRadius: 1,
  dropout: 0.02,
  jitter: 0.6,
  sensorNoise: 5,
  saltPepper: 0.0008,
  illuminationTilt: 0.15,
  inkOverlap: 4,
};

export const HEAVY_SCAN_NOISE: NoiseModel = {
  paperGrain: 14,
  blurRadius: 1,
  dropout: 0.06,
  jitter: 1.4,
  sensorNoise: 10,
  saltPepper: 0.002,
  illuminationTilt: 0.3,
  inkOverlap: 6,
};

export interface GeneratedFrame {
  image: RGBImage;
  /** 像素级分层真值 */
  truthLabels: LabelRaster;
  /** 像素级语义区域真值（0 = 线条/纸底） */
  semantic: Int32Array;
  noise: NoiseModel;
}

const INK_DARK: RGB = [38, 36, 34];
const INK_LIGHT: RGB = [96, 92, 88]; // 扫描后偏浅的墨线
const RED_DEEP: RGB = [196, 78, 84];
const RED_PALE: RGB = [232, 158, 158]; // 浅红铅
const BLUE_DEEP: RGB = [74, 104, 196];
const BLUE_PALE: RGB = [150, 172, 226]; // 浅蓝铅
const PEG: RGB = [30, 30, 30];

/**
 * 渲染一帧合成扫描图。
 * 流程：纸底 → 语义区域色块（浅灰，模拟待上色线稿；同时写 semantic 真值）
 *      → 墨线轮廓/五官 → 红蓝铅分界线（可制造压墨）→ 定位孔 → 扫描噪声。
 */
export function renderFrame(
  archetype: Archetype,
  width: number,
  height: number,
  frameT: number,
  noise: NoiseModel,
  seed: number,
  pegHoles: Array<{ x: number; y: number; r: number }>,
): GeneratedFrame {
  const rng = new Rng(hashSeed(seed, archetype.id, Math.round(frameT * 1000)));
  const image = createImage(width, height, [252, 250, 246]);
  const truth = createLabelRaster(width, height, LayerKind.Paper);
  const semantic = new Int32Array(width * height);

  // 1. 语义区域：填极浅灰底色 + 写真值（先填区域，后画线，保证线在区域之上）
  const semanticRaster: LabelRaster = { width, height, labels: new Uint8Array(width * height) };
  for (const region of archetype.regions) {
    const poly = region.poly(frameT);
    fillPolygon(semanticRaster, poly, region.id);
    fillPolygon(image, poly, [238, 236, 232]);
  }
  for (let i = 0; i < semanticRaster.labels.length; i++) {
    semantic[i] = semanticRaster.labels[i];
  }

  // 2. 先画红蓝彩铅分界线（图像 + 真值一起写）；墨线稍后画，交叉处由墨线覆盖
  const strokePencil = (x0: number, y0: number, x1: number, y1: number, color: RGB, kind: LayerKind, thickness: number) => {
    const pts = bresenham(x0, y0, x1, y1);
    const half = Math.floor(thickness / 2);
    for (const [x, y] of pts) {
      for (let oy = -half; oy <= half; oy++) {
        for (let ox = -half; ox <= half; ox++) {
          const xx = x + ox;
          const yy = y + oy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const idx = yy * width + xx;
          const o = idx * 4;
          image.data[o] = color[0];
          image.data[o + 1] = color[1];
          image.data[o + 2] = color[2];
          image.data[o + 3] = 255;
          truth.labels[idx] = kind;
        }
      }
    }
  };

  // 记录压墨小节，等墨线阶段统一覆盖
  const overlapStrokes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const divider of archetype.dividers) {
    const a = divider.from(frameT);
    const b = divider.to(frameT);
    const kind = divider.kind === 'red' ? LayerKind.RedPencil : LayerKind.BluePencil;
    const deep = divider.kind === 'red' ? RED_DEEP : BLUE_DEEP;
    const pale = divider.kind === 'red' ? RED_PALE : BLUE_PALE;
    const segments = splitInThree(a.x, a.y, b.x, b.y);
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      const color = rng.next() < 0.45 ? pale : deep;
      strokePencil(seg.x0, seg.y0, seg.x1, seg.y1, color, kind, archetype.pencilThickness + 2);
      if (s === 1 && noise.inkOverlap > 0) {
        const mx = (seg.x0 + seg.x1) / 2;
        const my = (seg.y0 + seg.y1) / 2;
        const dx = seg.x1 - seg.x0;
        const dy = seg.y1 - seg.y0;
        const len = Math.hypot(dx, dy) || 1;
        const half = noise.inkOverlap / 2;
        const ox = (dx / len) * half;
        const oy = (dy / len) * half;
        overlapStrokes.push({ x0: mx - ox, y0: my - oy, x1: mx + ox, y1: my + oy });
      }
    }
  }

  // 3. 墨线：区域轮廓 + 五官/接缝线；无条件覆盖图像与真值，墨线优先级最高
  const stroke = (x0: number, y0: number, x1: number, y1: number, kind: LayerKind, color: RGB, thickness: number) => {
    const jx = rng.gaussian() * noise.jitter;
    const jy = rng.gaussian() * noise.jitter;
    if (kind !== LayerKind.PegHole && rng.next() < noise.dropout) return;
    const X0 = Math.round(x0 + jx);
    const Y0 = Math.round(y0 + jy);
    const X1 = Math.round(x1 + jx);
    const Y1 = Math.round(y1 + jy);
    drawLine(image, X0, Y0, X1, Y1, color, thickness);
    drawLine(truth, X0, Y0, X1, Y1, kind, thickness);
  };

  for (const region of archetype.regions) {
    const poly = region.poly(frameT);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const c = rng.next() < 0.25 ? INK_LIGHT : INK_DARK; // 墨线有深有浅
      stroke(a.x, a.y, b.x, b.y, LayerKind.Ink, c, archetype.inkThickness);
    }
  }
  for (const line of archetype.inkLines) {
    const a = line.from(frameT);
    const b = line.to(frameT);
    stroke(a.x, a.y, b.x, b.y, LayerKind.Ink, INK_DARK, Math.max(1, archetype.inkThickness - 1));
  }
  // 压墨小节：墨线覆盖图像（真值保持彩铅身份，供恢复算法评估）
  for (const ov of overlapStrokes) {
    drawLine(image, ov.x0, ov.y0, ov.x1, ov.y1, INK_DARK, archetype.pencilThickness);
  }

  // 4. 定位孔
  for (const hole of pegHoles) {
    fillCircleLocal(image, hole.x, hole.y, hole.r, PEG);
    fillCircleLabel(truth, hole.x, hole.y, hole.r, LayerKind.PegHole);
  }

  // 5. 扫描退化
  applyScanNoise(image, noise, rng);

  return { image, truthLabels: truth, semantic, noise };
}

function splitInThree(x0: number, y0: number, x1: number, y1: number) {
  const ax = x0 + (x1 - x0) / 3;
  const ay = y0 + (y1 - y0) / 3;
  const bx = x0 + ((x1 - x0) * 2) / 3;
  const by = y0 + ((y1 - y0) * 2) / 3;
  return [
    { x0, y0, x1: ax, y1: ay },
    { x0: ax, y0: ay, x1: bx, y1: by },
    { x0: bx, y0: by, x1, y1 },
  ];
}

function fillCircleLocal(img: RGBImage, cx: number, cy: number, r: number, c: RGB): void {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue;
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
}

function fillCircleLabel(lab: LabelRaster, cx: number, cy: number, r: number, v: LayerKind): void {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue;
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= lab.width || py >= lab.height) continue;
      lab.labels[py * lab.width + px] = v;
    }
  }
}

/** 应用扫描噪声（顺序：模糊 → 纸纹/光照 → 传感器噪声 → 椒盐） */
export function applyScanNoise(img: RGBImage, noise: NoiseModel, rng: Rng): void {
  if (noise.blurRadius > 0) boxBlur(img, noise.blurRadius);

  const { width: w, height: h, data } = img;
  for (let y = 0; y < h; y++) {
    const tilt = 1 - (y / h) * noise.illuminationTilt;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const grain = (rng.next() - 0.5) * noise.paperGrain;
      const sensor = rng.gaussian() * noise.sensorNoise;
      for (let k = 0; k < 3; k++) {
        let v = data[i + k] * tilt + grain + sensor;
        data[i + k] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }

  const total = w * h;
  const specks = Math.floor(total * noise.saltPepper);
  for (let s = 0; s < specks; s++) {
    const idx = rng.int(0, total - 1);
    const o = idx * 4;
    const dark = rng.next() < 0.5;
    const v = dark ? rng.int(0, 60) : rng.int(220, 255);
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
  }
}

/**
 * 轻量软化：模拟扫描仪的轻微失焦。
 * 不做等权盒式平均（那会把细彩铅线的色度往纸底色严重拉偏），
 * 而是原像素占主导（权重 win²-1）、邻域只贡献 1 份，既柔化锯齿又保留颜色身份。
 */
function boxBlur(img: RGBImage, radius: number): void {
  const { width: w, height: h, data } = img;
  const src = new Uint8Array(data);
  const win = radius * 2 + 1;
  const selfWeight = win * win - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let sr = src[o] * selfWeight;
      let sg = src[o + 1] * selfWeight;
      let sb = src[o + 2] * selfWeight;
      for (let oy = -radius; oy <= radius; oy++) {
        const yy = Math.min(h - 1, Math.max(0, y + oy));
        for (let ox = -radius; ox <= radius; ox++) {
          if (ox === 0 && oy === 0) continue;
          const xx = Math.min(w - 1, Math.max(0, x + ox));
          const i = (yy * w + xx) * 4;
          sr += src[i];
          sg += src[i + 1];
          sb += src[i + 2];
        }
      }
      const denom = win * win + selfWeight - 1;
      data[o] = sr / denom;
      data[o + 1] = sg / denom;
      data[o + 2] = sb / denom;
    }
  }
}

/** 标准三定位孔（底部 pegbar），合成帧统一坐标 */
export function standardPegHoles(width: number, height: number) {
  const y = height - 70;
  const gap = 110;
  return [
    { x: width / 2 - gap, y, r: 16 },
    { x: width / 2, y, r: 16 },
    { x: width / 2 + gap, y, r: 16 },
  ];
}
