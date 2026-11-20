/**
 * 生成测试样例 PNG（三种造型 × 三档噪声），输出到 samples/。
 * 运行：npm run gen:samples
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { allArchetypes } from '../src/synthetic/archetypes';
import {
  CLEAN,
  LIGHT_SCAN_NOISE,
  HEAVY_SCAN_NOISE,
  renderFrame,
  standardPegHoles,
} from '../src/synthetic/generator';
import { encodePng } from '../src/io/png';
import { writeFileSync } from 'node:fs';

const W = 640;
const H = 880;
const outDir = join(process.cwd(), 'samples');
mkdirSync(outDir, { recursive: true });

const noises = [
  ['clean', CLEAN],
  ['light', LIGHT_SCAN_NOISE],
  ['heavy', HEAVY_SCAN_NOISE],
] as const;

for (const archetype of allArchetypes()) {
  for (const [noiseName, noise] of noises) {
    const frame = renderFrame(archetype, W, H, 0.25, noise, 42, standardPegHoles(W, H));
    const file = join(outDir, `${archetype.id}-${noiseName}.png`);
    writeFileSync(file, encodePng(frame.image));
    console.log(`写入 ${file}`);
  }
}
console.log('完成');
