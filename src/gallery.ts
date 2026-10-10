import './ui/base.css';
import './ui/gallery.css';
import { DEMOS, TIERS, type DemoInfo } from './demos';

const REPO = 'https://github.com/monjar/Advanced-Procedural-Animations-Study';

function card(demo: DemoInfo): HTMLElement {
  const live = demo.status === 'live';
  const el = document.createElement(live ? 'a' : 'div');
  el.className = `card ${demo.status}`;
  if (live) (el as HTMLAnchorElement).href = `demos/${demo.slug}/`;
  el.innerHTML = `
    <span class="num">${demo.id}</span>
    <span class="status ${demo.status}">${live ? 'live' : 'planned'}</span>
    <h3></h3>
    <p></p>
    <div class="tags"></div>`;
  el.querySelector('h3')!.textContent = demo.title;
  el.querySelector('p')!.textContent = demo.summary;
  const tags = el.querySelector('.tags')!;
  for (const t of demo.tags) {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = t;
    tags.appendChild(span);
  }
  return el;
}

const app = document.querySelector<HTMLElement>('#app')!;
app.className = 'gallery';
app.innerHTML = `
  <header class="hero">
    <h1>Procedural Animation Studies</h1>
    <p>Interactive 3D studies in procedural, data-driven, physics-based and learned character animation —
      from inverse kinematics and springs to motion matching, reinforcement learning and LLM-directed motion.</p>
    <nav>
      <a href="${REPO}">Source</a>
      <a href="${REPO}/blob/master/ROADMAP.md">Roadmap</a>
    </nav>
  </header>`;

for (const tier of TIERS) {
  const section = document.createElement('section');
  section.className = 'tier';
  const h2 = document.createElement('h2');
  h2.textContent = tier;
  const grid = document.createElement('div');
  grid.className = 'cards';
  for (const demo of DEMOS.filter((d) => d.tier === tier)) grid.appendChild(card(demo));
  section.append(h2, grid);
  app.appendChild(section);
}
