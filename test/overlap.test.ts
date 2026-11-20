import { describe, expect, it } from 'vitest';
import { LayerKind, type RGBImage } from '../src/core/types';
import { classifyLayers } from '../src/core/classify';
import { createImage, drawLine, type RGB } from '../src/core/raster';

/**
 * 构造一条"彩铅压墨"的线段：两侧是确信彩铅，中段被黑墨完全覆盖。
 * 真值标签（测试期望）：整条线都应归到彩铅层。
 */
function makeOverlapCase(color: RGB, w = 120, h = 40): { image: RGBImage; truth: Uint8Array } {
  const image = createImage(w, h);
  const truth = new Uint8Array(w * h).fill(LayerKind.Paper);
  const y = Math.floor(h / 2);
  const ink: RGB = [35, 33, 32];
  const kind = expectedKind(color);
  // 整条线真值都是彩铅；图像上两侧为彩铅、中间 12px 被墨覆盖（真实压墨宽度）
  for (let x = 5; x < 115; x++) drawAt(image, x, y, color, truth, kind);
  // 压墨小节：宽 12px，恢复半径 8 从两侧生长恰好覆盖
  for (let x = 54; x < 66; x++) drawAt(image, x, y, ink, truth, kind);
  return { image, truth };
}

function expectedKind(c: RGB): LayerKind {
  return c[0] > c[2] ? LayerKind.RedPencil : LayerKind.BluePencil;
}

function drawAt(img: RGBImage, x: number, y: number, c: RGB, truth: Uint8Array, kind: LayerKind): void {
  for (let oy = -1; oy <= 1; oy++) {
    const i = (y + oy) * img.width + x;
    const o = i * 4;
    img.data[o] = c[0];
    img.data[o + 1] = c[1];
    img.data[o + 2] = c[2];
    img.data[o + 3] = 255;
    truth[i] = kind;
  }
}

describe('压墨恢复', () => {
  it('红铅压墨段被多源泛洪夺回红铅层', () => {
    const { image, truth } = makeOverlapCase([205, 90, 95]);
    const result = classifyLayers(image);
    const pred = result.layers.labelRaster.labels;
    let overlapTruth = 0;
    let recovered = 0;
    for (let i = 0; i < truth.length; i++) {
      if (truth[i] !== LayerKind.RedPencil) continue;
      overlapTruth++;
      if (pred[i] === LayerKind.RedPencil) recovered++;
    }
    expect(recovered / overlapTruth).toBeGreaterThan(0.95);
    expect(result.recoveredOverlapPixels).toBeGreaterThan(0);
  });

  it('蓝铅压墨段同样恢复，且红蓝不会互相串层', () => {
    const red = makeOverlapCase([90, 110, 210]);
    const result = classifyLayers(red.image);
    const pred = result.layers.labelRaster.labels;
    let blueTruth = 0;
    let blueOk = 0;
    for (let i = 0; i < red.truth.length; i++) {
      if (red.truth[i] !== LayerKind.BluePencil) continue;
      blueTruth++;
      if (pred[i] === LayerKind.BluePencil) blueOk++;
    }
    expect(blueOk / blueTruth).toBeGreaterThan(0.95);
    // 没有任何蓝铅像素被误判成红铅
    for (let i = 0; i < red.truth.length; i++) {
      if (red.truth[i] === LayerKind.BluePencil) expect(pred[i]).not.toBe(LayerKind.RedPencil);
    }
  });

  it('没有相邻彩铅源的纯墨线不会被泛洪吞掉', () => {
    const image = createImage(120, 40);
    drawLine(image, 10, 20, 110, 20, [35, 33, 32], 3);
    const result = classifyLayers(image);
    let ink = 0;
    for (let i = 0; i < result.layers.labelRaster.labels.length; i++) {
      if (result.layers.labelRaster.labels[i] === LayerKind.Ink) ink++;
    }
    expect(ink).toBeGreaterThan(200);
    expect(result.recoveredOverlapPixels).toBe(0);
  });
});
