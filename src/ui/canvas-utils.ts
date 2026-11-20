import type { RGBImage } from '../core/types';

/** ImageBitmap / File -> RGBImage（浏览器侧） */
export async function imageFromFile(file: File): Promise<RGBImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(imageData.data) };
}

export function imageToCanvas(image: RGBImage, canvas: HTMLCanvasElement): void {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  ctx.putImageData(imageData, 0, 0);
}

export function downloadImage(image: RGBImage, filename: string): void {
  const canvas = document.createElement('canvas');
  imageToCanvas(image, canvas);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

/** 客户端事件坐标 -> 图像像素坐标（考虑 CSS 缩放） */
export function eventToPixel(event: MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height);
  return { x, y };
}
