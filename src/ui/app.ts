import { renderLineView } from './line-view';
import { renderPaintView } from './paint-view';
import { renderSpecView } from './spec-view';

const view = document.querySelector<HTMLElement>('#view')!;
const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');

function mount(render: (root: HTMLElement) => void): void {
  view.dispatchEvent(new CustomEvent('dispose-view'));
  view.innerHTML = '';
  render(view);
}

tabs.forEach((tab) => {
  tab.onclick = () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    const name = tab.dataset.tab;
    if (name === 'line') mount(renderLineView);
    else if (name === 'paint') mount(renderPaintView);
    else mount(renderSpecView);
  };
});

mount(renderLineView);
