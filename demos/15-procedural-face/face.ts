import * as THREE from 'three';
import { lookRotation } from '../../src/math/quat';
import { VISEMES, type Viseme } from './voice';
import type { Weights } from './lipsync';

/**
 * A stylised head built from code: a deformed sphere, lips as tubes, eyeballs with painted irises, eyelid caps,
 * brows, teeth and a mouth cavity. Every viseme is a morph target on the lips (and the jaw a morph target on the
 * head), generated from a handful of mouth parameters. All parameters enter the geometry linearly, so blending
 * morph targets is the same as blending parameters — which lets the head's fragment shader cut the mouth opening
 * exactly where the blended lips part.
 *
 * Head frame: +z toward the viewer, +y up; the head is about 2 units tall.
 */

/** Mouth parameters per viseme. */
export interface MouthShape {
  open: number; // jaw, 0–1
  width: number; // −1 rounded … +1 spread
  protrude: number; // lips forward
  press: number; // lips pressed together (m, b, p)
  tuck: number; // lower lip under the upper teeth (f, v)
  upper: number; // upper lip raised off the teeth
}

const S = (open: number, width: number, protrude = 0, press = 0, tuck = 0, upper = 0): MouthShape => ({ open, width, protrude, press, tuck, upper });

export const MOUTH_SHAPES: Record<Viseme, MouthShape> = {
  sil: S(0, 0),
  PP: S(0, 0.05, 0.15, 1),
  FF: S(0.12, 0.25, 0, 0, 1, 0.5),
  TH: S(0.2, 0.15, 0, 0, 0, 0.3),
  DD: S(0.25, 0.3, 0, 0, 0, 0.3),
  kk: S(0.32, 0.15),
  CH: S(0.16, -0.45, 0.65, 0, 0, 0.6),
  SS: S(0.08, 0.55, 0, 0, 0, 0.7),
  RR: S(0.22, -0.5, 0.45),
  aa: S(1, 0.15, 0, 0, 0, 0.3),
  E: S(0.5, 0.6, 0, 0, 0, 0.4),
  I: S(0.18, 1, 0, 0, 0, 0.5),
  O: S(0.62, -0.65, 0.55),
  U: S(0.18, -1, 1),
};

// ------------------------------------------------------------------------------------------- head shape

const MOUTH_Y = -0.43;
// The jaw hinges near the ears (temporomandibular joint), so opening mostly drops the chin.
const JAW_PIVOT = new THREE.Vector3(0, 0.02, -0.12);
const JAW_MAX = 0.28; // radians at open = 1
export const EYE_Y = 0.16;
export const EYE_X = 0.3;
export const EYE_RADIUS = 0.12;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const g2 = (dx: number, dy: number) => Math.exp(-(dx * dx + dy * dy));

/** Width taper toward the chin. */
const taper = (y: number) => 1 - 0.16 * smooth(-0.1, -1, y) - 0.06 * smooth(0.4, 1, y);

/** Forward displacement of the face at (x, y): sockets, brow, nose, cheeks, muzzle, chin. */
function relief(x: number, y: number, smile = 0): number {
  const ax = Math.abs(x);
  let z = 0;
  z -= 0.075 * g2((ax - EYE_X) / 0.15, (y - EYE_Y) / 0.11); // eye sockets
  z += 0.035 * g2(x / 0.42, (y - 0.33) / 0.06); // brow ridge
  z += 0.19 * g2(x / 0.07, (y + 0.12) / 0.11); // nose
  z += 0.07 * g2(x / 0.045, (y - 0.04) / 0.13); // bridge
  z += 0.05 * g2((ax - 0.075) / 0.035, (y + 0.19) / 0.04); // nostril wings
  z += 0.045 * g2((ax - 0.36) / 0.14, (y + 0.1 - 0.05 * smile) / 0.14) * (1 + 0.6 * smile); // cheeks
  z += 0.06 * g2(x / 0.26, (y - MOUTH_Y) / 0.16); // muzzle
  z += 0.05 * g2(x / 0.14, (y + 0.78) / 0.1); // chin
  return z;
}

/** Map a unit-sphere point to the head surface. */
function headPoint(sx: number, sy: number, sz: number, smile = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const y = 1.04 * sy;
  const x = 0.88 * sx * taper(y);
  let z = 0.95 * sz * (1 - 0.08 * smooth(-0.3, -1, y));
  z += relief(x, y, smile) * smooth(0.1, 0.6, sz);
  return out.set(x, y, z);
}

/** Front surface depth of the head at (x, y) (before relief toward the sides fades out). */
export function surfaceZ(x: number, y: number): number {
  const sy = y / 1.04;
  const sx = x / (0.88 * taper(y));
  const sz = Math.sqrt(Math.max(0, 1 - sx * sx - sy * sy));
  return 0.95 * sz * (1 - 0.08 * smooth(-0.3, -1, y)) + relief(x, y) * smooth(0.1, 0.6, sz);
}

function rotateJaw(p: THREE.Vector3, angle: number): THREE.Vector3 {
  const y = p.y - JAW_PIVOT.y;
  const z = p.z - JAW_PIVOT.z;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return p.set(p.x, JAW_PIVOT.y + y * c - z * s, JAW_PIVOT.z + y * s + z * c);
}

/** How much of the jaw's rotation a head vertex takes. */
const jawWeight = (p: THREE.Vector3) => smooth(MOUTH_Y + 0.01, MOUTH_Y - 0.14, p.y) * smooth(-0.45, 0.1, p.z);

// ------------------------------------------------------------------------------------------- lips

const LIP_SEGMENTS = 48;
const LIP_RING = 10;

interface LipCurves {
  halfWidth: number;
  gapUpper: number;
  gapLower: number;
  jaw: number;
}

export function lipCurves(m: MouthShape): LipCurves {
  return {
    halfWidth: 0.21 * (1 + 0.24 * m.width) * (1 - 0.06 * m.protrude),
    gapUpper: 0.004 + 0.022 * m.upper + 0.008 * m.open - 0.004 * m.press,
    gapLower: 0.004 + 0.03 * m.open - 0.004 * m.press - 0.012 * m.tuck,
    jaw: JAW_MAX * m.open,
  };
}

/** Positions of both lip tubes (upper first) for a mouth shape and a smile amount. */
export function lipPositions(m: MouthShape, smile: number): Float32Array {
  const c = lipCurves(m);
  const out = new Float32Array(2 * (LIP_SEGMENTS + 1) * LIP_RING * 3);
  const centre = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, 1);
  const p = new THREE.Vector3();
  let k = 0;
  const lipCentre = (lower: boolean, u: number, target: THREE.Vector3) => {
    const bell = 1 - u * u;
    const r = (lower ? 0.034 : 0.027) * (1 - 0.72 * u * u) * (1 - 0.3 * m.press) + 0.005;
    const x = c.halfWidth * u * (1 + 0.04 * smile);
    const corner = 0.03 * smile * u * u; // corners lift with a smile
    let y = lower
      ? MOUTH_Y - c.gapLower * Math.pow(bell, 0.7) - r * 0.85 + corner + 0.022 * m.tuck
      : MOUTH_Y + c.gapUpper * Math.sqrt(bell) + r * 0.85 + corner + 0.006 * Math.exp(-((u / 0.14) ** 2));
    let z = surfaceZ(x, y) - r * 0.35 + (0.05 * m.protrude + 0.008) * bell - 0.015 * m.press - (lower ? 0.035 * m.tuck : 0);
    target.set(x, y, z);
    // The corners of the mouth stay joined: the jaw carries the middle of the lower lip, not its ends.
    if (lower) rotateJaw(target, c.jaw * (0.3 + 0.7 * Math.pow(bell, 0.6)));
    return r;
  };
  for (const lower of [false, true]) {
    for (let i = 0; i <= LIP_SEGMENTS; i++) {
      const u = -1 + (2 * i) / LIP_SEGMENTS;
      const r = lipCentre(lower, u, centre);
      lipCentre(lower, Math.min(1, u + 0.01), p);
      tangent.copy(p);
      lipCentre(lower, Math.max(-1, u - 0.01), p);
      tangent.sub(p).normalize();
      side.crossVectors(fwd, tangent).normalize(); // up-ish, perpendicular to the curve in the face plane
      for (let j = 0; j < LIP_RING; j++) {
        const a = (2 * Math.PI * j) / LIP_RING;
        p.copy(centre).addScaledVector(side, Math.cos(a) * r).addScaledVector(fwd, Math.sin(a) * r * 0.85);
        out[k++] = p.x;
        out[k++] = p.y;
        out[k++] = p.z;
      }
    }
  }
  return out;
}

function lipGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const base = lipPositions(MOUTH_SHAPES.sil, 0);
  geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  const index: number[] = [];
  for (let lip = 0; lip < 2; lip++) {
    const o = lip * (LIP_SEGMENTS + 1) * LIP_RING;
    for (let i = 0; i < LIP_SEGMENTS; i++) {
      for (let j = 0; j < LIP_RING; j++) {
        const a = o + i * LIP_RING + j;
        const b = o + i * LIP_RING + ((j + 1) % LIP_RING);
        const c = a + LIP_RING;
        const d = b + LIP_RING;
        index.push(a, b, c, b, d, c);
      }
    }
  }
  geo.setIndex(index);
  const targets: THREE.BufferAttribute[] = [];
  const delta = (pos: Float32Array) => {
    const d = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i++) d[i] = pos[i] - base[i];
    return new THREE.BufferAttribute(d, 3);
  };
  for (const v of VISEMES) targets.push(delta(lipPositions(MOUTH_SHAPES[v], 0)));
  targets.push(delta(lipPositions(MOUTH_SHAPES.sil, 1))); // smile
  geo.morphAttributes.position = targets;
  geo.morphTargetsRelative = true;
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------------------------------- textures

function eyeTexture(iris: string): THREE.CanvasTexture {
  // Equirectangular: the front of the sphere (+z) is at u = 0.25, v = 0.5, where one radian is 81.5 px both ways.
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2ece6';
  g.fillRect(0, 0, 512, 256);
  const cx = 128;
  const cy = 128;
  const px = 81.5;
  const ri = 0.58 * px;
  for (let i = 0; i < 40; i++) {
    // Faint veins toward the back.
    g.strokeStyle = `rgba(200,80,80,${0.08 + Math.random() * 0.08})`;
    g.beginPath();
    const a = Math.random() * Math.PI * 2;
    g.moveTo(cx + Math.cos(a) * ri * 1.4, cy + Math.sin(a) * ri * 1.4);
    g.lineTo(cx + Math.cos(a) * ri * 3, cy + Math.sin(a + 0.2) * ri * 2.2);
    g.stroke();
  }
  const grad = g.createRadialGradient(cx, cy, ri * 0.2, cx, cy, ri);
  grad.addColorStop(0, '#2b1a10');
  grad.addColorStop(0.35, iris);
  grad.addColorStop(0.85, iris);
  grad.addColorStop(1, '#1a120c');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, ri, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2;
    g.strokeStyle = `rgba(255,230,190,${0.06 + 0.1 * Math.random()})`;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * ri * 0.4, cy + Math.sin(a) * ri * 0.4);
    g.lineTo(cx + Math.cos(a) * ri * 0.95, cy + Math.sin(a) * ri * 0.95);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ------------------------------------------------------------------------------------------- rig

export interface FaceState {
  visemes: Weights;
  smile: number;
  brow: number; // −1 frown … +1 raised
  blink: number;
  /** Eye-in-head angles (degrees) and the fixation distance, for vergence. */
  eyeYaw: number;
  eyePitch: number;
  fixationDistance: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  pupil: number; // 0 constricted … 1 dilated
}

export class Face {
  readonly root = new THREE.Group();
  readonly head = new THREE.Group();
  readonly eyes: THREE.Group[] = [];
  readonly eyeCentres = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly headMesh: THREE.Mesh;
  private readonly lips: THREE.Mesh;
  private readonly lowerTeeth: THREE.Group;
  private readonly tongue: THREE.Mesh;
  private readonly upperLids: THREE.Mesh[] = [];
  private readonly lowerLids: THREE.Mesh[] = [];
  private readonly brows: THREE.Mesh[] = [];
  private readonly pupils: THREE.Mesh[] = [];
  private readonly uniforms = {
    uMouth: { value: new THREE.Vector4() }, // half width, upper gap, lower gap, jaw angle
  };
  private readonly browBase: Float32Array[] = [];
  private shoulders: THREE.Mesh;
  breathing = 0;

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a383, roughness: 0.62 });
    skin.onBeforeCompile = (shader) => {
      shader.uniforms.uMouth = this.uniforms.uMouth;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
        .replace('#include <morphtarget_vertex>', '#include <morphtarget_vertex>\nvLocal = transformed;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vLocal;
          uniform vec4 uMouth;
          bool inMouth(vec3 p) {
            if (p.z < 0.3) return false;
            float u = p.x / uMouth.x;
            if (abs(u) >= 1.0) return false;
            float bell = 1.0 - u * u;
            // Close the hole well before the corners, where the lips thin out: a lens inside the lips.
            float lens = 1.0 - smoothstep(0.55, 0.92, abs(u));
            float upper = ${MOUTH_Y.toFixed(3)} + uMouth.y * sqrt(bell) * lens;
            // The lower edge lives on the jaw: rotate the fragment back by the jaw angle.
            vec2 q = vec2(p.y - ${JAW_PIVOT.y.toFixed(3)}, p.z - (${JAW_PIVOT.z.toFixed(3)}));
            float c = cos(-uMouth.w), s = sin(-uMouth.w);
            float yClosed = ${JAW_PIVOT.y.toFixed(3)} + q.x * c - q.y * s;
            float lower = ${MOUTH_Y.toFixed(3)} - uMouth.z * pow(bell, 0.7) * lens;
            return p.y < upper && yClosed > lower;
          }`)
        .replace('void main() {', 'void main() {\n  if (inMouth(vLocal)) discard;');
    };
    const lipMat = new THREE.MeshStandardMaterial({ color: 0xb8655c, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a0d0f, roughness: 0.9, side: THREE.BackSide });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.35 });
    const tongueMat = new THREE.MeshStandardMaterial({ color: 0xa04a4f, roughness: 0.5 });
    const browMat = new THREE.MeshStandardMaterial({ color: 0x3b2618, roughness: 0.9 });
    const clothMat = new THREE.MeshStandardMaterial({ color: 0x33475e, roughness: 0.85 });

    // --- Head: a deformed sphere with a jaw morph target and a cheek-raise (smile) target.
    const geo = new THREE.SphereGeometry(1, 160, 120);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const jaw = new Float32Array(pos.count * 3);
    const cheeks = new Float32Array(pos.count * 3);
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      headPoint(pos.getX(i), pos.getY(i), pos.getZ(i), 0, p);
      headPoint(pos.getX(i), pos.getY(i), pos.getZ(i), 1, q);
      cheeks.set([q.x - p.x, q.y - p.y, q.z - p.z], i * 3);
      q.copy(p);
      const w = jawWeight(p);
      rotateJaw(q, JAW_MAX * w);
      jaw.set([q.x - p.x, q.y - p.y, q.z - p.z], i * 3);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    geo.morphAttributes.position = [new THREE.BufferAttribute(jaw, 3), new THREE.BufferAttribute(cheeks, 3)];
    geo.morphTargetsRelative = true;
    geo.computeVertexNormals();
    this.headMesh = new THREE.Mesh(geo, skin);
    this.headMesh.castShadow = true;
    this.head.add(this.headMesh);

    // --- Mouth interior: a dark cavity, teeth on an arc, a tongue on the jaw.
    const front = surfaceZ(0, MOUTH_Y);
    // Upper cavity on the skull, lower one on the jaw, both kept inside the skin at any opening.
    const cavity = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 24), dark);
    cavity.scale.set(0.85, 0.5, 0.8);
    cavity.position.set(0, MOUTH_Y + 0.02, front - 0.33);
    this.head.add(cavity);
    const teethArc = (y: number, h: number) => {
      const g = new THREE.CylinderGeometry(0.22, 0.22, h, 40, 1, true, -0.75, 1.5);
      const m = new THREE.Mesh(g, toothMat);
      m.position.set(0, y, front - 0.03 - 0.22);
      return m;
    };
    const upperTeeth = teethArc(MOUTH_Y + 0.018, 0.04);
    upperTeeth.material = toothMat.clone();
    (upperTeeth.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    this.head.add(upperTeeth);
    this.lowerTeeth = new THREE.Group();
    this.lowerTeeth.position.copy(JAW_PIVOT);
    const lt = teethArc(MOUTH_Y - 0.022, 0.035);
    lt.position.sub(JAW_PIVOT);
    (lt.material as THREE.MeshStandardMaterial) = toothMat.clone();
    (lt.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    this.lowerTeeth.add(lt);
    const lowerCavity = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 24), dark);
    lowerCavity.scale.set(0.8, 0.45, 0.75);
    lowerCavity.position.set(0, MOUTH_Y - 0.06, front - 0.33).sub(JAW_PIVOT);
    this.lowerTeeth.add(lowerCavity);
    this.tongue = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), tongueMat);
    this.tongue.scale.set(1, 0.3, 1);
    this.tongue.position.set(0, MOUTH_Y - 0.06, front - 0.24).sub(JAW_PIVOT);
    this.lowerTeeth.add(this.tongue);
    this.head.add(this.lowerTeeth);

    // --- Lips.
    this.lips = new THREE.Mesh(lipGeometry(), lipMat);
    this.lips.castShadow = true;
    this.head.add(this.lips);

    // --- Eyes: eyeball with a painted iris and clear-coat highlight, pupil disc, eyelid caps.
    for (const side of [1, -1]) {
      const centre = new THREE.Vector3(side * EYE_X, EYE_Y, surfaceZ(side * EYE_X, EYE_Y) - 0.06);
      this.eyeCentres[side === 1 ? 0 : 1].copy(centre);
      const eye = new THREE.Group();
      eye.position.copy(centre);
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(EYE_RADIUS, 48, 32),
        new THREE.MeshPhysicalMaterial({ map: eyeTexture('#5b7f4a'), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03 }),
      );
      eye.add(ball);
      const pupil = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0x050505 }));
      pupil.position.z = EYE_RADIUS * 0.996;
      eye.add(pupil);
      this.pupils.push(pupil);
      this.head.add(eye);
      this.eyes.push(eye);

      const lidGeo = (start: number, length: number) => new THREE.SphereGeometry(EYE_RADIUS * 1.07, 40, 16, 0, Math.PI * 2, start, length);
      const upper = new THREE.Mesh(lidGeo(0, 1.25), skin);
      const lower = new THREE.Mesh(lidGeo(1.95, Math.PI - 1.95), skin);
      for (const lid of [upper, lower]) {
        lid.position.copy(centre);
        this.head.add(lid);
      }
      this.upperLids.push(upper);
      this.lowerLids.push(lower);

      // Brow: a tube along an arc over the eye, with raise and frown morph targets.
      const browPath = (raise: number, frown: number) => {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 12; i++) {
          const u = i / 12; // 0 inner … 1 outer
          const x = side * (0.1 + 0.34 * u);
          const inner = 1 - u;
          const y = 0.33 + 0.05 * Math.sin(Math.PI * (0.25 + 0.75 * u)) + raise * (0.06 + 0.02 * inner) - frown * 0.05 * inner;
          pts.push(new THREE.Vector3(x - side * frown * 0.02 * inner, y, surfaceZ(x, y) + 0.012));
        }
        return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.022, 6, false);
      };
      const browGeo = browPath(0, 0);
      const raiseGeo = browPath(1, 0);
      const frownGeo = browPath(0, 1);
      const basePos = browGeo.attributes.position.array as Float32Array;
      const rel = (g: THREE.BufferGeometry) => {
        const a = g.attributes.position.array as Float32Array;
        return new THREE.BufferAttribute(a.map((v, i) => v - basePos[i]), 3);
      };
      browGeo.morphAttributes.position = [rel(raiseGeo), rel(frownGeo)];
      browGeo.morphTargetsRelative = true;
      const brow = new THREE.Mesh(browGeo, browMat);
      this.browBase.push(basePos);
      this.brows.push(brow);
      this.head.add(brow);
    }

    // --- Ears: flattened ellipsoids with a darker inner bowl.
    for (const side of [1, -1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), skin);
      ear.scale.set(0.06, 0.2, 0.13);
      ear.position.set(side * 0.83, 0.02, -0.08);
      ear.rotation.y = side * 0.35;
      this.head.add(ear);
    }

    // --- Neck and shoulders (static) under the head, which pivots at the top of the neck.
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.9, 32), new THREE.MeshStandardMaterial({ color: 0xd9a383, roughness: 0.62 }));
    neck.position.set(0, -1.15, -0.12);
    this.shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.5, 8, 24), clothMat);
    this.shoulders.rotation.z = Math.PI / 2;
    this.shoulders.scale.set(1, 1, 0.75);
    this.shoulders.position.set(0, -1.75, -0.15);
    this.root.add(neck, this.shoulders);
    this.head.position.set(0, -0.72, -0.1);
    this.headMesh.position.set(0, 0.72, 0.1);
    for (const c of this.head.children) if (c !== this.headMesh) c.position.add(new THREE.Vector3(0, 0.72, 0.1));
    this.eyeCentres.forEach((c) => c.add(new THREE.Vector3(0, 0.72, 0.1)));
    this.root.add(this.head);
  }

  /** World position of the point between the eyes. */
  eyeMid(out: THREE.Vector3): THREE.Vector3 {
    return out.addVectors(this.eyeCentres[0], this.eyeCentres[1]).multiplyScalar(0.5).applyMatrix4(this.head.matrixWorld);
  }

  update(s: FaceState): void {
    // --- Head pose.
    this.head.rotation.set(THREE.MathUtils.degToRad(-s.headPitch), THREE.MathUtils.degToRad(s.headYaw), THREE.MathUtils.degToRad(s.headRoll), 'YXZ');
    this.shoulders.position.y = -1.75 + 0.008 * Math.sin(this.breathing);

    // --- Mouth: morph weights on the lips, jaw on the head, and the matching hole uniforms.
    const lipInfluences = this.lips.morphTargetInfluences!;
    const blended: MouthShape = { open: 0, width: 0, protrude: 0, press: 0, tuck: 0, upper: 0 };
    VISEMES.forEach((v, i) => {
      const w = s.visemes[v] ?? 0;
      lipInfluences[i] = v === 'sil' ? 0 : w;
      const m = MOUTH_SHAPES[v];
      for (const k of Object.keys(blended) as (keyof MouthShape)[]) blended[k] += m[k] * w;
    });
    // sil is the base shape (all zeros); the other weights are normalised if they add up past 1.
    lipInfluences[VISEMES.length] = s.smile;
    const total = VISEMES.reduce((a, v) => a + (v === 'sil' ? 0 : s.visemes[v] ?? 0), 0);
    if (total > 1) {
      for (let i = 0; i < VISEMES.length; i++) lipInfluences[i] /= total;
      for (const k of Object.keys(blended) as (keyof MouthShape)[]) blended[k] /= total;
    }
    const c = lipCurves(blended);
    // The lip tubes are thick: open the skin only once the inner edges have actually parted.
    this.uniforms.uMouth.value.set(c.halfWidth * (1 + 0.04 * s.smile), Math.max(0, c.gapUpper - 0.004), Math.max(0, c.gapLower - 0.004), c.jaw);
    const head = this.headMesh.morphTargetInfluences!;
    head[0] = blended.open;
    head[1] = s.smile;
    this.lowerTeeth.rotation.x = c.jaw;

    // --- Eyes: each aims at the fixation point, so they converge on near targets.
    const yaw = THREE.MathUtils.degToRad(s.eyeYaw);
    const pitch = THREE.MathUtils.degToRad(s.eyePitch);
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const mid = new THREE.Vector3().addVectors(this.eyeCentres[0], this.eyeCentres[1]).multiplyScalar(0.5);
    const fixation = mid.addScaledVector(dir, Math.max(0.3, s.fixationDistance));
    const up = new THREE.Vector3(0, 1, 0);
    this.eyes.forEach((eye, i) => {
      const d = new THREE.Vector3().subVectors(fixation, this.eyeCentres[i]).normalize();
      lookRotation(d, up, eye.quaternion);
      const r = EYE_RADIUS * (0.16 + 0.12 * s.pupil);
      this.pupils[i].scale.set(r, r, 1);
    });

    // --- Lids: the upper lid follows the eye's pitch (so looking down lowers it), and both close in a blink.
    // Rotating a lid cap about x moves its edge by the same angle.
    const lidPitch = Math.max(-0.5, Math.min(0.4, pitch));
    const upperFollow = -lidPitch * 0.85 - 0.06 * s.smile;
    const lowerFollow = -lidPitch * 0.35 - 0.12 * s.smile;
    // Edges rest at 1.25 rad (upper) and 1.95 rad (lower) from the top; closed, both pass 1.82 so they overlap.
    for (let i = 0; i < 2; i++) {
      this.upperLids[i].rotation.x = upperFollow + (0.6 - upperFollow) * s.blink;
      this.lowerLids[i].rotation.x = lowerFollow + (-0.13 - lowerFollow) * s.blink;
    }

    // --- Brows.
    for (const brow of this.brows) {
      brow.morphTargetInfluences![0] = Math.max(0, s.brow);
      brow.morphTargetInfluences![1] = Math.max(0, -s.brow);
    }
  }
}
