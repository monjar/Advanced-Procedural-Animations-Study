import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FixedStepLoop } from './loop';
import { DebugDraw } from './debugDraw';

export interface AppOptions {
  /** Simulation rate in Hz. */
  rate?: number;
  cameraPosition?: THREE.Vector3Tuple;
  cameraTarget?: THREE.Vector3Tuple;
  ground?: boolean;
  background?: THREE.ColorRepresentation;
}

type FixedFn = (dt: number, time: number) => void;
type FrameFn = (alpha: number, frameDt: number) => void;

export interface App {
  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly loop: FixedStepLoop;
  /** Immediate-mode debug lines/points. Draw from `onFrame` callbacks. */
  readonly debug: DebugDraw;
  onFixedUpdate(fn: FixedFn): void;
  onFrame(fn: FrameFn): void;
  render(): void;
  start(): void;
  dispose(): void;
}

export function createApp(container: HTMLElement, options: AppOptions = {}): App {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? 0x15171c);
  scene.fog = new THREE.Fog(scene.background as THREE.Color, 18, 45);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  camera.position.set(...(options.cameraPosition ?? [4, 3, 6]));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...(options.cameraTarget ?? [0, 1, 0]));
  controls.enableDamping = true;
  controls.update();

  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2622, 1.1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(5, 9, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = s.bottom = -8;
  s.right = s.top = 8;
  s.near = 1;
  s.far = 30;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  if (options.ground ?? true) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x1e2128, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    scene.add(ground);

    const grid = new THREE.GridHelper(40, 40, 0x3a404c, 0x2a2f38);
    grid.position.y = 0.001;
    scene.add(grid);
  }

  const debug = new DebugDraw();
  scene.add(debug);

  const fixedFns: FixedFn[] = [];
  const frameFns: FrameFn[] = [];

  const render = () => renderer.render(scene, camera);

  const loop = new FixedStepLoop(
    {
      fixedUpdate: (dt, time) => {
        for (const fn of fixedFns) fn(dt, time);
      },
      frame: (alpha, frameDt) => {
        debug.reset();
        for (const fn of frameFns) fn(alpha, frameDt);
        debug.flush();
        controls.update();
        render();
      },
    },
    options.rate ?? 120,
  );

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  return {
    container,
    renderer,
    scene,
    camera,
    controls,
    loop,
    debug,
    onFixedUpdate: (fn) => fixedFns.push(fn),
    onFrame: (fn) => frameFns.push(fn),
    render,
    start: () => loop.start(),
    dispose: () => {
      loop.stop();
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
