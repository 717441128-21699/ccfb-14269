import { describe, expect, it } from 'vitest';
import { detectPegHoles, estimateRegistration, warpImage } from '../src/core/holes';
import { createImage, fillCircle, type RGB } from '../src/core/raster';
import { moeArchetype } from '../src/synthetic/archetypes';
import { LIGHT_SCAN_NOISE, renderFrame, standardPegHoles } from '../src/synthetic/generator';

const INK: RGB = [30, 30, 30];

describe('定位孔检测与配准', () => {
  it('从标准三孔合成图检出全部定位孔', () => {
    const W = 480;
    const H = 640;
    const frame = renderFrame(moeArchetype(), W, H, 0, LIGHT_SCAN_NOISE, 5, standardPegHoles(W, H));
    const holes = detectPegHoles(frame.image);
    expect(holes.length).toBe(3);
    const expected = standardPegHoles(W, H);
    const found = [...holes].sort((a, b) => a.centroid.x - b.centroid.x);
    const want = [...expected].sort((a, b) => a.x - b.x);
    for (let i = 0; i < 3; i++) {
      expect(Math.hypot(found[i].centroid.x - want[i].x, found[i].centroid.y - want[i].y)).toBeLessThan(6);
    }
  });

  it('对平移后的扫描纸估计仿射并对齐回参考位置', () => {
    const W = 320;
    const H = 420;
    const ref = createImage(W, H);
    const pegs = [
      { x: 110, y: H - 60, r: 12 },
      { x: 160, y: H - 60, r: 12 },
      { x: 210, y: H - 60, r: 12 },
    ];
    for (const p of pegs) fillCircle(ref, p.x, p.y, p.r, INK);
    const refHoles = detectPegHoles(ref);
    expect(refHoles.length).toBe(3);

    // 整张纸平移 (+14, -9)
    const shifted = createImage(W, H);
    for (const p of pegs) fillCircle(shifted, p.x + 14, p.y - 9, p.r, INK);
    const reg = estimateRegistration(shifted, refHoles);
    expect(reg.holes.length).toBe(3);
    expect(reg.transform.e).toBeCloseTo(-14, 0);
    expect(reg.transform.f).toBeCloseTo(9, 0);

    const warped = warpImage(shifted, reg.transform);
    // 对齐后孔心应回到参考位置（在参考孔附近找到暗像素）
    const target = pegs[1];
    let darkNear = 0;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = target.x + dx;
        const y = target.y + dy;
        const o = (y * W + x) * 4;
        if (warped.data[o] < 100) darkNear++;
      }
    }
    expect(darkNear).toBeGreaterThan(20);
  });

  it('找不到孔时退化为单位变换而不是抛异常', () => {
    const blank = createImage(200, 200);
    const reg = estimateRegistration(blank, undefined);
    expect(reg.transform.a).toBe(1);
    expect(reg.holes.length).toBe(0);
  });
});
