import * as THREE from 'three';

const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();

/** Growable vertex buffer feeding a single draw call. */
class Batch {
  positions: Float32Array;
  colors: Float32Array;
  count = 0;
  readonly geometry = new THREE.BufferGeometry();

  constructor(capacity: number) {
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.bind();
  }

  push(p: THREE.Vector3, c: THREE.Color): void {
    if (this.count * 3 >= this.positions.length) this.grow();
    const i = this.count * 3;
    this.positions[i] = p.x;
    this.positions[i + 1] = p.y;
    this.positions[i + 2] = p.z;
    this.colors[i] = c.r;
    this.colors[i + 1] = c.g;
    this.colors[i + 2] = c.b;
    this.count++;
  }

  flush(): void {
    this.geometry.setDrawRange(0, this.count);
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private grow(): void {
    const p = new Float32Array(this.positions.length * 2);
    const c = new Float32Array(this.colors.length * 2);
    p.set(this.positions);
    c.set(this.colors);
    this.positions = p;
    this.colors = c;
    this.bind();
  }

  private bind(): void {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
  }
}

/**
 * Immediate-mode debug renderer. Draw calls made during a frame are shown for that
 * frame only: the app resets before frame callbacks and flushes before rendering.
 */
export class DebugDraw extends THREE.Group {
  private readonly lineBatch = new Batch(4096);
  private readonly pointBatch = new Batch(512);

  constructor() {
    super();
    this.name = 'debug-draw';
    const lines = new THREE.LineSegments(
      this.lineBatch.geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    const points = new THREE.Points(
      this.pointBatch.geometry,
      new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false }),
    );
    for (const o of [lines, points]) {
      o.frustumCulled = false;
      o.renderOrder = 999;
      this.add(o);
    }
  }

  reset(): void {
    this.lineBatch.count = 0;
    this.pointBatch.count = 0;
  }

  flush(): void {
    this.lineBatch.flush();
    this.pointBatch.flush();
  }

  line(a: THREE.Vector3, b: THREE.Vector3, color: THREE.ColorRepresentation = 0xffffff): void {
    if (!this.visible) return;
    _c.set(color);
    this.lineBatch.push(a, _c);
    this.lineBatch.push(b, _c);
  }

  polyline(points: readonly THREE.Vector3[], color: THREE.ColorRepresentation = 0xffffff, closed = false): void {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1], points[i], color);
    if (closed && points.length > 2) this.line(points[points.length - 1], points[0], color);
  }

  point(p: THREE.Vector3, color: THREE.ColorRepresentation = 0xffffff): void {
    if (!this.visible) return;
    this.pointBatch.push(p, _c.set(color));
  }

  arrow(from: THREE.Vector3, to: THREE.Vector3, color: THREE.ColorRepresentation = 0xffffff, head = 0.08): void {
    this.line(from, to, color);
    const dir = _a.subVectors(to, from);
    const len = dir.length();
    if (len < 1e-6) return;
    dir.divideScalar(len);
    perpendicular(dir, _u);
    _v.crossVectors(dir, _u);
    const h = Math.min(head, len * 0.4);
    for (const side of [_u, _v]) {
      for (const sign of [1, -1]) {
        _b.copy(to).addScaledVector(dir, -h).addScaledVector(side, sign * h * 0.5);
        this.line(to, _b.clone(), color);
      }
    }
  }

  circle(
    center: THREE.Vector3,
    normal: THREE.Vector3,
    radius: number,
    color: THREE.ColorRepresentation = 0xffffff,
    segments = 32,
  ): void {
    const n = _a.copy(normal).normalize();
    perpendicular(n, _u);
    _v.crossVectors(n, _u);
    let prev = new THREE.Vector3().copy(center).addScaledVector(_u, radius);
    for (let i = 1; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const p = new THREE.Vector3()
        .copy(center)
        .addScaledVector(_u, Math.cos(t) * radius)
        .addScaledVector(_v, Math.sin(t) * radius);
      this.line(prev, p, color);
      prev = p;
    }
  }

  sphere(center: THREE.Vector3, radius: number, color: THREE.ColorRepresentation = 0xffffff): void {
    this.circle(center, X, radius, color);
    this.circle(center, Y, radius, color);
    this.circle(center, Z, radius, color);
  }

  axes(position: THREE.Vector3, quaternion: THREE.Quaternion, size = 0.25): void {
    const end = new THREE.Vector3();
    this.line(position, end.copy(X).applyQuaternion(quaternion).multiplyScalar(size).add(position), 0xff5555);
    this.line(position, end.copy(Y).applyQuaternion(quaternion).multiplyScalar(size).add(position), 0x55ff77);
    this.line(position, end.copy(Z).applyQuaternion(quaternion).multiplyScalar(size).add(position), 0x5599ff);
  }
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** Any unit vector perpendicular to `n` (n must be normalised). */
function perpendicular(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(Math.abs(n.y) < 0.9 ? Y : X);
  return out.addScaledVector(n, -out.dot(n)).normalize();
}
