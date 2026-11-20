import { type ColorRGBA } from '../core/types';
import { createImage } from '../core/raster';
import { floodFillPixels, paintMask } from '../core/regions';
import { maskOfKind, overrideRegionKind } from '../core/shadows';
import { defaultPalette } from '../core/palette';
import { imageToCanvas, eventToPixel } from './canvas-utils';
import { store } from './store';

const SHADOW_COLOR: ColorRGBA = { r: 120, g: 90, b: 160, a: 190 };
const HIGHLIGHT_COLOR: ColorRGBA = { r: 180, g: 230, b: 255, a: 190 };

export function renderPaintView(root: HTMLElement): void {
  if (store.get().palettes.length === 0) store.update((s) => s.palettes.push(defaultPalette('主角')));
  const palette = store.get().palettes[0];
  root.innerHTML = `
    <div class="workspace">
      <aside class="panel">
        <h3>上色（镜头 S001_C001）</h3>
        <p class="note">在闭合区域内点击即填色；红铅围出的区域可一键自动填阴影色，蓝铅区域填高光色。</p>
        <div class="row">
          <button id="autoShadow" class="primary">自动阴影/高光</button>
          <button id="clearPaint">清空填色</button>
        </div>
        <h3>颜色（取自色指定表）</h3>
        <div id="colorChips" class="chips">
          ${palette.colors
            .map(
              (c) => `
            <button class="chip" data-color="${c.id}" title="${c.name}">
              <i style="background:${hex(c.base)}"></i><b>${c.name}</b>
            </button>`,
            )
            .join('')}
        </div>
        <h3>手动改判</h3>
        <div class="row">
          <button data-kind="base">设为基色区</button>
          <button data-kind="shadow">设为阴影区</button>
          <button data-kind="highlight">设为高光区</button>
        </div>
        <div id="paintInfo" class="metrics"></div>
        <h3>帧间沿用</h3>
        <div id="trackInfo" class="metrics"></div>
      </aside>
      <section class="canvas-wrap">
        <div class="frame-strip" id="frameStrip"></div>
        <canvas id="paintCanvas" width="640" height="880" style="cursor: crosshair"></canvas>
        <div id="hint" class="hint"></div>
      </section>
    </div>`;

  root.querySelector<HTMLButtonElement>('#autoShadow')!.onclick = autoFillShadows;
  root.querySelector<HTMLButtonElement>('#clearPaint')!.onclick = clearPaint;
  root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => {
    b.onclick = () => overrideKind(b.dataset.kind as 'base' | 'shadow' | 'highlight');
  });
  root.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
    chip.onclick = () => {
      const spec = palette.colors.find((c) => c.id === chip.dataset.color)!;
      selectedColor = { ...spec.base, a: 255 };
      setHint(`已选颜色：${spec.name}`);
    };
  });

  let selectedColor: ColorRGBA = { ...palette.colors[0].base, a: 255 };

  const canvas = root.querySelector<HTMLCanvasElement>('#paintCanvas')!;
  canvas.onclick = (e) => {
    const frame = store.selected();
    if (!frame?.result) return setHint('请先在描线页处理该帧');
    const { x, y } = eventToPixel(e, canvas);
    const pixels = floodFillPixels(frame.result.barrier, canvas.width, canvas.height, x, y);
    if (pixels.length === 0) return setHint('这里不是闭合区域（点在线条或纸外）');
    ensurePainted(frame.frameNo);
    const mask = new Uint8Array(canvas.width * canvas.height);
    for (const i of pixels) mask[i] = 1;
    const target = store.get().frames.find((f) => f.frameNo === frame.frameNo)!.painted!;
    paintMask(target, mask, selectedColor);
    imageToCanvas(target, canvas);
    document.querySelector<HTMLElement>('#paintInfo')!.innerHTML = `
      填充区域 <b>${pixels.length.toLocaleString()}</b> px（种子 ${x}, ${y}）`;
  };

  const unsub = store.subscribe(() => {
    renderStrip();
    redraw();
    renderTrackInfo();
  });
  root.addEventListener('dispose-view', () => unsub());
  renderStrip();
  redraw();
  renderTrackInfo();
}

function ensurePainted(frameNo: number): void {
  const frame = store.get().frames.find((f) => f.frameNo === frameNo);
  if (!frame?.result) return;
  if (!frame.painted) frame.painted = createImage(frame.result.alignedImage.width, frame.result.alignedImage.height, [255, 255, 255]);
}

function autoFillShadows(): void {
  const frame = store.selected();
  if (!frame?.result) return setHint('请先在描线页处理该帧');
  ensurePainted(frame.frameNo);
  const target = frame.painted!;
  const proposal = frame.result.shadowProposal;
  paintMask(target, maskOfKind(proposal, 'shadow'), SHADOW_COLOR);
  paintMask(target, maskOfKind(proposal, 'highlight'), HIGHLIGHT_COLOR);
  redraw();
  const shadowCount = [...proposal.kind.values()].filter((k) => k === 'shadow').length;
  const highCount = [...proposal.kind.values()].filter((k) => k === 'highlight').length;
  setHint(`自动填入 ${shadowCount} 个阴影区、${highCount} 个高光区`);
}

function clearPaint(): void {
  const frame = store.selected();
  if (!frame?.result) return;
  frame.painted = createImage(frame.result.alignedImage.width, frame.result.alignedImage.height, [255, 255, 255]);
  redraw();
}

function overrideKind(kind: 'base' | 'shadow' | 'highlight'): void {
  const frame = store.selected();
  if (!frame?.result) return;
  // 对面积最大的非基色区域改判（演示手动纠错路径；生产版点击具体区域）
  const proposal = frame.result.shadowProposal;
  let targetId = -1;
  let best = Infinity;
  for (const [rid, k] of proposal.kind) {
    if (k === kind) continue;
    const area = proposal.shadow.areas[rid];
    if (area < best) {
      best = area;
      targetId = rid;
    }
  }
  if (targetId < 0) return setHint('没有需要改判的区域');
  frame.result.shadowProposal = overrideRegionKind(proposal, targetId, kind);
  setHint(`区域 #${targetId} 已改判为「${kind === 'base' ? '基色区' : kind === 'shadow' ? '阴影区' : '高光区'}」`);
}

function renderStrip(): void {
  const strip = document.querySelector<HTMLElement>('#frameStrip');
  if (!strip) return;
  strip.innerHTML = store
    .get()
    .frames.map(
      (f) =>
        `<button class="frame-thumb ${f.frameNo === store.get().selectedFrameNo ? 'active' : ''}" data-frame="${f.frameNo}">
          <span>#${f.frameNo}</span>${f.result ? '<em>✓</em>' : ''}
        </button>`,
    )
    .join('');
  strip.querySelectorAll<HTMLButtonElement>('.frame-thumb').forEach((b) => {
    b.onclick = () => store.update((s) => (s.selectedFrameNo = Number(b.dataset.frame)));
  });
}

function redraw(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#paintCanvas');
  const frame = store.selected();
  if (!canvas || !frame) return;
  if (frame.painted) imageToCanvas(frame.painted, canvas);
  else if (frame.result) imageToCanvas(frame.result.alignedImage, canvas);
  else canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
}

function renderTrackInfo(): void {
  const el = document.querySelector<HTMLElement>('#trackInfo');
  const frame = store.selected();
  if (!el || !frame?.result?.track) {
    if (el) el.innerHTML = '首帧或未处理：尚无帧间对应数据';
    return;
  }
  const t = frame.result.track;
  const unchanged = [...t.matches.values()].filter((m) => m.unchanged).length;
  el.innerHTML = `
    对应轨道 <b>${t.matches.size}</b> 条<br/>
    未动区域（直接沿用上张颜色）：<b>${unchanged}</b><br/>
    新轨道：${t.newTrackIds.length} · 消失：${t.droppedTrackIds.length}<br/>
    帧差像素：${t.diffMask.reduce((s, v) => s + v, 0).toLocaleString()}`;
}

function hex(c: ColorRGBA): string {
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function setHint(text: string): void {
  const el = document.querySelector<HTMLElement>('#hint');
  if (el) el.textContent = text;
}
