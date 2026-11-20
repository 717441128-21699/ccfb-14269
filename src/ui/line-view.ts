import { AnimationPipeline } from '../core/pipeline';
import { DEFAULT_CLASSIFICATION, LayerKind, type RGBImage } from '../core/types';
import { DEFAULT_SHADOW_OPTIONS } from '../core/shadows';
import { allArchetypes, getArchetype } from '../synthetic/archetypes';
import {
  CLEAN,
  LIGHT_SCAN_NOISE,
  HEAVY_SCAN_NOISE,
  renderFrame,
  standardPegHoles,
  type NoiseModel,
} from '../synthetic/generator';
import { imageFromFile, imageToCanvas, downloadImage } from './canvas-utils';
import { store } from './store';
import { GLEngine } from '../gl/engine';

const CANVAS_W = 640;
const CANVAS_H = 880;

const NOISE_LEVELS: Array<{ name: string; model: NoiseModel }> = [
  { name: '干净', model: CLEAN },
  { name: '轻度扫描噪声', model: LIGHT_SCAN_NOISE },
  { name: '重度扫描噪声', model: HEAVY_SCAN_NOISE },
];

type AppLayer = 'source' | 'ink' | 'red' | 'blue' | 'label' | 'paint';

let pipeline = new AnimationPipeline({
  classification: { ...DEFAULT_CLASSIFICATION },
  shadow: { ...DEFAULT_SHADOW_OPTIONS },
});
let glEngine: GLEngine | null = null;

function engine(): GLEngine | null {
  if (!store.get().useGpu || !GLEngine.isSupported()) return null;
  if (!glEngine) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    glEngine = new GLEngine(canvas);
  }
  return glEngine;
}

export function renderLineView(root: HTMLElement): void {
  root.innerHTML = `
    <div class="workspace">
      <aside class="panel">
        <h3>测试线稿生成</h3>
        <label>造型
          <select id="archetype">${allArchetypes().map((a) => `<option value="${a.id}">${a.name}</option>`).join('')}</select>
        </label>
        <label>扫描噪声
          <select id="noise">${NOISE_LEVELS.map((n, i) => `<option value="${i}">${n.name}</option>`).join('')}</select>
        </label>
        <div class="row">
          <label class="grow">帧数 <input id="frameCount" type="number" value="6" min="1" max="24" /></label>
          <button id="genBtn" class="primary">生成序列</button>
        </div>
        <h3>真实扫描件</h3>
        <input id="fileInput" type="file" accept="image/*" multiple />
        <h3>处理</h3>
        <label class="check"><input type="checkbox" id="gpuToggle" ${store.get().useGpu ? 'checked' : ''}/> WebGL2 加速</label>
        <button id="runBtn" class="primary">分层处理选中帧</button>
        <button id="runAllBtn">整卡批处理</button>
        <div id="metrics" class="metrics"></div>
        <h3>图层显示</h3>
        <div id="layerButtons" class="layer-grid">
          ${([
            ['source', '原图'],
            ['ink', '墨线层'],
            ['red', '红铅阴影'],
            ['blue', '蓝铅高光'],
            ['label', '标签总览'],
            ['paint', '上色预览'],
          ] as Array<[AppLayer, string]>)
            .map(([id, name]) => `<button data-layer="${id}">${name}</button>`)
            .join('')}
        </div>
        <button id="exportBtn">导出当前图层 PNG</button>
      </aside>
      <section class="canvas-wrap">
        <div class="frame-strip" id="frameStrip"></div>
        <canvas id="mainCanvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
        <div id="hint" class="hint"></div>
      </section>
    </div>`;

  root.querySelector<HTMLButtonElement>('#genBtn')!.onclick = generateSequence;
  root.querySelector<HTMLButtonElement>('#runBtn')!.onclick = () => void runSelected();
  root.querySelector<HTMLButtonElement>('#runAllBtn')!.onclick = () => void runAll();
  root.querySelector<HTMLInputElement>('#gpuToggle')!.onchange = (e) => {
    store.update((s) => (s.useGpu = (e.target as HTMLInputElement).checked));
  };
  root.querySelector<HTMLInputElement>('#fileInput')!.onchange = (e) => void loadFiles(e);
  root.querySelector<HTMLButtonElement>('#exportBtn')!.onclick = exportLayer;
  root.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((btn) => {
    btn.onclick = () => {
      store.update((s) => (s.activeLayer = btn.dataset.layer as AppLayer));
      refreshCanvas();
    };
  });

  const unsub = store.subscribe(() => {
    renderFrameStrip();
    refreshCanvas();
  });
  root.addEventListener('dispose-view', () => unsub());
  renderFrameStrip();
  refreshCanvas();
}

function generateSequence(): void {
  const archId = document.querySelector<HTMLSelectElement>('#archetype')!.value;
  const noiseIdx = Number(document.querySelector<HTMLSelectElement>('#noise')!.value);
  const count = Number(document.querySelector<HTMLInputElement>('#frameCount')!.value);
  const archetype = getArchetype(archId);
  const noise = NOISE_LEVELS[noiseIdx].model;
  const pegs = standardPegHoles(CANVAS_W, CANVAS_H);
  pipeline.reset();
  store.update((s) => {
    s.frames = [];
    s.selectedFrameNo = null;
  });
  for (let f = 0; f < count; f++) {
    const t = count <= 1 ? 0 : f / (count - 1);
    const generated = renderFrame(archetype, CANVAS_W, CANVAS_H, t, noise, 42 + f, pegs);
    store.addFrame({
      sheetId: `${archId}-${f}`,
      shotCode: 'S001_C001',
      frameNo: f + 1,
      source: generated.image,
    });
  }
  setHint(`已生成 ${count} 帧「${archetype.name}」测试线稿（${NOISE_LEVELS[noiseIdx].name}）`);
}

async function loadFiles(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  pipeline.reset();
  let idx = store.get().frames.length;
  for (const file of Array.from(input.files)) {
    const image = await imageFromFile(file);
    store.addFrame({ sheetId: file.name, shotCode: 'S001_C001', frameNo: ++idx, source: image });
  }
  setHint(`已导入 ${input.files.length} 张扫描件`);
}

async function runSelected(): Promise<void> {
  const frame = store.selected();
  if (!frame) return setHint('请先选择一帧');
  const gpu = engine();
  const t0 = performance.now();
  const result = pipeline.process(frame.source, frame.frameNo);
  let gpuMs: number | null = null;
  if (gpu) {
    const t1 = performance.now();
    gpu.classifyGPU(frame.source);
    gpuMs = performance.now() - t1;
  }
  const elapsed = performance.now() - t0;
  frame.result = result;
  const c = result.classification.counts;
  const timingRows = Object.entries(result.timings)
    .map(([k, v]) => `${k}: ${v.toFixed(1)}ms`)
    .join(' · ');
  document.querySelector<HTMLElement>('#metrics')!.innerHTML = `
    <b>端到端</b>：${elapsed.toFixed(1)} ms（目标 &lt; 2000ms）<br/>
    ${gpuMs !== null ? `<b>GPU 分层</b>：${gpuMs.toFixed(1)} ms<br/>` : ''}
    <small>${timingRows}</small><br/>
    <b>墨线</b>：${c[LayerKind.Ink].toLocaleString()} px ·
    <b>红铅</b>：${c[LayerKind.RedPencil].toLocaleString()} px ·
    <b>蓝铅</b>：${c[LayerKind.BluePencil].toLocaleString()} px<br/>
    <b>压墨恢复</b>：${result.classification.recoveredOverlapPixels.toLocaleString()} px<br/>
    <b>闭合区域</b>：${result.regionMap.areas.length - 1} 个 ·
    <b>配准孔</b>：${result.holes.length} 个`;
  store.update((s) => (s.activeLayer = 'label'));
}

async function runAll(): Promise<void> {
  const t0 = performance.now();
  for (const frame of store.get().frames) {
    frame.result = pipeline.process(frame.source, frame.frameNo);
  }
  const elapsed = performance.now() - t0;
  setHint(
    `整卡 ${store.get().frames.length} 帧处理完成，总耗时 ${elapsed.toFixed(0)} ms，均帧 ${(
      elapsed / Math.max(1, store.get().frames.length)
    ).toFixed(1)} ms`,
  );
  refreshCanvas();
}

function renderFrameStrip(): void {
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

function refreshCanvas(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#mainCanvas');
  if (!canvas) return;
  const frame = store.selected();
  const ctx = canvas.getContext('2d')!;
  if (!frame) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const layer = store.get().activeLayer;
  if (layer === 'source' || !frame.result) return imageToCanvas(frame.source, canvas);
  const r = frame.result;
  if (layer === 'ink') return imageToCanvas(r.classification.layers.ink, canvas);
  if (layer === 'red') return imageToCanvas(r.classification.layers.red, canvas);
  if (layer === 'blue') return imageToCanvas(r.classification.layers.blue, canvas);
  if (layer === 'paint') return imageToCanvas(frame.painted ?? r.alignedImage, canvas);
  renderLabelOverview(canvas, r.labelRaster.labels, r.labelRaster.width, r.labelRaster.height);
}

function renderLabelOverview(canvas: HTMLCanvasElement, labels: Uint8Array, w: number, h: number): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const palette: Record<number, [number, number, number]> = {
    [LayerKind.Paper]: [252, 250, 246],
    [LayerKind.Ink]: [20, 20, 20],
    [LayerKind.RedPencil]: [220, 60, 60],
    [LayerKind.BluePencil]: [60, 90, 220],
    [LayerKind.PegHole]: [40, 160, 90],
  };
  for (let i = 0; i < labels.length; i++) {
    const c = palette[labels[i]] ?? palette[LayerKind.Paper];
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function exportLayer(): void {
  const frame = store.selected();
  if (!frame?.result) return setHint('没有可导出的图层');
  const layer = store.get().activeLayer;
  const map: Record<AppLayer, RGBImage> = {
    ink: frame.result.classification.layers.ink,
    red: frame.result.classification.layers.red,
    blue: frame.result.classification.layers.blue,
    source: frame.source,
    label: frame.result.alignedImage,
    paint: frame.painted ?? frame.result.alignedImage,
  };
  downloadImage(map[layer], `frame${frame.frameNo}-${layer}.png`);
}

function setHint(text: string): void {
  const el = document.querySelector<HTMLElement>('#hint');
  if (el) el.textContent = text;
}
