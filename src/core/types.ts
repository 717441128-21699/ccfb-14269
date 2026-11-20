/**
 * 核心域类型。算法模块不依赖 DOM，所有图像以 RGBA8 打包的 Uint8Array 表示，
 * 便于在 Node 测试与浏览器 WebGL 纹理之间共用同一套实现。
 */

export interface Point {
  x: number;
  y: number;
}

/** 二维仿射变换（含平移），约定点为列向量 p' = A * p + b */
export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface RGBImage {
  width: number;
  height: number;
  /** 长度 = width * height * 4，RGBA 通道顺序 */
  data: Uint8Array;
}

/** 一张扫描动画纸（含定位孔） */
export interface Sheet {
  id: string;
  name: string;
  /** 镜头/卡编号，例如 S001_C012 */
  shotId: string;
  /** 帧号，例如 1、3、5（动画纸常见一拍二） */
  frameNo: number;
  image: RGBImage;
}

/** 分层标签：纸 / 黑墨线 / 红蓝彩铅 / 定位孔 */
export enum LayerKind {
  Paper = 0,
  Ink = 1,
  RedPencil = 2,
  BluePencil = 3,
  PegHole = 4,
}

export const LAYER_NAMES: Record<LayerKind, string> = {
  [LayerKind.Paper]: '纸底',
  [LayerKind.Ink]: '墨线层',
  [LayerKind.RedPencil]: '红铅（阴影分界）',
  [LayerKind.BluePencil]: '蓝铅（高光）',
  [LayerKind.PegHole]: '定位孔',
};

/** 每像素一个标签的栅格（与图像同尺寸） */
export interface LabelRaster {
  width: number;
  height: number;
  labels: Uint8Array;
}

export interface LayerSet {
  ink: RGBImage;
  red: RGBImage;
  blue: RGBImage;
  /** 每像素标签，用于区域分析与 GPU 上传 */
  labelRaster: LabelRaster;
}

/** 区域分析中的屏障像素（不可填充），0 = 屏障 */
export const BARRIER = 0;
export const OUTSIDE = 0;

/** 区域 ID 图：0 表示屏障/外部，正整数为闭合区域编号 */
export interface RegionMap {
  width: number;
  height: number;
  /** 每像素区域编号（0 = 屏障） */
  ids: Int32Array;
  /** 区域 id -> 像素数 */
  areas: number[];
  /** 区域 id -> 代表点（取区域内第一个像素） */
  seeds: Point[];
}

export interface ColorRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 一个可上色区域在某一帧上的实例 */
export interface RegionInstance {
  /** 帧内区域编号 */
  regionId: number;
  /** 跨帧稳定的色块轨道编号（-1 = 尚未匹配） */
  trackId: number;
  area: number;
  seed: Point;
  /** 几何质心 */
  centroid: Point;
  /** 合成测试图上的语义真值（生产数据为 undefined） */
  semanticId?: number;
}

export interface ShadowProposal {
  shadow: RegionMap;
  highlight: RegionMap;
  /** 区域 id -> 'shadow' | 'highlight' | 'base' */
  kind: Map<number, 'shadow' | 'highlight' | 'base'>;
}

/** 分层处理的可调参数 */
export interface ClassificationOptions {
  /** 判定为墨线的亮度上限（0-255） */
  inkLuma: number;
  /** 判定为彩铅的最小色度距离 */
  colorChroma: number;
  /** 彩铅亮度下限（浅色彩铅） */
  pencilLumaMin: number;
  /** 彩铅亮度上限 */
  pencilLumaMax: number;
  /** 压墨恢复的最大生长半径（像素） */
  overlapRecoverRadius: number;
  /** 墨线碎斑过滤的最小连通块面积（像素），0 表示不过滤 */
  minInkComponent: number;
}

export const DEFAULT_CLASSIFICATION: ClassificationOptions = {
  inkLuma: 140,
  colorChroma: 20,
  pencilLumaMin: 40,
  pencilLumaMax: 240,
  overlapRecoverRadius: 8,
  minInkComponent: 0,
};
