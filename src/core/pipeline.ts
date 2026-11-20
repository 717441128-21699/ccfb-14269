import type {
  AffineTransform,
  LabelRaster,
  RGBImage,
  RegionMap,
  ShadowProposal,
} from './types';
import { LayerKind } from './types';
import { estimateRegistration, warpImage, type PegHole } from './holes';
import { classifyLayers, buildBarrierMask, type ClassificationResult } from './classify';
import { buildRegionMap } from './regions';
import { proposeShadows, type ShadowOptions } from './shadows';
import {
  buildFrameRegions,
  trackRegions,
  type FrameRegions,
  type TrackResult,
} from './tracker';
import type { ClassificationOptions } from './types';

export interface FramePipelineResult {
  frameNo: number;
  alignedImage: RGBImage;
  transform: AffineTransform;
  holes: PegHole[];
  classification: ClassificationResult;
  labelRaster: LabelRaster;
  barrier: Uint8Array;
  regionMap: RegionMap;
  shadowProposal: ShadowProposal;
  frameRegions: FrameRegions;
  track?: TrackResult;
  timings: Record<string, number>;
  totalMs: number;
}

export interface PipelineOptions {
  classification: ClassificationOptions;
  shadow: ShadowOptions;
}

export interface TimingSink {
  timings: Record<string, number>;
  measure<T>(name: string, fn: () => T): T;
}

function createTimingSink(): TimingSink {
  const timings: Record<string, number> = {};
  return {
    timings,
    measure(name, fn) {
      const t0 = performance.now();
      const out = fn();
      timings[name] = (timings[name] ?? 0) + (performance.now() - t0);
      return out;
    },
  };
}

/**
 * 单帧处理链（不依赖前一帧），同时也是性能基准测试的入口：
 * 对齐 → 颜色分层 → 屏障/闭合区域 → 阴影高光提案。
 * 目标：A4 @150dpi（约 1240×1754）端到端 < 2000ms。
 */
export function processFrame(
  image: RGBImage,
  frameNo: number,
  referenceHoles: PegHole[] | undefined,
  options: PipelineOptions,
  semanticTruth?: Int32Array,
): FramePipelineResult {
  const sink = createTimingSink();
  const tStart = performance.now();

  const registration = sink.measure('registration', () => estimateRegistration(image, referenceHoles));
  const alignedImage = sink.measure('warp', () =>
    registration.transform.a === 1 && registration.transform.d === 1 &&
    registration.transform.b === 0 && registration.transform.c === 0 &&
    registration.transform.e === 0 && registration.transform.f === 0
      ? image
      : warpImage(image, registration.transform),
  );

  const classification = sink.measure('classify', () =>
    classifyLayers(alignedImage, options.classification),
  );
  const labelRaster = classification.layers.labelRaster;
  // 定位孔标签从配准阶段合并进最终标签栅格
  if (registration.holeLabel) {
    for (let i = 0; i < labelRaster.labels.length; i++) {
      if (registration.holeLabel.labels[i] === LayerKind.PegHole) labelRaster.labels[i] = LayerKind.PegHole;
    }
  }

  const barrier = sink.measure('regions', () => buildBarrierMask(labelRaster));
  const regionMap = sink.measure('regions', () => buildRegionMap(barrier, alignedImage.width, alignedImage.height));
  const shadowProposal = sink.measure('shadows', () => proposeShadows(labelRaster, options.shadow));
  const frameRegions = sink.measure('track', () =>
    buildFrameRegions(frameNo, regionMap, semanticTruth),
  );

  return {
    frameNo,
    alignedImage,
    transform: registration.transform,
    holes: registration.holes,
    classification,
    labelRaster,
    barrier,
    regionMap,
    shadowProposal,
    frameRegions,
    timings: sink.timings,
    totalMs: performance.now() - tStart,
  };
}

/**
 * 序列管线：维护参考定位孔与上一帧状态，
 * 自动完成帧间色块对应与未动区域沿用判定。
 */
export class AnimationPipeline {
  private referenceHoles: PegHole[] | undefined;
  private prev: FrameRegions | undefined;
  private prevLabels: Uint8Array | undefined;
  private nextTrackId = 0;
  /** 语义 id -> 稳定 track id 的跨帧记忆（合成数据用语义真值；生产替换为颜色/形状特征） */
  private semanticTrackMemory = new Map<number, number>();

  constructor(private options: PipelineOptions) {}

  get reference(): PegHole[] | undefined {
    return this.referenceHoles;
  }

  process(
    image: RGBImage,
    frameNo: number,
    semanticTruth?: Int32Array,
    overrides?: Map<number, number>,
  ): FramePipelineResult {
    const result = processFrame(image, frameNo, this.referenceHoles, this.options, semanticTruth);
    if (!this.referenceHoles && result.holes.length >= 3) {
      this.referenceHoles = result.holes;
    }

    if (this.prev && this.prevLabels) {
      const t0 = performance.now();
      result.track = trackRegions(
        this.prev,
        result.frameRegions,
        this.prevLabels,
        result.labelRaster.labels,
        this.nextTrackId,
        undefined,
        overrides,
        this.semanticTrackMemory,
      );
      this.nextTrackId = result.track.nextTrackId;
      result.timings.track = (result.timings.track ?? 0) + (performance.now() - t0);
      result.totalMs += performance.now() - t0;
    } else {
      // 首帧：所有区域各自成为一条轨道，并写入语义记忆
      const matches = new Map();
      for (const inst of result.frameRegions.instances) {
        inst.trackId = this.nextTrackId;
        matches.set(inst.regionId, {
          regionId: inst.regionId,
          trackId: this.nextTrackId,
          score: 1,
          unchanged: false,
        });
        if (inst.semanticId !== undefined) this.semanticTrackMemory.set(inst.semanticId, this.nextTrackId);
        this.nextTrackId++;
      }
    }

    this.prev = result.frameRegions;
    this.prevLabels = result.labelRaster.labels;
    return result;
  }

  reset(): void {
    this.referenceHoles = undefined;
    this.prev = undefined;
    this.prevLabels = undefined;
    this.semanticTrackMemory.clear();
    this.nextTrackId = 0;
  }
}
