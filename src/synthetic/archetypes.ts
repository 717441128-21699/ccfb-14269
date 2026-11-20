import type { Point } from '../core/types';

/**
 * 三种角色造型的参数化定义。
 * 每个造型由若干"语义区域"（可上色闭合块，带稳定 semanticId）、
 * 墨线轮廓、红铅阴影分界线、蓝铅高光线组成。
 * frameT ∈ [0,1] 驱动中间画：只让部分区域运动，用于验证差异沿用与色块对应。
 */

export interface SemanticRegion {
  id: number;
  name: string;
  /** 返回该帧的多边形（画布坐标） */
  poly: (t: number) => Point[];
}

export interface DividerLine {
  kind: 'red' | 'blue';
  from: (t: number) => Point;
  to: (t: number) => Point;
}

export interface Archetype {
  id: string;
  name: string;
  inkThickness: number;
  pencilThickness: number;
  regions: SemanticRegion[];
  /** 墨线（区域轮廓之外的额外线条，如五官、接缝） */
  inkLines: Array<{ from: (t: number) => Point; to: (t: number) => Point }>;
  dividers: DividerLine[];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const P = (x: number, y: number): Point => ({ x, y });

/** 椭圆多边形（萌系造型用） */
function ellipse(cx: number, cy: number, rx: number, ry: number, segments = 28): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(P(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
  }
  return out;
}

/** 圆角矩形多边形（机甲造型用） */
function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): Point[] {
  const pts: Point[] = [];
  const corners: Array<[number, number, number, number]> = [
    [x1 - r, y0 + r, -Math.PI / 2, 0],
    [x1 - r, y1 - r, 0, Math.PI / 2],
    [x0 + r, y1 - r, Math.PI / 2, Math.PI],
    [x0 + r, y0 + r, Math.PI, Math.PI * 1.5],
  ];
  for (const [cx, cy, a0, a1] of corners) {
    for (let i = 0; i <= 5; i++) {
      const a = lerp(a0, a1, i / 5);
      pts.push(P(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  }
  return pts;
}

/** 造型 1：萌系圆脸——头部/头发/衣服都是椭圆曲线，中间画时头部轻微摆动 */
export function moeArchetype(): Archetype {
  const headSwing = (t: number) => Math.sin(t * Math.PI * 2) * 14;
  const armSwing = (t: number) => Math.sin(t * Math.PI * 2) * 10;
  return {
    id: 'moe',
    name: '萌系圆脸',
    inkThickness: 3,
    pencilThickness: 2,
    regions: [
      {
        id: 101,
        name: '脸',
        poly: (t) => ellipse(320 + headSwing(t), 300, 120, 110),
      },
      {
        id: 102,
        name: '头发',
        poly: (t) => ellipse(320 + headSwing(t), 215, 135, 70),
      },
      {
        id: 103,
        name: '上衣',
        poly: (t) => [
          P(210, 470),
          P(430, 470),
          P(455, 720),
          P(185, 720),
        ].map((p) => P(p.x + headSwing(t) * 0.3, p.y)),
      },
      {
        id: 104,
        name: '左袖',
        poly: (t) =>
          roundedRect(150 - armSwing(t), 480, 215 - armSwing(t), 660, 22),
      },
      {
        id: 105,
        name: '右袖',
        poly: (t) =>
          roundedRect(425 + armSwing(t), 480, 490 + armSwing(t), 660, 22),
      },
    ],
    inkLines: [
      { from: (t) => P(275 + headSwing(t), 290), to: (t) => P(295 + headSwing(t), 290) },
      { from: (t) => P(345 + headSwing(t), 290), to: (t) => P(365 + headSwing(t), 290) },
      { from: (t) => P(320 + headSwing(t), 310), to: (t) => P(315 + headSwing(t), 345) },
      { from: (t) => P(290 + headSwing(t), 360), to: (t) => P(350 + headSwing(t), 360) },
    ],
    dividers: [
      // 脸上的阴影分界（红铅）：竖在脸部内部，不贴轮廓
      { kind: 'red', from: (t) => P(360 + headSwing(t), 250), to: (t) => P(372 + headSwing(t), 350) },
      // 头发高光（蓝铅）：头发区域内部
      { kind: 'blue', from: (t) => P(275 + headSwing(t), 200), to: (t) => P(315 + headSwing(t), 195) },
      // 上衣阴影分界：在衣服内部
      { kind: 'red', from: () => P(330, 510), to: () => P(345, 690) },
    ],
  };
}

/** 造型 2：机甲硬朗——直线/折角/装甲分块，中间画时手臂装甲位移 */
export function mechaArchetype(): Archetype {
  const armShift = (t: number) => Math.round(Math.sin(t * Math.PI * 2) * 12);
  return {
    id: 'mecha',
    name: '机甲硬朗',
    inkThickness: 4,
    pencilThickness: 2,
    regions: [
      {
        id: 201,
        name: '头盔',
        poly: () => roundedRect(220, 110, 420, 330, 18),
      },
      {
        id: 202,
        name: '胸甲',
        poly: () => [P(200, 360), P(440, 360), P(470, 620), P(170, 620)],
      },
      {
        id: 203,
        name: '左肩甲',
        poly: (t) => roundedRect(95 + armShift(t), 380, 190 + armShift(t), 520, 10),
      },
      {
        id: 204,
        name: '右肩甲',
        poly: (t) => roundedRect(450 - armShift(t), 380, 545 - armShift(t), 520, 10),
      },
      {
        id: 205,
        name: '腰甲',
        poly: () => roundedRect(230, 630, 410, 720, 8),
      },
    ],
    inkLines: [
      { from: () => P(260, 220), to: () => P(330, 220) },
      { from: () => P(310, 220), to: () => P(380, 220) },
      { from: () => P(320, 360), to: () => P(320, 620) },
      { from: () => P(170, 490), to: () => P(470, 490) },
    ],
    dividers: [
      // 胸甲内部阴影分界
      { kind: 'red', from: () => P(300, 400), to: () => P(320, 590) },
      // 头盔内部高光
      { kind: 'blue', from: () => P(265, 170), to: () => P(330, 170) },
      // 左肩甲内部阴影
      { kind: 'red', from: (t) => P(130 + armShift(t), 410), to: (t) => P(160 + armShift(t), 490) },
    ],
  };
}

/** 造型 3：兽耳 Q 版——头大身小、三角耳，中间画时耳朵抖动 */
export function beastArchetype(): Archetype {
  const earTwitch = (t: number) => Math.sin(t * Math.PI * 4) * 8;
  return {
    id: 'beast',
    name: '兽耳Q版',
    inkThickness: 3,
    pencilThickness: 2,
    regions: [
      {
        id: 301,
        name: '头',
        poly: () => ellipse(320, 320, 150, 135),
      },
      {
        id: 302,
        name: '左耳',
        poly: (t) => [
          P(205, 215 + earTwitch(t)),
          P(235, 95 + earTwitch(t) * 1.4),
          P(275, 190),
        ],
      },
      {
        id: 303,
        name: '右耳',
        poly: (t) => [
          P(365, 190),
          P(405, 95 - earTwitch(t) * 1.4),
          P(435, 215 - earTwitch(t)),
        ],
      },
      {
        id: 304,
        name: '身体',
        poly: () => roundedRect(250, 470, 390, 700, 40),
      },
      {
        id: 305,
        name: '尾巴',
        poly: (t) =>
          ellipse(420, 600 + Math.sin(t * Math.PI * 2) * 12, 34, 70).map((p) =>
            P(p.x + 30, p.y),
          ),
      },
    ],
    inkLines: [
      { from: () => P(265, 310), to: () => P(295, 310) },
      { from: () => P(345, 310), to: () => P(375, 310) },
      { from: () => P(300, 370), to: () => P(340, 370) },
    ],
    dividers: [
      // 头部右侧内部阴影分界
      { kind: 'red', from: () => P(370, 270), to: () => P(385, 390) },
      // 头部左侧内部高光
      { kind: 'blue', from: () => P(265, 265), to: () => P(305, 255) },
      // 身体内部阴影
      { kind: 'red', from: () => P(305, 510), to: () => P(318, 670) },
    ],
  };
}

export function allArchetypes(): Archetype[] {
  return [moeArchetype(), mechaArchetype(), beastArchetype()];
}

export function getArchetype(id: string): Archetype {
  const a = allArchetypes().find((x) => x.id === id);
  if (!a) throw new Error(`未知造型: ${id}`);
  return a;
}
