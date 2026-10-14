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
  /** Pixels covered by UI on the left/right; the projection is shifted so the scene centres in the free area. */
  setInsets(left: number, right: number): void;
  start(): void;
  dispose(): void;
}

export function createApp(container: HTMLElement, options: AppOptions = {}): App {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? 0x15171c);
  scene.fog = new THREE.Fog(scene.background as THREE.Color, 18, 45);

  const BASE_FOV = 45;
  const MIN_HFOV = THREE.MathUtils.degToRad(50);
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 200);
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

  const insets = { left: 0, right: 0 };

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    // Portrait screens: widen the vertical fov so the horizontal fov never drops below MIN_HFOV.
    const fitFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(MIN_HFOV / 2) / camera.aspect));
    camera.fov = THREE.MathUtils.clamp(fitFov, BASE_FOV, 80);
    // Shift the view window horizontally (film offset) by half the inset imbalance.
    const shiftPx = (insets.left - insets.right) / 2;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    camera.filmOffset = -(shiftPx / w) * 2 * tanHalfFov * camera.aspect * camera.getFilmWidth();
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const app: App = {
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
    setInsets: (left, right) => {
      insets.left = left;
      insets.right = right;
      resize();
    },
    start: () => loop.start(),
    dispose: () => {
      loop.stop();
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
  // Exposed for automated smoke tests and console debugging.
  (window as unknown as { __app?: App }).__app = app;
  return app;
}
