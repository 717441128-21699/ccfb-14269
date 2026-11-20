import { describe, expect, it } from 'vitest';
import { LayerKind } from '../src/core/types';
import { createLabelRaster, drawLine } from '../src/core/raster';
import { buildBarrierMask } from '../src/core/classify';
import { buildRegionMap, floodFillPixels, paintMask } from '../src/core/regions';

describe('闭合区域与点击填色', () => {
  it('墨线方框内部形成单个可填充区域，外部不会漏色', () => {
    const W = 100;
    const H = 100;
    const lab = createLabelRaster(W, H, LayerKind.Paper);
    const box = [
      [20, 20],
      [80, 20],
      [80, 80],
      [20, 80],
    ] as const;
    for (let i = 0; i < box.length; i++) {
      const a = box[i];
      const b = box[(i + 1) % box.length];
      drawLine(lab, a[0], a[1], b[0], b[1], LayerKind.Ink, 2);
    }
    const barrier = buildBarrierMask(lab);
    const map = buildRegionMap(barrier, W, H);
    // 至少两个区域：框内 + 框外
    expect(map.areas.length - 1).toBeGreaterThanOrEqual(2);

    const inside = floodFillPixels(barrier, W, H, 50, 50);
    expect(inside.length).toBeGreaterThan(50 * 50 * 0.5);
    // 框内泛洪不会越过墨线
    expect(inside).not.toContain(0); // 左上角属于外部
    expect(inside).toContain(50 * W + 50);

    const painted = { data: new Uint8Array(W * H * 4).fill(255) };
    const mask = new Uint8Array(W * H);
    for (const i of inside) mask[i] = 1;
    paintMask(painted, mask, { r: 255, g: 0, b: 0, a: 255 });
    const outsideIdx = 2 * W + 2;
    expect(painted.data[outsideIdx * 4]).toBe(255); // 外部保持白
    const insideIdx = 50 * W + 50;
    expect(painted.data[insideIdx * 4]).toBe(255); // 内部变红
    expect(painted.data[insideIdx * 4 + 1]).toBe(0);
  });

  it('点在屏障线上时返回空，不产生填充', () => {
    const W = 40;
    const H = 40;
    const barrier = new Uint8Array(W * H);
    for (let x = 5; x < 35; x++) barrier[20 * W + x] = 1;
    const pixels = floodFillPixels(barrier, W, H, 10, 20);
    expect(pixels).toEqual([]);
  });
});
