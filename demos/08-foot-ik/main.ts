import * as THREE from 'three';
import { createApp } from '../../src/core/app';
import { addSimulationFolder, createPane } from '../../src/core/gui';
import { ClipPlayer, type ClipData } from '../../src/anim/clip';
import { SegmentBatch } from '../../src/rig/segments';
import { createDemoFrame } from '../../src/ui/demoFrame';
import { courseHeight, courseMesh, courseNormal, COURSE_LENGTH } from './course';
import { FootIK, type FootIKSettings } from './footik';
import writeup from './README.md?raw';

const frame = createDemoFrame({
  id: '08',
  writeup,
  hint: 'Toggle the IK layers to compare against the raw clip · Orbit: drag (free camera)',
});

const app = createApp(frame.viewport, { rate: 60, cameraPosition: [4, 1.8, 2], cameraTarget: [0, 1, 2] });
frame.attach(app);
app.scene.add(courseMesh());

const settings = {
  rate: 1,
  showRaw: true,
  showLocks: true,
  camera: 'side' as 'side' | 'free',
};
const ikSettings: FootIKSettings = { enabled: true, pelvis: true, lock: true, align: true, swing: true };

const BODY = 0xd5d9e0;
const JOINT = 0x3a3f4a;
const LEFT = 0xff8a3d;
const RIGHT = 0x5fb3ff;

const data = (await (await fetch(new URL('../../assets/mocap/cmu-02_01-walk.json', document.baseURI))).json()) as ClipData;
const player = new ClipPlayer(data);
const raw = new ClipPlayer(data);
const ik = new FootIK(player, courseHeight, courseNormal, ikSettings);

const batch = new SegmentBatch(64, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
app.scene.add(batch);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.45 }));
head.castShadow = true;
app.scene.add(head);

// Radius per bone (segment from the bone's parent to the bone).
function radius(name: string): number {
  if (/UpLeg/.test(name)) return 0.07;
  if (/Leg$/.test(name)) return 0.055;
  if (/Foot$/.test(name)) return 0.045;
  if (/Toe/.test(name)) return 0.035;
  if (/Spine|LowerBack/.test(name)) return 0.1;
  if (/Neck/.test(name)) return 0.045;
  if (/ForeArm|Hand/.test(name)) return 0.035;
  if (/Arm|Shoulder/.test(name)) return 0.045;
  return 0.06;
}
function color(name: string): number {
  if (/^Left(Foot|Toe)/.test(name)) return LEFT;
  if (/^Right(Foot|Toe)/.test(name)) return RIGHT;
  return BODY;
}

// ---------------------------------------------------------------------------
// Loop

app.onFixedUpdate((dt) => {
  player.time += dt * settings.rate;
  raw.time = player.time;
  ik.update(dt * settings.rate);
  raw.apply();
  if (player.bones[0].position.z > COURSE_LENGTH + 0.5) {
    player.time = 0;
    raw.time = 0;
    ik.reset();
  }
});

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const camGoal = new THREE.Vector3();

app.onFrame((_alpha, frameDt) => {
  batch.begin();
  player.bones.forEach((bone, i) => {
    const parent = data.joints[i].parent;
    if (parent < 0) return;
    bone.getWorldPosition(a);
    player.bones[parent].getWorldPosition(b);
    if (a.distanceTo(b) < 1e-3) return;
    const r = radius(bone.name);
    batch.segment(b, a, r, color(bone.name));
    const jointColor = /Foot|Toe/.test(bone.name) ? color(bone.name) : /Leg$|ForeArm|Hand/.test(bone.name) ? JOINT : BODY;
    batch.joint(a, r * 1.05, jointColor);
  });
  batch.commit();
  player.bone('Head').getWorldPosition(head.position);
  head.position.y += 0.08;

  const d = app.debug;
  if (settings.showRaw) {
    raw.bones.forEach((bone, i) => {
      const parent = data.joints[i].parent;
      if (parent < 0) return;
      d.line(bone.getWorldPosition(a), raw.bones[parent].getWorldPosition(b), 0x8b929c);
    });
  }
  if (settings.showLocks) {
    for (const f of ik.feet) {
      if (f.lockW > 0.05) d.point(f.locked, 0xffd166);
      d.point(f.target, f.side === 'left' ? LEFT : RIGHT);
    }
  }

  const root = player.bones[0].getWorldPosition(a);
  if (settings.camera === 'side') {
    camGoal.set(root.x + 4.2, root.y + 0.6, root.z + 0.4);
    app.camera.position.lerp(camGoal, 1 - Math.exp(-frameDt * 3));
    app.controls.target.lerp(b.copy(root).setY(root.y - 0.1), 1 - Math.exp(-frameDt * 6));
  }
  app.focusShadow(root);

  readTimer -= frameDt;
  if (readTimer <= 0) {
    readTimer = 0.15;
    const cm = (v: number) => (v * 100).toFixed(1).padStart(6);
    const rows = ik.feet.map(
      (f) =>
        `${f.side.padEnd(5)} ${cm(f.rawError)} ${cm(f.ikError)}   ${cm(f.lastSlip.raw)} ${cm(f.lastSlip.ik)}  ${f.flat ? 'flat' : f.contact > 0.5 ? 'roll' : 'swing'}`,
    );
    readout.textContent =
      `        foot error cm    slip/stance cm\n` +
      `         raw     IK      raw     IK\n` +
      `${rows.join('\n')}\n\n` +
      `pelvis ${cm(ik.pelvis.x)} cm · reach drop ${cm(ik.reachDrop)} cm`;
  }
  sim.end();
  sim.begin();
});

// ---------------------------------------------------------------------------
// Panels and controls

const readout = frame.addPanel('Contact quality');
readout.style.fontFamily = 'var(--mono)';
readout.style.whiteSpace = 'pre';
let readTimer = 0;

const pane = createPane(frame.controls);
const layers = pane.addFolder({ title: 'IK layers' });
layers.addBinding(ikSettings, 'enabled', { label: 'foot IK' });
layers.addBinding(ikSettings, 'pelvis', { label: 'pelvis adjust' });
layers.addBinding(ikSettings, 'lock', { label: 'foot locking' });
layers.addBinding(ikSettings, 'swing', { label: 'swing adapt' });
layers.addBinding(ikSettings, 'align', { label: 'align to slope' });

const view = pane.addFolder({ title: 'View' });
view.addBinding(settings, 'rate', { label: 'playback', min: 0.1, max: 2, step: 0.05 });
view.addBinding(settings, 'showRaw', { label: 'raw clip ghost' });
view.addBinding(settings, 'showLocks', { label: 'targets & locks' });
view.addBinding(settings, 'camera', { options: { side: 'side', free: 'free' } });

const sim = addSimulationFolder(pane, app.loop);
app.start();
