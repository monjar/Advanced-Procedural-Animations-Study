import { marked } from 'marked';
import './base.css';
import './demo.css';
import { demoById } from '../demos';
import type { App } from '../core/app';

export interface DemoFrameOptions {
  id: string;
  /** Markdown write-up, typically the demo's README.md imported with `?raw`. */
  writeup?: string;
  /** Short interaction hint shown at the bottom of the screen. */
  hint?: string;
}

export interface DemoFrame {
  viewport: HTMLElement;
  controls: HTMLElement;
  /** Add a titled panel (e.g. a plot) to the top of the controls column. Returns its body element. */
  addPanel(title: string): HTMLElement;
  /** Keep the app's camera centred in the screen area not covered by the side panels. */
  attach(app: App): void;
}

const WRITEUP_KEY = 'pas.writeup-open';

function loadWriteupOpen(): boolean {
  try {
    const v = localStorage.getItem(WRITEUP_KEY);
    if (v !== null) return v === '1';
  } catch {
    // storage unavailable (private mode, sandbox): fall through to default
  }
  return window.innerWidth >= 1280;
}

function saveWriteupOpen(open: boolean): void {
  try {
    localStorage.setItem(WRITEUP_KEY, open ? '1' : '0');
  } catch {
    // ignore
  }
}

export function createDemoFrame(options: DemoFrameOptions): DemoFrame {
  const info = demoById(options.id);
  document.title = `${info.id} · ${info.title} — Procedural Animation Studies`;
  document.body.classList.add('demo');

  const viewport = document.createElement('div');
  viewport.className = 'viewport';

  const header = document.createElement('header');
  header.className = 'demo-header';
  header.innerHTML = `
    <a class="back" href="../../">← All studies</a>
    <h1><span class="num">${info.id}</span><span class="title"></span></h1>
    <p class="summary"></p>
    <div class="actions"></div>`;
  header.querySelector('.title')!.textContent = info.title;
  header.querySelector('.summary')!.textContent = info.summary;

  const controls = document.createElement('aside');
  controls.className = 'controls';

  document.body.append(viewport, header, controls);

  let writeupPanel: HTMLElement | undefined;
  let attached: App | undefined;
  const updateInsets = () => {
    if (!attached) return;
    const wide = window.innerWidth >= 900;
    const left = writeupPanel && !writeupPanel.hidden && wide ? writeupPanel.getBoundingClientRect().right : 0;
    const right = wide ? window.innerWidth - controls.getBoundingClientRect().left : 0;
    attached.setInsets(left, right);
  };
  window.addEventListener('resize', updateInsets);

  if (options.writeup) {
    const panel = document.createElement('aside');
    panel.className = 'writeup prose';
    panel.innerHTML = marked.parse(options.writeup, { async: false });
    for (const a of panel.querySelectorAll('a[href^="http"]')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }

    const toggle = document.createElement('button');
    toggle.className = 'btn';
    toggle.textContent = 'Write-up';
    const set = (open: boolean) => {
      panel.hidden = !open;
      toggle.setAttribute('aria-pressed', String(open));
      saveWriteupOpen(open);
      updateInsets();
    };
    toggle.addEventListener('click', () => set(Boolean(panel.hidden)));
    set(loadWriteupOpen());

    header.querySelector('.actions')!.appendChild(toggle);
    document.body.appendChild(panel);
    writeupPanel = panel;
  }

  if (options.hint) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = options.hint;
    document.body.appendChild(hint);
  }

  return {
    viewport,
    controls,
    addPanel(title) {
      const el = document.createElement('section');
      el.className = 'side-panel';
      const h = document.createElement('h2');
      h.textContent = title;
      const body = document.createElement('div');
      el.append(h, body);
      controls.prepend(el);
      return body;
    },
    attach(app) {
      attached = app;
      updateInsets();
    },
  };
}
