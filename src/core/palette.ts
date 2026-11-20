import type { ColorRGBA } from './types';

/** 色指定表：一个角色一套，色名对应基色/阴影色/高光色三件套 */
export interface ColorSpec {
  id: string;
  /** 色名，例如"皮肤""头发""制服红" */
  name: string;
  base: ColorRGBA;
  shadow: ColorRGBA;
  highlight: ColorRGBA;
}

export interface Palette {
  id: string;
  characterName: string;
  colors: ColorSpec[];
  updatedAt: number;
}

export function rgba(hex: string, a = 255): ColorRGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`非法颜色值: ${hex}`);
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a };
}

export function toHex(c: ColorRGBA): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function defaultPalette(characterName: string): Palette {
  return {
    id: `pal-${characterName}`,
    characterName,
    updatedAt: 0,
    colors: [
      { id: 'skin', name: '皮肤', base: rgba('#f6d2b8'), shadow: rgba('#d9a07c'), highlight: rgba('#ffe9d8') },
      { id: 'hair', name: '头发', base: rgba('#3a2e2a'), shadow: rgba('#221815'), highlight: rgba('#6b5750') },
      { id: 'cloth', name: '衣服主色', base: rgba('#3b6ea5'), shadow: rgba('#274b73'), highlight: rgba('#7fa3cc') },
    ],
  };
}

/** 色指定表导出（A4 色指定页可另存 JSON，供上色组按镜头引用） */
export function serializePalette(p: Palette): string {
  return JSON.stringify(p, null, 2);
}

export function parsePalette(text: string): Palette {
  const p = JSON.parse(text) as Palette;
  if (!p.id || !Array.isArray(p.colors)) throw new Error('色指定表格式不正确');
  return p;
}
