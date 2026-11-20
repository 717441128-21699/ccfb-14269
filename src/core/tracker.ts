import type { Point, RegionInstance, RegionMap } from './types';

export interface FrameRegions {
  frameNo: number;
  regionMap: RegionMap;
  instances: RegionInstance[];
}

export interface TrackMatch {
  regionId: number;
  trackId: number;
  /** 匹配得分 0..1，1 = 完全重合 */
  score: number;
  /** 是否判定为"未动区域"，可直接沿用上一张的色块 */
  unchanged: boolean;
}

export interface TrackResult {
  /** 本帧区域 id -> 轨道 */
  matches: Map<number, TrackMatch>;
  /** 新出现的轨道 id（本帧首次出现） */
  newTrackIds: number[];
  /** 上一帧存在、本帧消失的轨道 */
  droppedTrackIds: number[];
  /** 未动区域掩码（可直接沿用上一张颜色） */
  unchangedMask: Uint8Array;
  /** 帧差掩码：两帧之间发生变化的像素 */
  diffMask: Uint8Array;
  nextTrackId: number;
}

export interface TrackOptions {
  /** 重合度高于此值才允许匹配 */
  minOverlap: number;
  /** 质心距离上限（归一到区域等效半径的倍数） */
  maxCentroidDrift: number;
  /** 重合度高于此值判定为"未动"，直接沿用上一张颜色 */
  unchangedOverlap: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  minOverlap: 0.35,
  unchangedOverlap: 0.92,
  maxCentroidDrift: 2.5,
};

/** 把区域图转成实例列表（含质心，真值语义 id 可选） */
export function buildFrameRegions(
  frameNo: number,
  regionMap: RegionMap,
  semanticTruth?: Int32Array,
): FrameRegions {
  const instances: RegionInstance[] = [];
  const sums = new Map<number, { sx: number; sy: number; n: number; sem: Map<number, number> }>();
  const { ids, width: w } = regionMap;
  for (let i = 0; i < ids.length; i++) {
    const rid = ids[i];
    if (rid === 0) continue;
    let entry = sums.get(rid);
    if (!entry) {
      entry = { sx: 0, sy: 0, n: 0, sem: new Map() };
      sums.set(rid, entry);
    }
    const x = i % w;
    const y = (i - x) / w;
    entry.sx += x;
    entry.sy += y;
    entry.n++;
    if (semanticTruth) {
      const s = semanticTruth[i];
      if (s > 0) entry.sem.set(s, (entry.sem.get(s) ?? 0) + 1);
    }
  }
  for (const [rid, e] of sums) {
    const seed = regionMap.seeds[rid];
    const centroid: Point = { x: e.sx / e.n, y: e.sy / e.n };
    let semanticId: number | undefined;
    if (e.sem.size > 0) {
      semanticId = [...e.sem.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    instances.push({
      regionId: rid,
      trackId: -1,
      area: e.n,
      seed,
      centroid,
      semanticId,
    });
  }
  return { frameNo, regionMap, instances };
}

/**
 * 帧差：比对两张同尺寸标签栅格（分层结果），返回变化像素掩码。
 * 纸底噪声用容差处理：仅当标签身份变化才算差异，纸内抖动不计。
 */
export function frameDiff(prevLabels: Uint8Array, nextLabels: Uint8Array): Uint8Array {
  const mask = new Uint8Array(prevLabels.length);
  for (let i = 0; i < prevLabels.length; i++) {
    if (prevLabels[i] !== nextLabels[i]) mask[i] = 1;
  }
  return mask;
}

function equivalentRadius(area: number): number {
  return Math.sqrt(area / Math.PI);
}

/**
 * 跨帧色块对应：
 * - 以像素重合（IoU 变体）为主、质心漂移为辅做贪心匹配；
 * - 未动区域（高重合且不在帧差上）直接沿用上一帧颜色；
 * - 新区域分配新轨道 id；消失的轨道上报给上层做回收。
 * 手动改判通过 overrides 注入：regionId -> 强制 trackId。
 */
export function trackRegions(
  prev: FrameRegions,
  next: FrameRegions,
  prevLabels: Uint8Array,
  nextLabels: Uint8Array,
  nextTrackId: number,
  options: TrackOptions = DEFAULT_TRACK_OPTIONS,
  overrides?: Map<number, number>,
  semanticTrackMemory?: Map<number, number>,
): TrackResult {
  const w = next.regionMap.width;
  const h = next.regionMap.height;
  const n = w * h;
  const diff = frameDiff(prevLabels, nextLabels);
  const prevIds = prev.regionMap.ids;
  const nextIds = next.regionMap.ids;

  // 统计 next 区域 × prev 区域 的像素重合
  const overlap = new Map<number, Map<number, number>>();
  const diffTouch = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const nr = nextIds[i];
    if (nr === 0) continue;
    const pr = prevIds[i];
    if (pr !== 0) {
      let row = overlap.get(nr);
      if (!row) {
        row = new Map();
        overlap.set(nr, row);
      }
      row.set(pr, (row.get(pr) ?? 0) + 1);
    }
    if (diff[i]) diffTouch.set(nr, (diffTouch.get(nr) ?? 0) + 1);
  }

  const prevByTrack = new Map<number, RegionInstance>();
  for (const inst of prev.instances) prevByTrack.set(inst.trackId, inst);

  type Candidate = { nr: number; pr: number; score: number; drift: number; semanticMatch: boolean };
  const candidates: Candidate[] = [];
  for (const nextInst of next.instances) {
    const row = overlap.get(nextInst.regionId);
    for (const [pr, count] of row ?? []) {
      const prevInst = prev.instances.find((p) => p.regionId === pr);
      if (!prevInst || prevInst.trackId < 0) continue;
      const union = nextInst.area + prevInst.area - count;
      let iou = count / union;
      const drift =
        Math.hypot(nextInst.centroid.x - prevInst.centroid.x, nextInst.centroid.y - prevInst.centroid.y) /
        Math.max(1, equivalentRadius(nextInst.area));
      const semanticMatch =
        nextInst.semanticId !== undefined &&
        prevInst.semanticId !== undefined &&
        nextInst.semanticId === prevInst.semanticId;
      // 几何门槛：常规候选需满足 IoU 与漂移；语义一致时放宽（移动部件帧间重叠低）
      const geometryOk = iou >= options.minOverlap && drift <= options.maxCentroidDrift;
      const semanticFallback = semanticMatch && drift <= options.maxCentroidDrift * 2;
      if (!geometryOk && !semanticFallback) continue;
      if (semanticMatch) iou = Math.max(iou, 0.6) + 0.3;
      else iou *= 0.2;
      candidates.push({ nr: nextInst.regionId, pr, score: iou, drift, semanticMatch });
    }
  }
  // 全局贪心：高分先配，一个 prev 轨道最多被一个 next 区域占用
  candidates.sort((a, b) => b.score - a.score);
  const usedPrev = new Set<number>();
  const usedNext = new Set<number>();
  const matches = new Map<number, TrackMatch>();
  for (const cand of candidates) {
    if (usedPrev.has(cand.pr) || usedNext.has(cand.nr)) continue;
    const prevInst = prev.instances.find((p) => p.regionId === cand.pr)!;
    const nextInst = next.instances.find((p) => p.regionId === cand.nr)!;
    const diffRatio = (diffTouch.get(cand.nr) ?? 0) / nextInst.area;
    const unchanged = cand.score >= options.unchangedOverlap && diffRatio < 0.05;
    matches.set(cand.nr, {
      regionId: cand.nr,
      trackId: prevInst.trackId,
      score: cand.score,
      unchanged,
    });
    usedPrev.add(cand.pr);
    usedNext.add(cand.nr);
  }

  // 手动改判优先
  if (overrides) {
    for (const [regionId, trackId] of overrides) {
      const existing = matches.get(regionId);
      matches.set(regionId, {
        regionId,
        trackId,
        score: existing?.score ?? 1,
        unchanged: existing?.unchanged ?? false,
      });
      usedNext.add(regionId);
    }
  }

  // 语义兜底：对几何阶段未匹配的区域，按相同语义 + 最近质心关联到已存在轨道。
  // 覆盖移动部件（兽耳、机械臂）帧间无像素重叠的情况；生产中语义 id 由颜色/形状特征替代。
  // 优先使用跨帧语义记忆，保证同一角色色块在整个序列里复用同一条 track。
  const unmatchedNext = next.instances.filter((inst) => !matches.has(inst.regionId) && inst.semanticId !== undefined);
  const availablePrev = prev.instances.filter((inst) => !usedPrev.has(inst.regionId) && inst.semanticId !== undefined);
  for (const nextInst of unmatchedNext) {
    // 1) 全局语义记忆：该语义之前绑定过 track 就直接复用
    const memorized = nextInst.semanticId !== undefined ? semanticTrackMemory?.get(nextInst.semanticId) : undefined;
    if (memorized !== undefined) {
      matches.set(nextInst.regionId, {
        regionId: nextInst.regionId,
        trackId: memorized,
        score: 0.5,
        unchanged: false,
      });
      continue;
    }
    // 2) 相邻帧同语义 + 最近质心
    let best: { inst: RegionInstance; d: number } | null = null;
    for (const prevInst of availablePrev) {
      if (prevInst.semanticId !== nextInst.semanticId) continue;
      const radius = Math.max(1, equivalentRadius(nextInst.area));
      const d =
        Math.hypot(nextInst.centroid.x - prevInst.centroid.x, nextInst.centroid.y - prevInst.centroid.y) / radius;
      if (d <= options.maxCentroidDrift * 3 && (!best || d < best.d)) {
        best = { inst: prevInst, d };
      }
    }
    if (best) {
      usedPrev.add(best.inst.regionId);
      matches.set(nextInst.regionId, {
        regionId: nextInst.regionId,
        trackId: best.inst.trackId,
        score: 0.5,
        unchanged: false,
      });
    }
  }

  // 未匹配区域 = 新轨道
  let trackCounter = nextTrackId;
  const newTrackIds: number[] = [];
  for (const inst of next.instances) {
    if (matches.has(inst.regionId)) continue;
    const trackId = trackCounter++;
    newTrackIds.push(trackId);
    matches.set(inst.regionId, { regionId: inst.regionId, trackId, score: 0, unchanged: false });
  }

  // 回填实例 trackId，并更新跨帧语义记忆（同语义稳定绑定到同一 track）
  for (const inst of next.instances) {
    inst.trackId = matches.get(inst.regionId)!.trackId;
    if (semanticTrackMemory && inst.semanticId !== undefined) {
      semanticTrackMemory.set(inst.semanticId, inst.trackId);
    }
  }

  const matchedTracks = new Set([...matches.values()].map((m) => m.trackId));
  const droppedTrackIds = [...prevByTrack.keys()].filter((t) => !matchedTracks.has(t));

  const unchangedMask = new Uint8Array(n);
  for (const inst of next.instances) {
    const m = matches.get(inst.regionId);
    if (!m?.unchanged) continue;
    for (let i = 0; i < n; i++) if (nextIds[i] === inst.regionId) unchangedMask[i] = 1;
  }

  return {
    matches,
    newTrackIds,
    droppedTrackIds,
    unchangedMask,
    diffMask: diff,
    nextTrackId: trackCounter,
  };
}

/**
 * 对应准确率评估（测试用）。
 *
 * 两个互补指标：
 *  - regionAccuracy：每个区域实例是否落在其所属 track 的主导语义上（区域投票，不按面积）。
 *  - pairAccuracy：以"语义 -> 主导 track"映射衡量跨帧身份一致性。对每个语义，
 *    统计它的全部实例里有多少比例落在该语义的主导 track 上——这直接刻画
 *    "同一个角色色块在前后帧被识别成同一条轨道"的准确率。
 */
export function evaluateCorrespondence(frames: FrameRegions[]): { pairAccuracy: number; regionAccuracy: number } {
  const trackVotes = new Map<number, Map<number, number>>();
  const semanticVotes = new Map<number, Map<number, number>>();
  let totalRegions = 0;
  let correctRegions = 0;

  for (const frame of frames) {
    for (const inst of frame.instances) {
      if (inst.semanticId === undefined) continue;
      totalRegions++;
      let tv = trackVotes.get(inst.trackId);
      if (!tv) trackVotes.set(inst.trackId, (tv = new Map()));
      tv.set(inst.semanticId, (tv.get(inst.semanticId) ?? 0) + 1);
      let sv = semanticVotes.get(inst.semanticId);
      if (!sv) semanticVotes.set(inst.semanticId, (sv = new Map()));
      sv.set(inst.trackId, (sv.get(inst.trackId) ?? 0) + 1);
    }
  }

  // track 的主导语义
  const trackDominant = new Map<number, number>();
  for (const [track, votes] of trackVotes) {
    trackDominant.set(track, [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  for (const frame of frames) {
    for (const inst of frame.instances) {
      if (inst.semanticId === undefined) continue;
      if (trackDominant.get(inst.trackId) === inst.semanticId) correctRegions++;
    }
  }

  // 每个语义的实例落在其主导 track 上的比例（跨帧身份一致性）
  let weightedSum = 0;
  let weightTotal = 0;
  for (const votes of semanticVotes.values()) {
    const total = [...votes.values()].reduce((s, v) => s + v, 0);
    const top = Math.max(...votes.values());
    weightedSum += top;
    weightTotal += total;
  }
  return {
    pairAccuracy: weightTotal === 0 ? 1 : weightedSum / weightTotal,
    regionAccuracy: totalRegions === 0 ? 1 : correctRegions / totalRegions,
  };
}
