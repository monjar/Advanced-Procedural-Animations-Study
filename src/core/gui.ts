import { Pane } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import type { FixedStepLoop } from './loop';

export function createPane(container: HTMLElement, title = 'Controls'): Pane {
  // Collapsed by default on narrow screens so the scene stays visible.
  const pane = new Pane({ container, title, expanded: window.innerWidth >= 900 });
  pane.registerPlugin(EssentialsPlugin);
  return pane;
}

/**
 * Standard "Simulation" folder: fps graph, pause, time scale and fixed step rate.
 * Returns hooks to bracket each rendered frame for the fps measurement.
 */
export function addSimulationFolder(pane: Pane, loop: FixedStepLoop, rates = [30, 60, 120, 240]) {
  const folder = pane.addFolder({ title: 'Simulation', expanded: false });
  const fps = folder.addBlade({ view: 'fpsgraph', label: 'fps', rows: 2 }) as EssentialsPlugin.FpsGraphBladeApi;
  const params = { rate: Math.round(loop.rate) };
  folder.addBinding(loop, 'paused');
  folder.addBinding(loop, 'timeScale', { min: 0, max: 2, step: 0.05, label: 'time scale' });
  folder
    .addBinding(params, 'rate', {
      label: 'sim rate (Hz)',
      options: Object.fromEntries(rates.map((r) => [String(r), r])),
    })
    .on('change', (ev) => (loop.rate = ev.value));
  folder.addButton({ title: 'Step (while paused)' }).on('click', () => loop.step());
  return { begin: () => fps.begin(), end: () => fps.end() };
}
