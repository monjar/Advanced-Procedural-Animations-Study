# Procedural Face

A face with no animation data: the eyes, lids, head and mouth are driven by models of how people move them. The
gaze model makes saccades with human statistics, holds fixations while the head moves, and blinks at human rates.
The mouth lip-syncs to whatever it hears — its own synthesized voice, a dropped audio file or your microphone —
by tracking formants, with no speech recognition.

## Eyes and head (`gaze.ts`)

Gaze (where the eyes point in the world) changes only through saccades, smooth pursuit and fixational jitter;
the head follows large shifts on a slower spring. The eye-in-head angle is gaze − head, so while the head catches
up the eyes counter-rotate and the fixation holds — the vestibulo-ocular reflex falls out of the representation.

| behaviour | model | source |
|---|---|---|
| saccade duration | D = 21 ms + 2.2 ms/° · A, minimum-jerk profile | Carpenter (1988), the "main sequence" |
| saccade size | exponential, mean 7.6°, so 86 % are ≤ 15° | Bahill, Adler & Stark (1975) |
| conversation | alternate mutual gaze (scanning eyes and mouth) and gaze aversion; listeners hold it longer | Argyle & Cook (1976) |
| fixation | drift plus microsaccades (0.1–0.8°, ~1.4/s) | Martinez-Conde et al. (2004) |
| head | joins shifts beyond ~12°; forced along at the oculomotor limit (±40° yaw, ±28° pitch), within ±75° yaw, −40…45° pitch | Freedman & Sparks (1997) |
| blinks | 17/min at rest, 26/min talking, 0.6 s refractory; gaze-evoked for large shifts; 70 ms close, 160 ms open | Bentivoglio et al. (1997) |
| lids | the upper lid follows the eye's pitch — look down and it lowers | |

The interval distributions are tuned to reproduce those statistics, not fitted to eye-tracking data (the
fitted curves of Lee et al.'s *Eyes Alive* were not available to me while building this). Measured over ten
simulated minutes:

| | measured | target |
|---|---|---|
| saccades ≤ 15° | 89–94 % | ~86 % |
| blinks / min (rest, talking) | 16.9, 24.3 | 17, 26 |
| mutual gaze (talking, listening) | 46 %, 73 % | ~40 %, ~75 % |
| gaze speed while the head turns at > 20°/s | < 25°/s outside saccades | fixation held |
| pursuit of a target moving up to 12°/s | median error < 1.5° | |

## Voice (`voice.ts`)

A tiny formant synthesizer, so lip-sync can be scored against ground truth. Letter rules turn text into
phonemes; each phoneme has formant targets (Peterson & Barney 1952), voicing and frication amplitudes and a
viseme label. A Rosenberg glottal pulse feeds three cascaded Klatt resonators; fricatives and plosive bursts are
noise through a band resonator; formants glide between phonemes with a 25 ms time constant. A higher voice
scales its formants by up to ×1.17. It sounds like a 1970s robot, and it knows what its mouth is doing every
millisecond.

## Lip-sync from audio (`lipsync.ts`)

Each 32 ms frame (16 kHz) is reduced to a few features:

- **Formants.** Pre-emphasis, Hamming window, autocorrelation, Levinson–Durbin to a 14th-order LPC polynomial,
  its roots by Durand–Kerner, resonances below 500 Hz bandwidth; F1 and F2 are the first two.
- **Pitch and voicing.** Normalised autocorrelation peak in 60–400 Hz. The pitch also sets the speaker's formant
  scale, so a high voice is not read as a wide-open jaw.
- **Noise.** FFT energy in four bands.

Then the phonetics does the work. F1 rises as the jaw opens and F2 rises as the lips spread, so a voiced frame
is soft-assigned to aa / E / I / O / U by its distance in (F1, F2). Noise is SS (energy above 4.5 kHz), CH
(2.5–4.5 kHz) or FF. A voiced murmur with no energy above 1 kHz is m or b behind closed lips, so → PP. Silence
closes the mouth. Loudness comes from the newest 10 ms, so a closure shows at once. Weights pass through
critically damped springs (35 ms rising, 18 ms falling — lips shut fast).

| five synthesized sentences, 120 Hz voice (the 210 Hz voice passes the same test thresholds) | result |
|---|---|
| formants of steady vowels (F1, F2) | within 20 %, 8 % of the synthesizer's |
| vowel frames classified correctly | 87 % |
| s / sh frames classified correctly | 99 % |
| p / b / m closures with the mouth shut | 76 % |
| jaw opening vs ground truth (correlation) | r = 0.89 |

**Latency matters more than cleverness.** A causal 32 ms window lags what is being said, and scoring against
the truth at the same instant drops vowel accuracy to 68 % and the jaw correlation to 0.80. Delaying the *audio
output* by 25–35 ms (a DelayNode after the analyser) puts sound and mouth back together. That is what the page
does for the voice and for files; the microphone is not delayed, because you hear yourself directly. Faster
release smoothing traded a little jaw correlation (0.92 → 0.89) for closing the lips on plosives (37 % → 76 %).

## The face (`face.ts`)

- **Head.** A sphere deformed by a handful of Gaussian bumps: sockets, brow, nose, cheeks, muzzle, chin.
- **Mouth.** The lips are two tubes, and each of the 14 visemes is a morph target generated from six
  mouth parameters (jaw, width, protrusion, press, lower-lip tuck, upper-lip raise); smile is one more.
  The jaw is a morph target on the head, hinged near the ear. Every parameter enters the geometry linearly,
  so blending morph targets on the GPU is the same as blending parameters. That lets the head's fragment
  shader cut the mouth opening exactly where the blended lips part, revealing the teeth, tongue and cavity.
- **Eyes.** Eyeballs with a painted iris and clear-coat highlights, aimed separately at the fixation point
  (they converge on near targets), with eyelid caps and pupils.
- **Head motion.** Slow noise sway, nods on loudness onsets, and brows lifting with pitch rises (Cavé et al. 1996).

A few bugs worth recording.

- **The head shook when seen from far above or below.** There were three feedback loops:
  - When the eyes hit their range limit, the shortfall was added to the head's goal on every frame while the
    head was still catching up, so it overshot.
  - Each saccade also pulled the head's pitch goal 20 % back toward level, which put the eyes over the limit
    again.
  - Targets were measured from the eyes' current position. The head pivots at the neck, so turning it moved the
    eyes, and the head's own motion shifted its target.

  Now the goal moves just far enough to keep the target within the eyes' reach, judged against the goal rather
  than the lagging head. Targets are measured from the eyes' rest position.
- **The head trembled when following a cursor near the top or bottom of the screen.** Two rules for the head's
  goal reset each other on alternate frames. Cursor tracking now only moves the goal toward the target.
- **The lip tubes were built with inward-facing triangles.** The GPU culled the near half and drew the far
  half behind the skin, so a ray cast through the lips found only the tube's back wall.
- **The jaw first hinged far behind the head.** It swung the chin back, so the mouth cavity showed through the
  skin. Moving the hinge to where the real joint is fixed it.

## Failure modes

- The vowel model is five vowels in (F1, F2); diphthongs, r-colouring and nasal vowels are approximate.
- Consonants the analysis cannot hear (t vs k, l, th) all map to a half-open mouth.
- Real voices vary more than the pitch-based formant scale corrects; noisy rooms raise the floor tracker.
- The face is stylised; the lids are rigid caps, not skin.

## References

- S. Lee, J. Badler, N. Badler, *Eyes Alive* (SIGGRAPH 2002)
- K. Ruhland et al., *A Review of Eye Gaze in Virtual Agents, Social Robotics and HCI* (2015)
- R. H. S. Carpenter, *Movements of the Eyes* (1988); A. T. Bahill, D. Adler, L. Stark, *Most naturally occurring human saccades have magnitudes of 15 degrees or less* (1975)
- A. R. Bentivoglio et al., *Analysis of blink rate patterns in normal subjects* (1997); M. Argyle, M. Cook, *Gaze and Mutual Gaze* (1976)
- S. Martinez-Conde et al., *The role of fixational eye movements in visual perception* (2004); E. G. Freedman, D. L. Sparks, *Eye-head coordination during head-unrestrained gaze shifts* (1997)
- G. E. Peterson, H. L. Barney, *Control methods used in a study of the vowels* (1952); D. H. Klatt, *Software for a cascade/parallel formant synthesizer* (1980)
- C. Cavé et al., *About the relationship between eyebrow movements and F0 variations* (1996)
