import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Body length of the fish mesh (m); the mesh points along +Z (head at +L/2). */
export const FISH_LENGTH = 0.5;

/** Low-poly fish: a stretched ellipsoid body, a forked tail and a dorsal fin (≈ 100 vertices). */
export function fishGeometry(): THREE.BufferGeometry {
  const L = FISH_LENGTH;
  const body = new THREE.SphereGeometry(1, 10, 6);
  body.scale(0.07, 0.11, L * 0.42);
  body.deleteAttribute('uv');
  const fin = (verts: number[]) => {
    const g = new THREE.BufferGeometry();
    // Two-sided: both windings.
    const v = [...verts];
    for (let i = 0; i < verts.length; i += 9) v.push(...verts.slice(i + 6, i + 9), ...verts.slice(i + 3, i + 6), ...verts.slice(i, i + 3));
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    return g;
  };
  const z0 = -L * 0.38;
  const tail = fin([0, 0, z0, 0, 0.11, -L * 0.55, 0, 0.01, -L * 0.45, 0, 0, z0, 0, -0.01, -L * 0.45, 0, -0.11, -L * 0.55]);
  const dorsal = fin([0, 0.1, L * 0.05, 0, 0.17, -L * 0.12, 0, 0.09, -L * 0.18]);
  const g = mergeGeometries([body.toNonIndexed(), tail, dorsal])!;
  g.computeBoundingSphere();
  return g;
}

const VERTEX = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
in vec3 normal;
in float aIndex;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D posTex;
uniform sampler2D velTex;
uniform int width;
uniform int log2Width;
uniform float maxSpeed;
uniform float bodyLength;
uniform float scale;
uniform float swim;
uniform int colorMode;
out vec3 vNormal;
out vec3 vColor;
out float vDepth;

vec3 hue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  int id = int(aIndex);
  ivec2 xy = ivec2(id & (width - 1), id >> log2Width);
  vec4 P = texelFetch(posTex, xy, 0);
  vec4 V = texelFetch(velTex, xy, 0);
  vec3 fwd = normalize(V.xyz + vec3(0.0, 0.0, 1e-5));
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), fwd) + vec3(1e-5, 0.0, 0.0));
  vec3 up = cross(fwd, side);
  float speed = length(V.xyz) / maxSpeed;

  // Swim: a wave travelling head → tail, amplitude growing towards the tail and with speed.
  vec3 lp = position;
  float u = clamp(0.5 - lp.z / bodyLength, 0.0, 1.0);         // 0 head … 1 tail
  float amp = swim * (0.03 + 0.09 * speed) * bodyLength;
  float wave = sin(V.w * 2.0 - u * 5.0);
  lp.x += amp * u * u * wave;
  // Slope of the displacement, to bend the normals with the body.
  float slope = amp * (2.0 * u * wave - u * u * 5.0 * cos(V.w * 2.0 - u * 5.0)) / bodyLength;
  vec3 n = normalize(normal + vec3(slope * normal.z, 0.0, 0.0));

  vec3 world = P.xyz + (side * lp.x + up * lp.y + fwd * lp.z) * scale;
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  vNormal = normalize(mat3(modelViewMatrix) * (side * n.x + up * n.y + fwd * n.z));
  vDepth = -mv.z;
  float h = fract(float(id) * 0.61803);
  if (colorMode == 1) {
    // Neighbour count (0 → blue, cap → red).
    vColor = mix(vec3(0.2, 0.45, 1.0), vec3(1.0, 0.3, 0.2), clamp(P.w / 24.0, 0.0, 1.0));
  } else {
    vColor = mix(vec3(0.62, 0.72, 0.8), hue(0.52 + h * 0.12), 0.35) * (0.8 + 0.4 * h);
  }
  vColor *= 0.85 + 0.25 * smoothstep(-0.02, 0.06, position.y); // darker belly … lighter back
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in float vDepth;
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 lightDir;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float diff = max(dot(n, lightDir), 0.0);
  float rim = pow(1.0 - abs(n.z), 3.0);
  vec3 c = vColor * (0.35 + 0.75 * diff) + rim * 0.15;
  float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
  outColor = vec4(mix(c, fogColor, fog), 1.0);
}
`;

export interface FishMaterialOptions {
  maxSpeed: number;
  fogColor: THREE.Color;
  fogDensity: number;
}

/** Instanced fish reading position/velocity textures by instance index. */
export function fishMesh(n: number, width: number, opts: FishMaterialOptions): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.RawShaderMaterial> {
  const base = fishGeometry();
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('normal', base.getAttribute('normal'));
  geo.setAttribute('aIndex', new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, (_, i) => i), 1));
  geo.instanceCount = n;
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.DoubleSide,
    uniforms: {
      posTex: { value: null },
      velTex: { value: null },
      width: { value: width },
      log2Width: { value: Math.log2(width) },
      maxSpeed: { value: opts.maxSpeed },
      bodyLength: { value: FISH_LENGTH },
      scale: { value: 1 },
      swim: { value: 1 },
      colorMode: { value: 0 },
      fogColor: { value: opts.fogColor },
      fogDensity: { value: opts.fogDensity },
      lightDir: { value: new THREE.Vector3(0.3, 1, 0.4).normalize() },
    },
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}
