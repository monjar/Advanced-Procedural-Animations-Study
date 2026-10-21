import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { SegmentBatch } from '../../src/rig/segments';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { EXAMPLES } from './examples';
import { describeError, direct, MODEL } from './llm';
import { Performer } from './performer';
import { SCENE, validateProgram, type Program } from './program';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '14',
  writeup,
  hint: 'Type what the character should do, or pick an example · Orbit: drag · Zoom: scroll',
});

const app = createApp(frame.viewport, { rate: 120, cameraPosition: [0, 5, 11.5], cameraTarget: [0, 0.8, 0] });
frame.attach(app);

// ---------------------------------------------------------------------------------------- scene

for (const o of SCENE) {
  const mat = new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.55 });
  const g = new THREE.Group();
  g.position.set(o.x, 0, o.z);
  const add = (geo: THREE.BufferGeometry, y: number, m: THREE.Material = mat) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.y = y;
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  if (o.id === 'red_cube') add(new THREE.BoxGeometry(1, 1, 1), 0.5);
  else if (o.id === 'blue_ball') add(new THREE.SphereGeometry(0.35, 32, 20), 0.35);
  else if (o.id === 'green_cone') add(new THREE.ConeGeometry(0.45, 1.8, 32), 0.9);
  else if (o.id === 'yellow_pillar') add(new THREE.CylinderGeometry(0.35, 0.35, 2.4, 32), 1.2);
  else if (o.id === 'bench') {
    add(new THREE.BoxGeometry(1.8, 0.08, 0.5), 0.46);
    add(new THREE.BoxGeometry(1.8, 0.4, 0.06), 0.72).position.z = -0.24;
    for (const x of [-0.8, 0.8]) add(new THREE.BoxGeometry(0.08, 0.44, 0.46), 0.22).position.x = x;
  } else if (o.id === 'lamp') {
    add(new THREE.CylinderGeometry(0.06, 0.09, 2.8, 16), 1.4);
    add(new THREE.SphereGeometry(0.2, 20, 14), 2.85, new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffd98a, emissiveIntensity: 1.2 }));
  }
  app.scene.add(g);
  app.label(o.label, g, [0, o.id === 'lamp' ? 3.3 : o.y * 2 + 0.35, 0], 'label');
}

const performer = new Performer();
const biped = performer.biped;
const BODY = 0xd5d9e0;
const JOINT = 0x3a3f4a;
const batch = new SegmentBatch(64, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.05 }));
app.scene.add(batch);
const headGroup = new THREE.Group();
{
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.45 }));
  skull.scale.set(0.95, 1.1, 1);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.25 }));
  visor.position.set(0, 0.02, 0.085);
  headGroup.add(skull, visor);
  headGroup.traverse((o) => (o.castShadow = true));
}
app.scene.add(headGroup);

app.onFixedUpdate((dt) => {
  performer.camera.copy(app.camera.position);
  performer.update(dt);
});

const tmp = new THREE.Vector3();
const settings = { follow: true, showTargets: true };
app.onFrame((_a, frameDt) => {
  batch.begin();
  const colors = [0x5fb3ff, 0xff8a3d];
  biped.feet.forEach((f, i) => {
    const c = colors[f.side > 0 ? 1 : 0];
    batch.segment(f.hip, f.ik.mid, 0.062, BODY);
    batch.joint(f.hip, 0.07, JOINT);
    batch.joint(f.ik.mid, 0.052, JOINT);
    batch.segment(f.ik.mid, f.ik.end, 0.048, BODY);
    batch.joint(f.ankle, 0.04, JOINT);
    batch.segment(f.heel, f.toe, 0.035, c);
    batch.segment(f.ankle, tmp.copy(f.heel).lerp(f.toe, 0.35), 0.036, c);
    void i;
  });
  batch.segment(biped.feet[0].hip, biped.feet[1].hip, 0.085, BODY);
  for (let i = 0; i < biped.spine.length - 1; i++) {
    const r = THREE.MathUtils.lerp(0.09, 0.115, i / (biped.spine.length - 2));
    batch.segment(biped.spine[i], biped.spine[i + 1], r, BODY);
    batch.joint(biped.spine[i + 1], r, BODY);
  }
  batch.segment(biped.arms[0].shoulder, biped.arms[1].shoulder, 0.075, BODY);
  batch.segment(biped.chest, biped.neck, 0.045, JOINT);
  biped.arms.forEach((a, i) => {
    batch.joint(a.shoulder, 0.06, JOINT);
    batch.segment(a.shoulder, a.elbow, 0.042, BODY);
    batch.joint(a.elbow, 0.038, JOINT);
    batch.segment(a.elbow, a.hand, 0.034, BODY);
    batch.joint(a.hand, 0.045, colors[i]);
  });
  batch.commit();
  headGroup.position.copy(biped.head);
  headGroup.quaternion.copy(biped.headQuat);

  if (settings.follow) {
    const goal = tmp.copy(biped.position).setY(0.9);
    app.controls.target.lerp(goal, 1 - Math.exp(-frameDt * 3));
  }
  app.focusShadow(biped.position);
  renderSteps();
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------------------- director panel

const KEY_STORE = 'pas.anthropic-key';
const readKey = () => {
  try {
    return localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
};

const panel = frame.addPanel('Director');
panel.insertAdjacentHTML(
  'beforeend',
  `<div class="director">
    <textarea rows="3" placeholder="e.g. walk to the red cube, touch it, then wave at me"></textarea>
    <div class="row"><button class="go">Direct</button><span class="status"></span></div>
    <details class="key"><summary>Claude API key (optional)</summary>
      <input type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
      <label><input type="checkbox" class="remember"> remember on this device</label>
      <p>With a key, prompts go to ${MODEL} from your browser. Without one, the examples below run from
      programs written in advance. The key is kept in this tab only, or in this browser's storage if you tick remember.</p>
    </details>
    <div class="examples"></div>
    <div class="summary"></div>
    <ol class="steps"></ol>
  </div>`,
);
const style = document.createElement('style');
style.textContent = `
  .director textarea { width: 100%; box-sizing: border-box; resize: vertical; background: #0f1115; color: #e6e8eb; border: 1px solid #2a2f38; border-radius: 6px; padding: 8px; font: 13px/1.4 system-ui, sans-serif; }
  .director .row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .director button { background: #2a2f38; color: #e6e8eb; border: 1px solid #3a404c; border-radius: 6px; padding: 5px 10px; font: 12px system-ui, sans-serif; cursor: pointer; }
  .director button.go { background: #ff8a3d; color: #15171c; border-color: #ff8a3d; font-weight: 600; }
  .director button:disabled { opacity: 0.5; cursor: default; }
  .director .status { font: 12px system-ui, sans-serif; color: #9aa3ad; }
  .director .status.error { color: #ff6b6b; }
  .director details { font: 12px system-ui, sans-serif; color: #9aa3ad; margin-bottom: 6px; }
  .director details input[type=password] { width: 100%; box-sizing: border-box; margin: 6px 0; background: #0f1115; color: #e6e8eb; border: 1px solid #2a2f38; border-radius: 6px; padding: 6px; }
  .director details p { margin: 6px 0 0; line-height: 1.4; }
  .director .examples { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
  .director .examples button { text-align: left; background: transparent; border-color: #2a2f38; color: #c3c9d1; }
  .director .summary { font: 12px/1.4 system-ui, sans-serif; color: #e6e8eb; margin: 8px 0 4px; }
  .director ol { margin: 0; padding-left: 20px; font: 11px/1.6 ui-monospace, monospace; color: #9aa3ad; }
  .director li.active { color: #ffd166; }
  .director li.ok::marker { color: #4fd18b; }
  .director li.fail { color: #ff6b6b; }`;
document.head.appendChild(style);
const $ = <T extends Element>(sel: string) => panel.querySelector(sel) as T;
const textarea = $<HTMLTextAreaElement>('textarea');
const go = $<HTMLButtonElement>('button.go');
const statusEl = $<HTMLSpanElement>('.status');
const keyInput = $<HTMLInputElement>('input[type=password]');
const remember = $<HTMLInputElement>('input.remember');
const summaryEl = $<HTMLDivElement>('.summary');
const stepsEl = $<HTMLOListElement>('ol.steps');
keyInput.value = readKey();
remember.checked = !!keyInput.value;
const saveKey = () => {
  try {
    if (remember.checked && keyInput.value) localStorage.setItem(KEY_STORE, keyInput.value);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    // storage unavailable: the key lives in this tab only
  }
};
keyInput.addEventListener('change', saveKey);
remember.addEventListener('change', saveKey);

const setStatus = (text: string, error = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
};

function describeStep(s: Program['steps'][number]): string {
  const parts: string[] = [s.action];
  if (s.target) parts.push(s.target);
  if (s.action === 'walk_to') parts.push(`${s.speed} m/s`);
  if (s.hand && s.hand !== 'either') parts.push(`${s.hand} hand`);
  if (s.seconds) parts.push(`${s.seconds} s`);
  if (s.times) parts.push(`×${s.times}`);
  return (s.with_previous ? '+ ' : '') + parts.join(' · ');
}

let shownProgram: Program | null = null;
function renderSteps(): void {
  const p = performer.program;
  if (p !== shownProgram) {
    shownProgram = p;
    summaryEl.textContent = p ? p.summary : '';
    stepsEl.innerHTML = '';
    p?.steps.forEach((s) => {
      const li = document.createElement('li');
      li.textContent = describeStep(s);
      stepsEl.appendChild(li);
    });
  }
  if (!p) return;
  const items = stepsEl.children;
  for (let i = 0; i < items.length; i++) {
    const r = performer.results.find((x) => x.index === i);
    items[i].className = r ? (r.achieved ? 'ok' : 'fail') : performer.active.includes(i) ? 'active' : '';
  }
}

function run(program: Program, source: string): void {
  const v = validateProgram(program);
  if (!v.ok) {
    setStatus(v.errors.join(' '), true);
    return;
  }
  performer.load(v.program);
  setStatus(source);
}

const examplesEl = $<HTMLDivElement>('.examples');
for (const ex of EXAMPLES) {
  const b = document.createElement('button');
  b.textContent = ex.prompt;
  b.addEventListener('click', () => {
    textarea.value = ex.prompt;
    void directPrompt();
  });
  examplesEl.appendChild(b);
}

let inFlight: AbortController | null = null;
async function directPrompt(): Promise<void> {
  const prompt = textarea.value.trim();
  if (!prompt) return;
  const key = keyInput.value.trim();
  if (!key) {
    const ex = EXAMPLES.find((e) => e.prompt === prompt);
    if (ex) run(ex.program, 'example program (no API key)');
    else setStatus('Add an API key to direct with your own words, or pick an example.', true);
    return;
  }
  inFlight?.abort();
  inFlight = new AbortController();
  go.disabled = true;
  setStatus(`asking ${MODEL}…`);
  try {
    const r = await direct(prompt, key, { signal: inFlight.signal });
    run(r.program, `${r.model}${r.repairs.length ? ` · repaired after ${r.repairs.length} invalid repl${r.repairs.length > 1 ? 'ies' : 'y'}` : ''}`);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) setStatus(describeError(e), true);
  } finally {
    go.disabled = false;
  }
}
go.addEventListener('click', () => void directPrompt());
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void directPrompt();
});

// Start with the first example so the page is alive on load.
textarea.value = EXAMPLES[0].prompt;
run(EXAMPLES[0].program, 'example program (no API key)');

const pane = createPane(frame.controls);
const view = pane.addFolder({ title: 'View' });
view.addBinding(settings, 'follow', { label: 'follow character' });
pane.addButton({ title: 'Reset character' }).on('click', () => window.location.reload());
const sim = addSimulationFolder(pane, app.loop);
app.start();
