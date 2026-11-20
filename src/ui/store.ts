import type { RGBImage } from '../core/types';
import type { FramePipelineResult } from '../core/pipeline';
import type { Palette } from '../core/palette';

/** 浏览器端运行时状态（栅格数据不进序列化工程，单独内存持有） */
export interface FrameRuntime {
  sheetId: string;
  shotCode: string;
  frameNo: number;
  source: RGBImage;
  result?: FramePipelineResult;
  /** 当前上色结果（纸白底 + 色块） */
  painted?: RGBImage;
}

export interface AppState {
  frames: FrameRuntime[];
  selectedFrameNo: number | null;
  palettes: Palette[];
  useGpu: boolean;
  activeLayer: 'source' | 'ink' | 'red' | 'blue' | 'label' | 'paint';
}

type Listener = (state: AppState) => void;

class Store {
  private state: AppState = {
    frames: [],
    selectedFrameNo: null,
    palettes: [],
    useGpu: true,
    activeLayer: 'source',
  };
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  update(mut: (s: AppState) => void): void {
    mut(this.state);
    this.emit();
  }

  addFrame(frame: FrameRuntime): void {
    this.update((s) => {
      s.frames.push(frame);
      s.frames.sort((a, b) => a.frameNo - b.frameNo);
      if (s.selectedFrameNo === null) s.selectedFrameNo = frame.frameNo;
    });
  }

  selected(): FrameRuntime | undefined {
    return this.state.frames.find((f) => f.frameNo === this.state.selectedFrameNo);
  }
}

export const store = new Store();
