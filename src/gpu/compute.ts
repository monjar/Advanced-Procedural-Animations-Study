import * as THREE from 'three';

/**
 * Minimal WebGL2 GPGPU: RGBA32F render targets (one texel per element, nearest filtering, read with
 * `texelFetch` and integer indices) and full-screen passes with raw GLSL 3 shaders, so a pass can write
 * several targets at once (`layout(location = n) out`).
 */

const VERTEX = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class Compute {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly mesh: THREE.Mesh;

  constructor(readonly renderer: THREE.WebGLRenderer) {
    // One triangle covering the viewport.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(geo);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** Float render target of w × h texels with `count` colour attachments. */
  target(width: number, height: number, count = 1): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, height, {
      count,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
  }

  /** A pass from a fragment shader body (GLSL 3; declare `out` variables yourself). */
  pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float;\n${VERTEX}`,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
  }

  run(material: THREE.Material, target: THREE.WebGLRenderTarget): void {
    const previous = this.renderer.getRenderTarget();
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(previous);
    this.renderer.autoClear = autoClear;
  }

  /** Read a target back (RGBA floats); `attachment` selects a colour attachment of an MRT target. */
  read(target: THREE.WebGLRenderTarget, attachment = 0): Float32Array {
    const out = new Float32Array(target.width * target.height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, out, undefined, attachment);
    return out;
  }

  /** Upload data into a target by drawing a DataTexture through a copy pass. */
  upload(target: THREE.WebGLRenderTarget, data: Float32Array): void {
    const tex = new THREE.DataTexture(data, target.width, target.height, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    const copy = this.pass(
      /* glsl */ `precision highp float;
uniform sampler2D src;
out vec4 outValue;
void main() { outValue = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }`,
      { src: { value: tex } },
    );
    this.run(copy, target);
    copy.dispose();
    tex.dispose();
  }
}
