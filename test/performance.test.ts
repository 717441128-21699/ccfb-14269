import { describe, expect, it } from 'vitest';
import { processFrame } from '../src/core/pipeline';
import { DEFAULT_CLASSIFICATION } from '../src/core/types';
import { DEFAULT_SHADOW_OPTIONS } from '../src/core/shadows';
import { allArchetypes, type Archetype } from '../src/synthetic/archetypes';
import {
  CLEAN,
  LIGHT_SCAN_NOISE,
  HEAVY_SCAN_NOISE,
  renderFrame,
  standardPegHoles,
  type NoiseModel,
} from '../src/synthetic/generator';

/**
 * 性能验收：一张 A4 @150dpi（1240×1754 ≈ 218 万像素）从分层到可上色
 * 端到端不超过 2 秒。RUN_PERF=1 时才跑全尺寸，常规测试用半尺寸守护。
 */
const A4_W = 1240;
const A4_H = 1754;
const BUDGET_MS = 2000;

const options = {
  classification: { ...DEFAULT_CLASSIFICATION },
  shadow: { ...DEFAULT_SHADOW_OPTIONS },
};

function bench(archetype: Archetype, noise: NoiseModel, w: number, h: number): number {
  const frame = renderFrame(archetype, w, h, 0.3, noise, 77, standardPegHoles(w, h));
  // 预热一次（JIT/隐藏延迟）
  processFrame(frame.image, 1, undefined, options, frame.semantic);
  const t0 = performance.now();
  const result = processFrame(frame.image, 1, undefined, options, frame.semantic);
  const elapsed = performance.now() - t0;
  // 守护：性能测试同时验证功能没有因为尺寸放大而崩
  expect(result.regionMap.areas.length - 1).toBeGreaterThan(0);
  return elapsed;
}

describe('A4 性能预算（分层到可上色 ≤ 2000ms）', () => {
  const fullSize = process.env.RUN_PERF === '1';
  const w = fullSize ? A4_W : 620;
  const h = fullSize ? A4_H : 877;

  it.each(allArchetypes().map((a) => [a.id, a.name] as const))(
    `造型 %s 轻度噪声端到端处理（${fullSize ? 'A4 全尺寸' : '半尺寸守护'}）`,
    (id) => {
      const archetype = allArchetypes().find((a) => a.id === id)!;
      const elapsed = bench(archetype, LIGHT_SCAN_NOISE, w, h);
      if (fullSize) {
        expect(elapsed).toBeLessThan(BUDGET_MS);
      } else {
        // 半尺寸约为全尺寸 1/4 像素量，预算按比例放宽
        expect(elapsed).toBeLessThan(BUDGET_MS / 2);
      }
    },
  );

  it('全尺寸重度噪声也在预算内', () => {
    if (!fullSize) return;
    const elapsed = bench(allArchetypes()[0], HEAVY_SCAN_NOISE, A4_W, A4_H);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('干净图处理耗时分布可解释（各阶段都有计时）', () => {
    const archetype = allArchetypes()[0];
    const frame = renderFrame(archetype, w, h, 0, CLEAN, 5, standardPegHoles(w, h));
    const result = processFrame(frame.image, 1, undefined, options);
    for (const stage of ['registration', 'warp', 'classify', 'regions', 'shadows']) {
      expect(result.timings[stage]).toBeGreaterThanOrEqual(0);
    }
    expect(result.totalMs).toBeGreaterThan(0);
  });
});
