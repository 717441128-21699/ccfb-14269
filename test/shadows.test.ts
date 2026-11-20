import { describe, expect, it } from 'vitest';
import { LayerKind } from '../src/core/types';
import { createLabelRaster, drawLine } from '../src/core/raster';
import { proposeShadows, overrideRegionKind } from '../src/core/shadows';
import { classifyLayers } from '../src/core/classify';
import { moeArchetype } from '../src/synthetic/archetypes';
import { LIGHT_SCAN_NOISE, renderFrame, standardPegHoles } from '../src/synthetic/generator';

/** 构造一个被分界线切成两半的闭合方块 */
function splitSquare(dividerKind: LayerKind) {
  const W = 120;
  const H = 120;
  const lab = createLabelRaster(W, H, LayerKind.Paper);
  const box = [
    { x: 20, y: 20 },
    { x: 100, y: 20 },
    { x: 100, y: 100 },
    { x: 20, y: 100 },
  ];
  for (let i = 0; i < box.length; i++) {
    const a = box[i];
    const b = box[(i + 1) % box.length];
    drawLine(lab, a.x, a.y, b.x, b.y, LayerKind.Ink, 2);
  }
  drawLine(lab, 60, 24, 60, 96, dividerKind, 2);
  return lab;
}

describe('阴影/高光提案', () => {
  it('红铅分界线两侧生成子区域，相邻侧标记为 shadow', () => {
    const lab = splitSquare(LayerKind.RedPencil);
    const proposal = proposeShadows(lab);
    const kinds = [...proposal.kind.values()];
    expect(kinds.filter((k) => k === 'shadow').length).toBeGreaterThan(0);
    let shadowPixels = 0;
    for (let i = 0; i < proposal.shadow.ids.length; i++) {
      if (proposal.shadow.ids[i] !== 0) shadowPixels++;
    }
    expect(shadowPixels).toBeGreaterThan(100);
  });

  it('蓝铅分界线相邻侧标记为 highlight，蓝铅优先于红铅', () => {
    const lab = splitSquare(LayerKind.BluePencil);
    const proposal = proposeShadows(lab);
    const kinds = [...proposal.kind.values()];
    expect(kinds.filter((k) => k === 'highlight').length).toBeGreaterThan(0);
  });

  it('手动改判可以把阴影区改成基色区', () => {
    const lab = splitSquare(LayerKind.RedPencil);
    const proposal = proposeShadows(lab);
    const shadowId = [...proposal.kind.entries()].find(([, k]) => k === 'shadow')![0];
    const updated = overrideRegionKind(proposal, shadowId, 'base');
    expect(updated.kind.get(shadowId)).toBe('base');
    expect(updated.shadow.ids.some((v) => v === shadowId)).toBe(false);
  });

  it('完整合成帧上阴影与高光区域都能被提出', () => {
    const frame = renderFrame(
      moeArchetype(),
      480,
      640,
      0.2,
      LIGHT_SCAN_NOISE,
      3,
      standardPegHoles(480, 640),
    );
    const result = classifyLayers(frame.image);
    const proposal = proposeShadows(result.layers.labelRaster);
    const counts = { shadow: 0, highlight: 0, base: 0 };
    for (const k of proposal.kind.values()) counts[k]++;
    expect(counts.shadow + counts.highlight).toBeGreaterThan(0);
  });
});
