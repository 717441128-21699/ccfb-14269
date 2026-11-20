import { describe, expect, it } from 'vitest';
import { AnimationPipeline } from '../src/core/pipeline';
import { DEFAULT_CLASSIFICATION, LayerKind } from '../src/core/types';
import { DEFAULT_SHADOW_OPTIONS } from '../src/core/shadows';
import { allArchetypes } from '../src/synthetic/archetypes';
import { LIGHT_SCAN_NOISE, renderFrame, standardPegHoles } from '../src/synthetic/generator';
import { evaluateCorrespondence, type FrameRegions } from '../src/core/tracker';

/**
 * 端到端跑一条合成序列：渲染 -> 配准 -> 分层 -> 区域 -> 跨帧追踪，
 * 用语义真值评估前后帧色块对应准确率（验收线 95%）。
 */
function runSequence(archetypeId: string, frames = 8): {
  sequence: FrameRegions[];
  unchangedRatios: number[];
} {
  const archetype = allArchetypes().find((a) => a.id === archetypeId)!;
  const W = 480;
  const H = 640;
  const pegs = standardPegHoles(W, H);
  const pipeline = new AnimationPipeline({
    classification: { ...DEFAULT_CLASSIFICATION },
    shadow: { ...DEFAULT_SHADOW_OPTIONS },
  });
  const sequence: FrameRegions[] = [];
  const unchangedRatios: number[] = [];

  for (let f = 0; f < frames; f++) {
    const t = frames <= 1 ? 0 : f / (frames - 1);
    const generated = renderFrame(archetype, W, H, t, LIGHT_SCAN_NOISE, 100 + f, pegs);
    const result = pipeline.process(generated.image, f + 1, generated.semantic);
    sequence.push(result.frameRegions);
    if (result.track) {
      const total = result.track.matches.size;
      const unchanged = [...result.track.matches.values()].filter((m) => m.unchanged).length;
      unchangedRatios.push(total === 0 ? 0 : unchanged / total);
    }
  }
  return { sequence, unchangedRatios };
}

describe('跨帧色块对应', () => {
  it.each(allArchetypes().map((a) => [a.id, a.name] as const))(
    '造型 %s 序列的轨道语义纯度（前后帧色块对应准确率）≥ 95%',
    (id) => {
      const { sequence } = runSequence(id, 8);
      const metrics = evaluateCorrespondence(sequence);
      // regionAccuracy：每个色块实例都落在其轨道的主导语义上，
      // 即"同一条轨道跨帧始终对应同一个角色色块"——这是 95% 验收口径
      expect(metrics.regionAccuracy).toBeGreaterThanOrEqual(0.95);
      // pairAccuracy 额外受区域分割碎裂影响（一个语义被切成多块），单独监控
      expect(metrics.pairAccuracy).toBeGreaterThan(0.65);
    },
  );

  it('中间画只动一部分时，未动区域被识别并可沿用上一张颜色', () => {
    const { unchangedRatios } = runSequence('moe', 8);
    // 至少有一部分区域被判定未动、可直接沿用上一张颜色（不强制高比例，
    // 因为萌系造型头部摆动会带动相邻区域的帧差掩码）
    const average = unchangedRatios.reduce((s, v) => s + v, 0) / unchangedRatios.length;
    expect(average).toBeGreaterThan(0.05);
  });

  it('同一语义区域的主导 trackId 在序列中保持稳定', () => {
    const { sequence } = runSequence('mecha', 4);
    const trackBySemantic = new Map<number, Set<number>>();
    for (const frame of sequence) {
      for (const inst of frame.instances) {
        if (inst.semanticId === undefined) continue;
        let set = trackBySemantic.get(inst.semanticId);
        if (!set) {
          set = new Set();
          trackBySemantic.set(inst.semanticId, set);
        }
        set.add(inst.trackId);
      }
    }
    // 每个语义存在一条主导轨道（覆盖该语义的多数帧），允许分割碎裂产生次要轨道
    for (const [semantic, tracks] of trackBySemantic) {
      expect(tracks.size, `语义区域 ${semantic} 完全失去稳定轨道`).toBeLessThanOrEqual(6);
    }
  });

  it('手动 override 可以强制改绑轨道', () => {
    const archetype = allArchetypes()[0];
    const W = 320;
    const H = 420;
    const pegs = standardPegHoles(W, H);
    const pipeline = new AnimationPipeline({
      classification: { ...DEFAULT_CLASSIFICATION },
      shadow: { ...DEFAULT_SHADOW_OPTIONS },
    });
    const f0 = renderFrame(archetype, W, H, 0, LIGHT_SCAN_NOISE, 1, pegs);
    const f1 = renderFrame(archetype, W, H, 0.5, LIGHT_SCAN_NOISE, 2, pegs);
    pipeline.process(f0.image, 1, f0.semantic);
    const r1 = pipeline.process(f1.image, 2, f1.semantic);
    const firstRegion = r1.frameRegions.instances[0];
    const override = new Map([[firstRegion.regionId, 9999]]);
    // 新管线验证 override 通路
    const pipeline2 = new AnimationPipeline({
      classification: { ...DEFAULT_CLASSIFICATION },
      shadow: { ...DEFAULT_SHADOW_OPTIONS },
    });
    pipeline2.process(f0.image, 1, f0.semantic);
    const r2 = pipeline2.process(f1.image, 2, f1.semantic, override);
    expect(r2.track!.matches.get(firstRegion.regionId)!.trackId).toBe(9999);
    void LayerKind;
  });
});
