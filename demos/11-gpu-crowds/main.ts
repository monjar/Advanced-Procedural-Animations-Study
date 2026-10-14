import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { DEFAULT_BOIDS, randomBoids, type BoidParams } from '../../src/gpu/boidsCpu';
import { Compute } from '../../src/gpu/compute';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { GpuCrowd } from './crowd';
import { fishGeometry, fishMesh } from './fish';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '11',
  writeup,
  hint: 'Orbit: drag · Count, rules and the predator in the controls',
});

const WATER = new THREE.Color(0x0b2233);
const app = createApp(frame.viewport, { rate: 60, ground: false, background: WATER, cameraPosition: [34, 16, 30], cameraTarget: [0, 7, 0] });
frame.attach(app);
const FOG_DENSITY = 0.018;
app.scene.fog = new THREE.FogExp2(WATER, FOG_DENSITY);

const params: BoidParams = { ...DEFAULT_BOIDS, center: [...DEFAULT_BOIDS.center], half: [...DEFAULT_BOIDS.half], obstacle: [...DEFAULT_BOIDS.obstacle], predator: [...DEFAULT_BOIDS.predator] };

// Software rasterisers (CI, VMs without a GPU) get a small school by default.
function softwareRenderer(): boolean {
  const gl = app.renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  return /SwiftShader|llvmpipe|Software/i.test(name);
}
const settings = {
  count: softwareRenderer() ? 1024 : 16384,
  predator: true,
  colorByNeighbours: false,
  swim: 1,
};

// ---------------------------------------------------------------------------
// Scene: sand, a rock, a predator.

const sand = new THREE.Mesh(new THREE.PlaneGeometry(140, 140, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 1 }));
sand.rotation.x = -Math.PI / 2;
sand.position.y = params.center[1] - params.half[1];
sand.receiveShadow = true;
app.scene.add(sand);
const rockGeo = new THREE.IcosahedronGeometry(params.obstacle[3] * 0.92, 2);
const rp = rockGeo.getAttribute('position');
for (let i = 0; i < rp.count; i++) {
  const v = new THREE.Vector3().fromBufferAttribute(rp, i);
  v.multiplyScalar(1 + 0.12 * Math.sin(v.x * 1.7) * Math.cos(v.y * 2.1 + v.z));
  rp.setXYZ(i, v.x, v.y, v.z);
}
rockGeo.computeVertexNormals();
const rock = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.95, flatShading: true }));
rock.position.set(params.obstacle[0], params.obstacle[1], params.obstacle[2]);
rock.castShadow = true;
app.scene.add(rock);
const tank = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(params.half[0] * 2, params.half[1] * 2, params.half[2] * 2)),
  new THREE.LineBasicMaterial({ color: 0x2c5670 }),
);
tank.position.set(...params.center);
app.scene.add(tank);
const predator = new THREE.Mesh(fishGeometry(), new THREE.MeshStandardMaterial({ color: 0x55606b, roughness: 0.6 }));
predator.scale.setScalar(6);
predator.castShadow = true;
app.scene.add(predator);
app.scene.add(new THREE.HemisphereLight(0x8fc4e8, 0x1a2a33, 0.6));

// ---------------------------------------------------------------------------
// GPU crowd

const compute = new Compute(app.renderer);
let crowd: GpuCrowd;
let fish: ReturnType<typeof fishMesh>;

function build(): void {
  crowd?.dispose();
  if (fish) {
    app.scene.remove(fish);
    fish.geometry.dispose();
    fish.material.dispose();
  }
  crowd = new GpuCrowd(compute, settings.count, params, randomBoids(settings.count, params, 1));
  fish = fishMesh(settings.count, crowd.width, { maxSpeed: params.maxSpeed, fogColor: WATER, fogDensity: FOG_DENSITY });
  app.scene.add(fish);
}
build();

let predatorTime = 0;
const predPrev = new THREE.Vector3();
app.onFixedUpdate((dt) => {
  // Predator cruises a figure-of-eight through the tank.
  predatorTime += dt;
  const t = predatorTime * 0.18;
  predPrev.copy(predator.position);
  predator.position.set(Math.sin(t) * 15, params.center[1] + Math.sin(t * 1.3) * 3, Math.sin(2 * t) * 10);
  if (predatorTime > dt) predator.lookAt(predator.position.clone().add(predator.position.clone().sub(predPrev)));
  params.predator[0] = predator.position.x;
  params.predator[1] = settings.predator ? predator.position.y : -1000;
  params.predator[2] = predator.position.z;
  predator.visible = settings.predator;
  crowd.step(dt);
});

app.onFrame(() => {
  const u = fish.material.uniforms;
  u.posTex.value = crowd.positions;
  u.velTex.value = crowd.velocities;
  u.colorMode.value = settings.colorByNeighbours ? 1 : 0;
  u.swim.value = settings.swim;
  info.textContent =
    `boids     ${crowd.n.toLocaleString()}\n` +
    `grid      ${crowd.grid.dims.join(' × ')} cells of ${params.radius} m\n` +
    `passes    ${crowd.passesPerStep} per step (${crowd.passesPerStep - 3} sort)\n` +
    `checked   ≤ 27 cells × ${params.cap} boids`;
});

// Debug hook for the e2e test: compare the GPU with the CPU reference on the current state.
(window as unknown as { __crowd: unknown }).__crowd = {
  get n() {
    return crowd.n;
  },
  verify: (dt?: number) => crowd.verify(dt),
  rebuild: (count: number) => {
    settings.count = count;
    build();
  },
};

// ---------------------------------------------------------------------------
// Panels and controls

const info = frame.addPanel('GPU');
info.style.fontFamily = 'var(--mono)';
info.style.whiteSpace = 'pre';

const pane = createPane(frame.controls);
const school = pane.addFolder({ title: 'School' });
school
  .addBinding(settings, 'count', { options: { '1 024': 1024, '4 096': 4096, '16 384': 16384, '65 536': 65536 } })
  .on('change', build);
school.addBinding(params, 'wAlignment', { label: 'alignment', min: 0, max: 4, step: 0.05 });
school.addBinding(params, 'wCohesion', { label: 'cohesion', min: 0, max: 3, step: 0.05 });
school.addBinding(params, 'wSeparation', { label: 'separation', min: 0, max: 5, step: 0.05 });
school.addBinding(params, 'maxSpeed', { label: 'max speed', min: 1.5, max: 8, step: 0.1 });
school.addBinding(params, 'cap', { label: 'per-cell cap', min: 4, max: 64, step: 1 });

const world = pane.addFolder({ title: 'World' });
world.addBinding(settings, 'predator');
world.addBinding(params, 'wFlee', { label: 'fear', min: 0, max: 30, step: 0.5 });

const viewFolder = pane.addFolder({ title: 'View' });
viewFolder.addBinding(settings, 'swim', { label: 'swim amplitude', min: 0, max: 3, step: 0.05 });
viewFolder.addBinding(settings, 'colorByNeighbours', { label: 'colour by neighbours' });
addSimulationFolder(pane, app.loop);
app.start();
