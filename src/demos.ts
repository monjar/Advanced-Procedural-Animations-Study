export type Tier = 'Foundations' | 'Procedural Locomotion' | 'Data-Driven' | 'Physics-Based' | 'Learned' | 'Beyond the Roadmap';

export interface DemoInfo {
  id: string;
  slug: string;
  title: string;
  tier: Tier;
  summary: string;
  tags: string[];
  status: 'live' | 'planned';
}

export const TIERS: Tier[] = ['Foundations', 'Procedural Locomotion', 'Data-Driven', 'Physics-Based', 'Learned', 'Beyond the Roadmap'];

export const DEMOS: DemoInfo[] = [
  {
    id: '01',
    slug: '01-second-order-dynamics',
    title: 'Second-Order Dynamics',
    tier: 'Foundations',
    summary: 'Frame-rate-stable spring systems with frequency, damping and anticipation controls driving secondary motion.',
    tags: ['springs', 'secondary motion', 'stability'],
    status: 'live',
  },
  {
    id: '02',
    slug: '02-analytic-ik',
    title: 'Analytic IK: Two-Bone & Look-At',
    tier: 'Foundations',
    summary: 'Closed-form limb IK with pole vectors and soft-IK, plus cone-limited head and eye aiming.',
    tags: ['IK', 'law of cosines', 'swing-twist'],
    status: 'live',
  },
  {
    id: '03',
    slug: '03-iterative-ik',
    title: 'Iterative IK Lab',
    tier: 'Foundations',
    summary: 'CCD, FABRIK and Jacobian damped least squares side by side, with joint limits and convergence plots.',
    tags: ['IK', 'FABRIK', 'Jacobian'],
    status: 'live',
  },
  {
    id: '04',
    slug: '04-xpbd',
    title: 'XPBD Ropes, Tails & Cloth',
    tier: 'Foundations',
    summary: 'Compliant position-based dynamics for secondary motion pinned to animated characters.',
    tags: ['XPBD', 'cloth', 'physics'],
    status: 'live',
  },
  {
    id: '05',
    slug: '05-hexapod',
    title: 'Procedural Hexapod',
    tier: 'Procedural Locomotion',
    summary: 'Terrain-adaptive spider gait with raycast footholds that climbs walls and over their top edges.',
    tags: ['gait', 'foot placement', 'raycast'],
    status: 'live',
  },
  {
    id: '06',
    slug: '06-quadruped',
    title: 'Procedural Quadruped',
    tier: 'Procedural Locomotion',
    summary: 'Walk, trot, canter and gallop from a gait phase table with speed-driven transitions.',
    tags: ['gait', 'phase', 'spine'],
    status: 'live',
  },
  {
    id: '07',
    slug: '07-biped',
    title: 'Procedural Biped',
    tier: 'Procedural Locomotion',
    summary: 'Overgrowth-style locomotion from a few key poses, a stride wheel and springs.',
    tags: ['stride wheel', 'springs', 'biped'],
    status: 'live',
  },
  {
    id: '08',
    slug: '08-foot-ik',
    title: 'Foot IK over Mocap',
    tier: 'Procedural Locomotion',
    summary: 'Contact detection, foot locking and pelvis adjustment layered over clip playback on slopes and stairs.',
    tags: ['layering', 'foot locking', 'mocap'],
    status: 'live',
  },
  {
    id: '09',
    slug: '09-motion-matching',
    title: 'Motion Matching',
    tier: 'Data-Driven',
    summary: 'Feature-database search over two minutes of CMU mocap with inertialized transitions and spring trajectories.',
    tags: ['motion matching', 'inertialization', 'mocap'],
    status: 'live',
  },
  {
    id: '10',
    slug: '10-active-ragdoll',
    title: 'Active Ragdoll',
    tier: 'Physics-Based',
    summary: 'Rapier capsules tracking mocap with motor muscles and PuppetMaster pins: hit it, knock it down, watch it recover.',
    tags: ['joint motors', 'Rapier', 'PuppetMaster'],
    status: 'live',
  },
  {
    id: '11',
    slug: '11-gpu-crowds',
    title: 'GPU Procedural Crowds',
    tier: 'Physics-Based',
    summary: 'Sixteen thousand boids on WebGL2 GPGPU — a bitonic-sorted spatial grid — with swim undulation in the vertex shader.',
    tags: ['GPGPU', 'boids', 'vertex animation'],
    status: 'live',
  },
  {
    id: '12',
    slug: '12-evolved-creatures',
    title: 'Evolved Virtual Creatures',
    tier: 'Physics-Based',
    summary: 'Karl Sims-style evolution of body plans and oscillator brains, simulated in Rapier across Web Workers.',
    tags: ['genetic algorithm', 'Rapier', 'workers'],
    status: 'live',
  },
  {
    id: '13',
    slug: '13-rl-locomotion',
    title: 'RL Locomotion Policy',
    tier: 'Learned',
    summary: 'A quadruped PPO policy trained offline in MuJoCo, running live in MuJoCo WASM: steer it, drag it, shove it.',
    tags: ['PPO', 'MuJoCo WASM', 'reinforcement learning'],
    status: 'live',
  },
  {
    id: '14',
    slug: '14-llm-directed',
    title: 'LLM-Directed Animation',
    tier: 'Learned',
    summary: 'Tell a procedural character what to do: Claude writes a schema-checked program over walk, look, point, reach and wave.',
    tags: ['LLM', 'structured output', 'procedural'],
    status: 'live',
  },
  {
    id: '15',
    slug: '15-procedural-face',
    title: 'Procedural Face',
    tier: 'Learned',
    summary: 'Saccades, blinks and eye–head coordination, and lip-sync from audio: formant tracking driving viseme morph targets.',
    tags: ['gaze', 'lip-sync', 'morph targets'],
    status: 'live',
  },
  {
    id: '16',
    slug: '16-learned-motion-matching',
    title: 'Learned Motion Matching',
    tier: 'Beyond the Roadmap',
    summary: 'Study 09 with the database replaced by three small networks — decompressor, stepper, projector — side by side with the original.',
    tags: ['neural networks', 'motion matching', 'compression'],
    status: 'live',
  },
  {
    id: '17',
    slug: '17-simbicon',
    title: 'Physics-Based Walker',
    tier: 'Beyond the Roadmap',
    summary: 'A torque-driven biped that balances by itself: SIMBICON state machine and balance feedback in MuJoCo. Push it, steer it.',
    tags: ['SIMBICON', 'balance', 'MuJoCo WASM'],
    status: 'live',
  },
  {
    id: '18',
    slug: '18-procedural-hands',
    title: 'Procedural Hands & Grasping',
    tier: 'Beyond the Roadmap',
    summary: 'A 21-joint hand plans grasps around shapes (autograsp closing, Ferrari–Canny ε, opposition), then lifts each in MuJoCo.',
    tags: ['grasping', 'force closure', 'MuJoCo'],
    status: 'live',
  },
  {
    id: '19',
    slug: '19-character-crowds',
    title: 'Character Crowds',
    tier: 'Beyond the Roadmap',
    summary: 'ORCA velocity-obstacle avoidance steering many procedural walkers through doors and crossings.',
    tags: ['ORCA', 'crowds', 'avoidance'],
    status: 'planned',
  },
];

export function demoById(id: string): DemoInfo {
  const demo = DEMOS.find((d) => d.id === id);
  if (!demo) throw new Error(`Unknown demo id: ${id}`);
  return demo;
}
