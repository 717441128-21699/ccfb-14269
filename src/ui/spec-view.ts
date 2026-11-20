import { defaultPalette, parsePalette, serializePalette, toHex, type Palette } from '../core/palette';
import { store } from './store';

export function renderSpecView(root: HTMLElement): void {
  if (store.get().palettes.length === 0) store.update((s) => s.palettes.push(defaultPalette('主角')));
  root.innerHTML = `
    <div class="spec-page">
      <aside class="panel">
        <h3>色指定表</h3>
        <label>角色
          <select id="paletteSelect">
            ${store.get().palettes.map((p) => `<option value="${p.id}">${p.characterName}</option>`).join('')}
          </select>
        </label>
        <div class="row">
          <button id="addPalette">新建角色表</button>
          <button id="exportSpec" class="primary">导出 JSON</button>
        </div>
        <label class="grow">导入色指定表 <input id="importSpec" type="file" accept="application/json" /></label>
        <p class="note">色指定表独立管理，上色页与镜头工程只引用颜色 id，改色后所有帧自动跟随。</p>
      </aside>
      <section class="spec-sheet" id="specSheet"></section>
    </div>`;

  root.querySelector<HTMLSelectElement>('#paletteSelect')!.onchange = renderSheet;
  root.querySelector<HTMLButtonElement>('#addPalette')!.onclick = () => {
    const name = `角色${store.get().palettes.length + 1}`;
    const p = defaultPalette(name);
    p.id = `pal-${Date.now()}`;
    store.update((s) => s.palettes.push(p));
    root.querySelector<HTMLSelectElement>('#paletteSelect')!.innerHTML = store
      .get()
      .palettes.map((x) => `<option value="${x.id}">${x.characterName}</option>`)
      .join('');
    renderSheet();
  };
  root.querySelector<HTMLButtonElement>('#exportSpec')!.onclick = exportSpec;
  root.querySelector<HTMLInputElement>('#importSpec')!.onchange = importSpec;
  renderSheet();
}

function currentPalette(): Palette {
  const id = document.querySelector<HTMLSelectElement>('#paletteSelect')!.value;
  return store.get().palettes.find((p) => p.id === id) ?? store.get().palettes[0];
}

function renderSheet(): void {
  const palette = currentPalette();
  const sheet = document.querySelector<HTMLElement>('#specSheet');
  if (!sheet) return;
  sheet.innerHTML = `
    <h2>${palette.characterName} · 色指定</h2>
    <table class="spec-table">
      <thead><tr><th>色名</th><th>基色</th><th>阴影色</th><th>高光色</th><th>操作</th></tr></thead>
      <tbody>
        ${palette.colors
          .map(
            (c) => `
          <tr data-color="${c.id}">
            <td><input class="name-input" value="${c.name}" /></td>
            <td><input type="color" class="base" value="${toHex(c.base)}" /></td>
            <td><input type="color" class="shadow" value="${toHex(c.shadow)}" /></td>
            <td><input type="color" class="highlight" value="${toHex(c.highlight)}" /></td>
            <td><button class="del-color">删除</button></td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <button id="addColor" class="primary">新增颜色</button>`;

  sheet.querySelectorAll<HTMLTableRowElement>('tr[data-color]').forEach((row) => {
    const color = palette.colors.find((c) => c.id === row.dataset.color)!;
    row.querySelector<HTMLInputElement>('.name-input')!.oninput = (e) => {
      color.name = (e.target as HTMLInputElement).value;
    };
    (['base', 'shadow', 'highlight'] as const).forEach((role) => {
      row.querySelector<HTMLInputElement>(`.${role}`)!.oninput = (e) => {
        const hex = (e.target as HTMLInputElement).value;
        const v = parseInt(hex.slice(1), 16);
        color[role] = { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 255 };
      };
    });
    row.querySelector<HTMLButtonElement>('.del-color')!.onclick = () => {
      store.update((s) => {
        const p = s.palettes.find((x) => x.id === palette.id)!;
        p.colors = p.colors.filter((x) => x.id !== color.id);
      });
      renderSheet();
    };
  });
  sheet.querySelector<HTMLButtonElement>('#addColor')!.onclick = () => {
    store.update((s) => {
      const p = s.palettes.find((x) => x.id === palette.id)!;
      p.colors.push({
        id: `color-${Date.now()}`,
        name: '新颜色',
        base: { r: 200, g: 200, b: 200, a: 255 },
        shadow: { r: 150, g: 150, b: 150, a: 255 },
        highlight: { r: 235, g: 235, b: 235, a: 255 },
      });
    });
    renderSheet();
  };
}

function exportSpec(): void {
  const text = serializePalette(currentPalette());
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentPalette().characterName}-色指定.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importSpec(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const palette = parsePalette(await file.text());
  store.update((s) => {
    const idx = s.palettes.findIndex((p) => p.id === palette.id);
    if (idx >= 0) s.palettes[idx] = palette;
    else s.palettes.push(palette);
  });
  renderSheet();
}
