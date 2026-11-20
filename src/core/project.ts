import type { ColorRGBA, Point } from './types';
import type { Palette } from './palette';

/** 一次手动改判/填色的记录，便于撤销与跨帧同步 */
export interface PaintOp {
  frameNo: number;
  /** 目标轨道 id（跨帧稳定）；自由填色时为 -1 */
  trackId: number;
  /** 帧内区域 id（自由填色用） */
  regionId?: number;
  color: ColorRGBA;
  /** base | shadow | highlight */
  role: 'base' | 'shadow' | 'highlight';
  /** 该操作是否向同一轨道的其它帧传播（默认 true） */
  propagate: boolean;
}

export interface Shot {
  id: string;
  code: string;
  frameNos: number[];
  palettes: Palette[];
  /** trackId -> paletteId/colorId，角色前后帧色块的颜色绑定 */
  trackBindings: Map<number, { paletteId: string; colorId: string }>;
  ops: PaintOp[];
}

export interface Project {
  id: string;
  name: string;
  shots: Shot[];
  created: number;
}

export function createProject(name: string): Project {
  return { id: `proj-${name}`, name, shots: [], created: 0 };
}

export function createShot(code: string): Shot {
  return {
    id: `shot-${code}`,
    code,
    frameNos: [],
    palettes: [],
    trackBindings: new Map(),
    ops: [],
  };
}

/** 把轨道绑定到色指定表中的某个颜色；之后该轨道所有帧自动取色 */
export function bindTrack(shot: Shot, trackId: number, paletteId: string, colorId: string): void {
  shot.trackBindings.set(trackId, { paletteId, colorId });
}

export function resolveTrackColor(
  shot: Shot,
  trackId: number,
  role: 'base' | 'shadow' | 'highlight',
): ColorRGBA | undefined {
  const binding = shot.trackBindings.get(trackId);
  if (!binding) return undefined;
  const palette = shot.palettes.find((p) => p.id === binding.paletteId);
  const spec = palette?.colors.find((c) => c.id === binding.colorId);
  if (!spec) return undefined;
  return spec[role];
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
