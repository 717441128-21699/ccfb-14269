import { describe, expect, it } from 'vitest';
import { LayerKind } from '../src/core/types';
import { classifyLayers } from '../src/core/classify';
import { allArchetypes } from '../src/synthetic/archetypes';
import {
  CLEAN,
  LIGHT_SCAN_NOISE,
  HEAVY_SCAN_NOISE,
  renderFrame,
  standardPegHoles,
} from '../src/synthetic/generator';

/** 忽略纸底与定位孔，只评估墨线/红铅/蓝铅三类笔迹的分层准确率 */
function strokeAccuracy(pred: Uint8Array, truth: Uint8Array): { accuracy: number; perClass: Record<string, number> } {
  let total = 0;
  let correct = 0;
  const classes = [LayerKind.Ink, LayerKind.RedPencil, LayerKind.BluePencil];
  const perClass: Record<string, { ok: number; n: number }> = {};
  for (const c of classes) perClass[c] = { ok: 0, n: 0 };
  for (let i = 0; i < truth.length; i++) {
    const t = truth[i];
    if (!classes.includes(t)) continue;
    total++;
    perClass[t].n++;
    if (pred[i] === t) {
      correct++;
      perClass[t].ok++;
    }
  }
  return {
    accuracy: correct / total,
    perClass: Object.fromEntries(Object.entries(perClass).map(([k, v]) => [k, v.ok / Math.max(1, v.n)])),
  };
}

describe('颜色分层', () => {
  const W = 480;
  const H = 640;

  it.each(allArchetypes().map((a) => [a.id, a.name] as const))(
    '造型 %s 在干净图上笔迹分层准确率 ≥ 97%',
    (id) => {
      const arch = allArchetypes().find((a) => a.id === id)!;
      const frame = renderFrame(arch, W, H, 0, CLEAN, 7, standardPegHoles(W, H));
      const result = classifyLayers(frame.image);
      const acc = strokeAccuracy(result.layers.labelRaster.labels, frame.truthLabels.labels);
      // 干净图无噪声，残余误差来自紧邻彩铅的墨线在压墨恢复中的局部扩散
      expect(acc.accuracy).toBeGreaterThanOrEqual(0.97);
    },
  );

  it.each(allArchetypes().map((a) => [a.id, a.name] as const))(
    '造型 %s 在轻度扫描噪声下分层准确率 ≥ 95%',
    (id) => {
      const arch = allArchetypes().find((a) => a.id === id)!;
      const frame = renderFrame(arch, W, H, 0.3, LIGHT_SCAN_NOISE, 11, standardPegHoles(W, H));
      const result = classifyLayers(frame.image);
      const acc = strokeAccuracy(result.layers.labelRaster.labels, frame.truthLabels.labels);
      expect(acc.accuracy).toBeGreaterThanOrEqual(0.95);
    },
  );

  it('重度噪声（模糊/断笔/椒盐/光照倾斜）下仍保持 ≥ 90%', () => {
    const arch = allArchetypes()[0];
    const frame = renderFrame(arch, W, H, 0.5, HEAVY_SCAN_NOISE, 23, standardPegHoles(W, H));
    const result = classifyLayers(frame.image);
    const acc = strokeAccuracy(result.layers.labelRaster.labels, frame.truthLabels.labels);
    expect(acc.accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('浅红/浅蓝色彩铅不会被当成纸底或墨线', () => {
    const arch = allArchetypes()[2];
    const frame = renderFrame(arch, W, H, 0, LIGHT_SCAN_NOISE, 99, standardPegHoles(W, H));
    const result = classifyLayers(frame.image);
    const pred = result.layers.labelRaster.labels;
    const truth = frame.truthLabels.labels;
    let redTotal = 0;
    let redOk = 0;
    let blueTotal = 0;
    let blueOk = 0;
    for (let i = 0; i < truth.length; i++) {
      if (truth[i] === LayerKind.RedPencil) {
        redTotal++;
        if (pred[i] === LayerKind.RedPencil) redOk++;
      }
      if (truth[i] === LayerKind.BluePencil) {
        blueTotal++;
        if (pred[i] === LayerKind.BluePencil) blueOk++;
      }
    }
    expect(redOk / redTotal).toBeGreaterThan(0.9);
    expect(blueOk / blueTotal).toBeGreaterThan(0.9);
  });
});
