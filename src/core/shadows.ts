import type { LabelRaster, RegionMap, ShadowProposal } from './types';
import { LayerKind } from './types';
import { buildRegionMap, dilate, regionMask } from './regions';

export interface ShadowOptions {
  /** 彩铅分界线膨胀半径：让线两侧的区域被明确切开 */
  dividerRadius: number;
  /** 阴影/高光区域的最小面积（像素），小于此值视为碎块并入 base */
  minRegionArea: number;
}

export const DEFAULT_SHADOW_OPTIONS: ShadowOptions = {
  dividerRadius: 2,
  minRegionArea: 24,
};

/**
 * 阴影/高光提案：
 * 1. 墨线构成主闭合区域；
 * 2. 红铅（阴影分界）/蓝铅（高光）膨胀后作为附加屏障，把主区域切成子区域；
 * 3. 与红铅屏障相邻的子区域标 shadow，与蓝铅相邻的标 highlight，其余为 base；
 * 4. 同时贴红蓝时蓝铅优先（高光覆盖阴影），画师可手动改判。
 */
export function proposeShadows(labelRaster: LabelRaster, options: ShadowOptions = DEFAULT_SHADOW_OPTIONS): ShadowProposal {
  const { width: w, height: h, labels } = labelRaster;
  const n = w * h;

  const ink = new Uint8Array(n);
  const red = new Uint8Array(n);
  const blue = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = labels[i];
    if (v === LayerKind.Ink || v === LayerKind.PegHole) ink[i] = 1;
    if (v === LayerKind.RedPencil) red[i] = 1;
    if (v === LayerKind.BluePencil) blue[i] = 1;
  }

  const redD = dilate(red, w, h, options.dividerRadius);
  const blueD = dilate(blue, w, h, options.dividerRadius);

  // 总屏障：墨线 + 膨胀后的红蓝分界线
  const barrier = new Uint8Array(n);
  for (let i = 0; i < n; i++) barrier[i] = ink[i] || redD[i] || blueD[i] ? 1 : 0;
  const map = buildRegionMap(barrier, w, h);

  // 统计每个区域与红/蓝屏障的邻接次数
  const touchRed = new Map<number, number>();
  const touchBlue = new Map<number, number>();
  const ids = map.ids;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const rid = ids[i];
      if (rid === 0) continue;
      if (x > 0) {
        const j = i - 1;
        if (redD[j]) touchRed.set(rid, (touchRed.get(rid) ?? 0) + 1);
        if (blueD[j]) touchBlue.set(rid, (touchBlue.get(rid) ?? 0) + 1);
      }
      if (x < w - 1) {
        const j = i + 1;
        if (redD[j]) touchRed.set(rid, (touchRed.get(rid) ?? 0) + 1);
        if (blueD[j]) touchBlue.set(rid, (touchBlue.get(rid) ?? 0) + 1);
      }
      if (y > 0) {
        const j = i - w;
        if (redD[j]) touchRed.set(rid, (touchRed.get(rid) ?? 0) + 1);
        if (blueD[j]) touchBlue.set(rid, (touchBlue.get(rid) ?? 0) + 1);
      }
      if (y < h - 1) {
        const j = i + w;
        if (redD[j]) touchRed.set(rid, (touchRed.get(rid) ?? 0) + 1);
        if (blueD[j]) touchBlue.set(rid, (touchBlue.get(rid) ?? 0) + 1);
      }
    }
  }

  const kind = new Map<number, 'shadow' | 'highlight' | 'base'>();
  const shadowIds = new Set<number>();
  const highlightIds = new Set<number>();
  for (let rid = 1; rid < map.areas.length; rid++) {
    if (map.areas[rid] < options.minRegionArea) {
      kind.set(rid, 'base');
      continue;
    }
    const r = touchRed.get(rid) ?? 0;
    const b = touchBlue.get(rid) ?? 0;
    let k: 'shadow' | 'highlight' | 'base' = 'base';
    if (b > 0 && b >= r) {
      k = 'highlight';
      highlightIds.add(rid);
    } else if (r > 0) {
      k = 'shadow';
      shadowIds.add(rid);
    }
    kind.set(rid, k);
  }

  // 输出独立的 shadow / highlight 区域图（保留同一套 id 体系，便于手改后回填）
  const shadow: RegionMap = { width: w, height: h, ids: new Int32Array(ids), areas: map.areas, seeds: map.seeds };
  const highlight: RegionMap = { width: w, height: h, ids: new Int32Array(ids), areas: map.areas, seeds: map.seeds };
  for (let i = 0; i < n; i++) {
    const rid = ids[i];
    if (rid === 0) continue;
    if (!shadowIds.has(rid)) shadow.ids[i] = 0;
    if (!highlightIds.has(rid)) highlight.ids[i] = 0;
  }
  return { shadow, highlight, kind };
}

/** 手动改判：把某个子区域在 shadow/highlight/base 之间切换 */
export function overrideRegionKind(proposal: ShadowProposal, regionId: number, next: 'shadow' | 'highlight' | 'base'): ShadowProposal {
  const kind = new Map(proposal.kind);
  kind.set(regionId, next);
  const n = proposal.shadow.width * proposal.shadow.height;
  const shadowIds = new Int32Array(proposal.shadow.ids);
  const highlightIds = new Int32Array(proposal.highlight.ids);
  const baseIds = proposal.shadow.ids;
  for (let i = 0; i < n; i++) {
    if (baseIds[i] !== regionId && proposal.highlight.ids[i] !== regionId) continue;
    shadowIds[i] = next === 'shadow' ? regionId : 0;
    highlightIds[i] = next === 'highlight' ? regionId : 0;
  }
  return {
    shadow: { ...proposal.shadow, ids: shadowIds },
    highlight: { ...proposal.highlight, ids: highlightIds },
    kind,
  };
}

/** 取某类区域的合并掩码（自动填阴影色时直接用） */
export function maskOfKind(proposal: ShadowProposal, wanted: 'shadow' | 'highlight'): Uint8Array {
  const map = wanted === 'shadow' ? proposal.shadow : proposal.highlight;
  const out = new Uint8Array(map.width * map.height);
  for (let i = 0; i < out.length; i++) if (map.ids[i] !== 0) out[i] = 1;
  return out;
}

export { regionMask };
