import { PNG } from 'pngjs';
import type { RGBImage } from '../core/types';

/** Node 侧 PNG 解码（测试与样例生成脚本使用；浏览器走 canvas/ImageBitmap） */
export function decodePng(buffer: Uint8Array): RGBImage {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function encodePng(image: RGBImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png);
}

export function writePng(image: RGBImage, path: string): void {
  // 延迟引入 node:fs，保证本模块不会被浏览器包打进去
  const fs = require('node:fs') as typeof import('node:fs');
  fs.writeFileSync(path, encodePng(image));
}
