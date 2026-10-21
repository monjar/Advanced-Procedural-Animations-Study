import type { Program } from './program';

/**
 * Example prompts with programs, so the page works without an API key. They were written by Claude (the model
 * that built this study) in the same schema and checked by the same validator — they are not recorded API
 * responses. With a key, the same prompts go to the API instead.
 */
export const EXAMPLES: { prompt: string; program: Program }[] = [
  {
    prompt: 'Walk over to the red cube and touch it, then turn around and wave at me.',
    program: {
      summary: 'Walks to the red cube, touches it, turns to face you and waves.',
      steps: [
        { action: 'walk_to', target: 'red_cube', speed: 1.3 },
        { action: 'reach_for', target: 'red_cube', hand: 'either', seconds: 1.5 },
        { action: 'turn_to', target: 'camera' },
        { action: 'look_at', target: 'camera' },
        { action: 'wave', hand: 'right', times: 3 },
      ],
    },
  },
  {
    prompt: 'Run to the yellow pillar, point at the street lamp, then nod.',
    program: {
      summary: 'Runs to the yellow pillar, points at the street lamp and nods.',
      steps: [
        { action: 'walk_to', target: 'yellow_pillar', speed: 3.5 },
        { action: 'look_at', target: 'lamp' },
        { action: 'point_at', target: 'lamp', hand: 'either', seconds: 2 },
        { action: 'nod', times: 2 },
      ],
    },
  },
  {
    prompt: 'Look at the blue ball and shake your head, then stroll to the bench while looking at me.',
    program: {
      summary: 'Looks at the blue ball and shakes its head, then strolls to the bench watching you.',
      steps: [
        { action: 'look_at', target: 'blue_ball' },
        { action: 'shake_head', times: 2 },
        { action: 'walk_to', target: 'bench', speed: 0.6 },
        { action: 'look_at', target: 'camera', with_previous: true },
      ],
    },
  },
  {
    prompt: 'Point at every object on the plaza, one after another.',
    program: {
      summary: 'Points at each of the six objects in turn.',
      steps: [
        { action: 'look_at', target: 'red_cube' },
        { action: 'point_at', target: 'red_cube', hand: 'either', seconds: 1.2 },
        { action: 'look_at', target: 'blue_ball' },
        { action: 'point_at', target: 'blue_ball', hand: 'either', seconds: 1.2 },
        { action: 'turn_to', target: 'green_cone' },
        { action: 'point_at', target: 'green_cone', hand: 'either', seconds: 1.2 },
        { action: 'turn_to', target: 'yellow_pillar' },
        { action: 'point_at', target: 'yellow_pillar', hand: 'either', seconds: 1.2 },
        { action: 'turn_to', target: 'lamp' },
        { action: 'point_at', target: 'lamp', hand: 'either', seconds: 1.2 },
        { action: 'turn_to', target: 'bench' },
        { action: 'point_at', target: 'bench', hand: 'either', seconds: 1.2 },
      ],
    },
  },
  {
    prompt: 'Wave at me with both hands!',
    program: {
      summary: 'Faces you and waves with both hands at once.',
      steps: [
        { action: 'turn_to', target: 'camera' },
        { action: 'look_at', target: 'camera', with_previous: true },
        { action: 'wave', hand: 'left', times: 4 },
        { action: 'wave', hand: 'right', times: 4, with_previous: true },
      ],
    },
  },
  {
    prompt: 'Go to the green cone, look up at the street lamp and point at it with your left hand.',
    program: {
      summary: 'Walks to the green cone, looks up at the lamp and points at it with the left hand.',
      steps: [
        { action: 'walk_to', target: 'green_cone', speed: 1.3 },
        { action: 'turn_to', target: 'lamp' },
        { action: 'look_at', target: 'lamp', with_previous: true },
        { action: 'point_at', target: 'lamp', hand: 'left', seconds: 2.5 },
      ],
    },
  },
  {
    prompt: 'Jump up and down with excitement!',
    program: {
      summary: 'Cannot jump, so it does the closest thing: an excited wave with both hands and a quick nod.',
      steps: [
        { action: 'turn_to', target: 'camera' },
        { action: 'look_at', target: 'camera', with_previous: true },
        { action: 'wave', hand: 'left', times: 5 },
        { action: 'wave', hand: 'right', times: 5, with_previous: true },
        { action: 'nod', times: 3, with_previous: true },
      ],
    },
  },
  {
    prompt: 'Face me, wave twice, then walk to the ball and pick it up.',
    program: {
      summary: 'Faces you, waves twice, walks to the blue ball and reaches for it (it cannot lift things).',
      steps: [
        { action: 'turn_to', target: 'camera' },
        { action: 'wave', hand: 'right', times: 2 },
        { action: 'walk_to', target: 'blue_ball', speed: 1.3 },
        { action: 'look_at', target: 'blue_ball' },
        { action: 'reach_for', target: 'blue_ball', hand: 'either', seconds: 2 },
      ],
    },
  },
];
