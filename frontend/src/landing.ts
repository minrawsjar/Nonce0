// opaque landing page — the pinned hero.
//
// Seventeen plates dissolving down one chain, wall through to wallet, with a rig
// of sixteen shards, three dust clouds and a debris sheet flying over the
// middle of it. ScrollTrigger pins the hero and scrubs one number through the
// whole thing, and `render` turns that number into a transform for every layer.
//
// Three things make it read as continuous rather than as a slideshow, and they
// were each arrived at by measuring rather than by adding more artwork:
//
//   * Scroll is spent in proportion to how much actually changes. The gaps in
//     the middle of the break move five times as much as the ones at the start,
//     so they get five times the scroll. See WALL_CUTS.
//   * Plates hand over the way stacked layers actually composite: the one
//     underneath stays fully opaque while the next fades in ON TOP. Fading both
//     at once — the obvious thing — dips the whole frame 25% toward black at
//     every midpoint, and sixteen of those dark pulses is exactly what "jerky"
//     looked like.
//   * The first six plates share a camera to the pixel, so those dissolves
//     change only the stone. The rest move the camera and are timed to land
//     inside the push, because a dissolve between two cameras is a jump when
//     nothing is moving and a cut on action when something is.
//
// The blast itself is not a dissolve at all: sixteen shards accelerating along
// sixteen trajectories off the real fracture line, continuous at any scroll
// speed and correct scrubbed backwards.
//
// The geometry below was art-directed against an offline compositor that draws
// these same layers with the same maths, so the numbers are the ones that were
// actually looked at rather than guesses.

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

/** How many viewport heights the sequence takes. Raise it to let every beat
 *  breathe; lower it to bring the wall down sooner. */
const SCROLL_LENGTH = '+=700%';

/** Where each dissolve between the plates begins, and how long each one takes.
 *  Seventeen plates, sixteen hand-overs, wall through to wallet.
 *
 *  These are not evenly spaced, and that is the point. Measuring the mean pixel
 *  change across each pair gives:
 *
 *      01->02   4.6    ii3->2.1 13.5    05->06  26.8    07->10  13.9
 *      02->ii1  8.4    2.1->03  27.7    06->i3  12.8    10->08  14.2
 *      ii1->ii2 5.5    03->04   32.5    i3->i4  10.4    08->09  12.7
 *      ii2->i1  8.3    04->05   31.4    i4->07  12.4
 *      i1->ii3  8.1
 *
 *  Note 03->04 and 04->05: at 32.5 and 31.4 they are the two biggest steps in
 *  the run by some way, and the obvious place for another frame if one is ever
 *  drawn. They do not lurch the way they used to only because they are given
 *  scroll in proportion — roughly a tenth of the whole hero each.
 *
 *  The middle hand-overs move five times as much as the first five. Given equal
 *  scroll they tear past five times as fast, and that unevenness is what read
 *  as the sequence lurching — no amount of extra plates at the start could fix
 *  it, because the start was never the problem.
 *
 *  So scroll is allocated in proportion to how much actually changes: each gap
 *  gets a share of the run matching its share of the total change. The result
 *  is a constant rate of change from the first crack to the wallet — ~298 units
 *  of change per unit of scroll across every single gap.
 *
 *  Fades scale with their gap for the same reason, capped so the big ones stay
 *  crisp. A fade must never be longer than the gap it sits in, or a third plate
 *  starts arriving before the first has finished leaving. */
const WALL_CUTS = [
  0.1, 0.1282, 0.1466, 0.1744, 0.2016, 0.2469, 0.3398, 0.4488,
  0.5541, 0.644, 0.6869, 0.7218, 0.7634, 0.81, 0.8576, 0.9002,
] as const;
const WALL_FADES = [
  0.024, 0.0156, 0.0236, 0.0231, 0.0385, 0.079, 0.09, 0.0895,
  0.0764, 0.0365, 0.0297, 0.0354, 0.0396, 0.0405, 0.0362, 0.09,
] as const;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
/** Progress through one window of the timeline, 0 before it and 1 after. */
const seg = (p: number, a: number, b: number): number => clamp01((p - a) / (b - a));
const easeIn = (t: number): number => t * t;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** One flying chunk. `x`/`y` are where it leaves the fracture as a percentage
 *  of the rig box, `angle` the direction it takes, `reach` how far it gets,
 *  `depth` how close to the lens it passes — which sets both how fast it goes
 *  and how large it swells on the way past. */
interface Shard {
  readonly rock: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly angle: number;
  readonly reach: number;
  readonly spin: number;
  readonly depth: number;
}

// Sixteen chunks, launched off the actual fracture in the plates rather than
// off a guessed line. The molten break is the only strongly orange thing in
// frame, so thresholding those images on hot pixels isolates it; the spine
// below is a quadratic fit through the centre of that mask, measured off
// hero-03 where the break is widest. It runs x=34% at the top of frame to
// x=72% at the bottom — a diagonal, which is why an earlier version with the
// shards in a vertical band down the middle never looked attached to anything.
//
// Angles are perpendicular to that spine, biased away from the standing stone:
// in every plate the debris sprays right and forward and never back into the
// wall it came off.
const SHARDS: readonly Shard[] = [
  { rock: 1, x: 36.7, y: 5.9, w: 11.5, angle: -30, reach: 79, spin: 97, depth: 0.94 },
  { rock: 2, x: 40.1, y: 11.8, w: 10.6, angle: -25, reach: 61, spin: -91, depth: 0.83 },
  { rock: 3, x: 43.2, y: 17.7, w: 9.5, angle: -8, reach: 86, spin: -210, depth: 0.71 },
  { rock: 4, x: 46.8, y: 23.6, w: 6.3, angle: -26, reach: 57, spin: 79, depth: 0.33 },
  { rock: 5, x: 46.2, y: 29.4, w: 5.4, angle: -49, reach: 79, spin: -156, depth: 0.22 },
  { rock: 6, x: 48.8, y: 35.3, w: 7.2, angle: -49, reach: 56, spin: 136, depth: 0.44 },
  { rock: 7, x: 51.9, y: 41.2, w: 12, angle: 0, reach: 98, spin: -116, depth: 1 },
  { rock: 8, x: 53.9, y: 47.1, w: 5.7, angle: -45, reach: 94, spin: -86, depth: 0.26 },
  { rock: 9, x: 56.6, y: 52.9, w: 5.3, angle: -59, reach: 90, spin: 100, depth: 0.21 },
  { rock: 10, x: 63.1, y: 58.8, w: 11.8, angle: -33, reach: 76, spin: 152, depth: 0.98 },
  { rock: 1, x: 60.1, y: 64.7, w: 7.5, angle: -19, reach: 72, spin: 210, depth: 0.47 },
  { rock: 2, x: 66, y: 70.6, w: 6.9, angle: -55, reach: 61, spin: 137, depth: 0.4 },
  { rock: 3, x: 65.9, y: 76.4, w: 6.5, angle: -18, reach: 81, spin: 131, depth: 0.35 },
  { rock: 4, x: 66.9, y: 82.3, w: 11.9, angle: -36, reach: 56, spin: -215, depth: 0.99 },
  { rock: 5, x: 66, y: 88.2, w: 12, angle: -49, reach: 86, spin: 76, depth: 1 },
  { rock: 6, x: 68.4, y: 94.1, w: 5.3, angle: -33, reach: 87, spin: -126, depth: 0.21 },
];

const body = document.body;
const pin = document.querySelector<HTMLElement>('.hero__pin');
const rig = document.querySelector<HTMLElement>('[data-rig]');
const shardHost = document.querySelector<HTMLElement>('[data-shards]');
const wide = Array.from(document.querySelectorAll<HTMLElement>('[data-wide]'));
const debris = document.querySelector<HTMLElement>('[data-debris]');
const dust = Array.from(document.querySelectorAll<HTMLElement>('[data-dust]'));
const note = document.querySelector<HTMLElement>('[data-note]');
const line = document.querySelector<HTMLElement>('[data-line]');

const still = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ── Full screen ────────────────────────────────────────────────────────── */

const fsButton = document.querySelector<HTMLButtonElement>('[data-fs]');

if (fsButton && document.fullscreenEnabled) {
  fsButton.addEventListener('click', () => {
    // requestFullscreen rejects rather than throws — a bare call leaves an
    // unhandled rejection in the console every time a browser refuses it.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  // Driven by the event, not by the click: Escape and the browser's own chrome
  // both leave full screen without this button ever being pressed.
  document.addEventListener('fullscreenchange', () => {
    const full = document.fullscreenElement !== null;
    body.classList.toggle('is-full', full);
    fsButton.setAttribute('aria-label', full ? 'Exit full screen' : 'Enter full screen');
  });
} else if (fsButton) {
  fsButton.hidden = true;
}

/* ── The rig ────────────────────────────────────────────────────────────── */

const shards: HTMLImageElement[] = [];

// Declared as a glob rather than assembled from a template string, because a
// URL built at runtime is a URL the bundler cannot see. Built the other way,
// the ten cut-outs were simply absent from `npm run build` — every shard 404'd
// in production, so the wall pinned and scrubbed and nothing ever flew off it,
// while `npm run dev` served them from disk and looked perfect.
//
// Going through the glob also gets them content hashes and immutable caching,
// which a hand-written path never would.
const ROCKS = import.meta.glob('../media/rig/rock-*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const rockUrl = (rock: number): string => {
  const key = `../media/rig/rock-${String(rock).padStart(2, '0')}.webp`;
  const url = ROCKS[key];
  // Loud, and at first paint rather than as a silent gap in the animation: a
  // missing cut-out here means the glob and the SHARDS table have drifted.
  if (url === undefined) throw new Error(`rig asset missing: ${key}`);
  return url;
};

// Nothing to build if nothing will ever fly: under reduced motion the hero is
// the wall standing whole and no chunk ever leaves the seam, so the shards are
// fourteen images that would be fetched and decoded to sit at opacity 0.
if (shardHost && !still.matches) {
  // Built from the table rather than written out in the markup, so the
  // trajectories above stay the single source of truth for both where a chunk
  // starts and where it goes.
  for (const shard of SHARDS) {
    const img = document.createElement('img');
    img.className = 'rig__shard';
    img.src = rockUrl(shard.rock);
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.decoding = 'async';
    img.style.left = `${shard.x}%`;
    img.style.top = `${shard.y}%`;
    img.style.width = `${shard.w}%`;
    shardHost.append(img);
    shards.push(img);
  }
}

// The rig is a 16:9 box sized to cover the viewport, so a percentage is the
// same fraction of the composition at every window shape. Left and width are
// read against its width, top against its height — which is exactly how CSS
// resolves those percentages, so the base positions live in the markup and
// only the deltas are computed here.
let rigW = 0;
let rigH = 0;

const measure = (): void => {
  if (!rig) return;
  rigW = rig.offsetWidth;
  rigH = rig.offsetHeight;
};

const render = (p: number): void => {
  if (!rig) return;

  // ── The wall ────────────────────────────────────────────────────────────
  // Five plates dissolving down one chain, each fading in as the one before it
  // fades out. Two of those hand-overs are invisible because the camera does
  // not move across them; the other two are covered by the push below.
  //
  // Crucially this is never a bare cross-fade: by the time the camera starts
  // moving, the shard rig is already throwing rock across the frame, so there
  // is real motion over every dissolve. Five stills with nothing happening on
  // top of them is a slideshow — that was the first version of this hero, and
  // it is exactly what it looked like.
  const push = 1 + 0.26 * easeIn(seg(p, 0.04, 0.5)) + 0.24 * easeIn(seg(p, 0.5, 0.72));

  // These plates are stacked, not laid side by side, so they must be handed
  // over the way stacked layers actually composite: the one underneath stays
  // fully opaque and the next one fades in ON TOP of it. The result is exactly
  //     (1-b)·under + b·over
  // with nothing else mixed in.
  //
  // Fading the outgoing plate out at the same time — the obvious thing, and
  // what this used to do — is wrong here. Two layers at 0.5 over a black stage
  // resolve to 0.5·over + 0.25·under + 0.25·black, so the whole frame dips 25%
  // toward black at the midpoint of every hand-over. Nine hand-overs, nine dark
  // pulses, and adding more plates only adds more of them. That, not the
  // artwork, is what read as the sequence stuttering.
  for (const [i, plate] of wide.entries()) {
    const cutIn = WALL_CUTS[i - 1];
    const fadeIn = WALL_FADES[i - 1] ?? 0.06;
    // Nothing ever fades out. The chain ends on the wallet, which is the last
    // thing anyone should be looking at, so it simply arrives and stays.
    const opacity = cutIn === undefined ? 1 : seg(p, cutIn, cutIn + fadeIn);
    plate.style.opacity = opacity.toFixed(3);

    // Once the plate above has fully arrived this one is completely hidden by
    // it. Ten full-bleed images all promoted to their own GPU layer and
    // composited every frame is most of a gigabyte of texture; taking the
    // covered ones out of painting is the difference between a smooth scrub and
    // a stuttering one.
    const cutOut = WALL_CUTS[i];
    const fadeOut = WALL_FADES[i] ?? 0.06;
    const covered = cutOut !== undefined && seg(p, cutOut, cutOut + fadeOut) >= 1;
    plate.style.visibility = opacity > 0.002 && !covered ? 'visible' : 'hidden';
  }

  // ── What comes off it ───────────────────────────────────────────────────
  // Timed against the plates, not independently of them: the shards come off
  // the break while the last plates are dissolving away, so the picture of the
  // wall and the rock leaving it are the same event. The last plate fades over
  // 0.76-0.88 and the shards are at full flight right across that.
  const blast = easeIn(seg(p, 0.4, 0.74));
  const alive = seg(p, 0.38, 0.46) * (1 - seg(p, 0.66, 0.78));

  // The rig only ever scales up from here, so it can be framed tight without
  // risking its own canvas edges coming into shot.
  const cam = 1 + 0.5 * easeIn(seg(p, 0.4, 0.78));
  rig.style.transform = `translate(-50%, -50%) scale(${cam.toFixed(4)})`;
  rig.style.opacity = alive.toFixed(3);
  rig.style.visibility = alive > 0.002 ? 'visible' : 'hidden';

  if (blast > 0) {
    const d = easeOut(clamp01((blast - 0.1) / 0.8));
    // Rises and falls inside the blast rather than lingering — dust that
    // outstays the rock it came off reads as fog.
    const puff = clamp01((1 - d) * d * 4);
    for (const cloud of dust) {
      cloud.style.opacity = (0.3 * puff).toFixed(3);
      cloud.style.transform = `translate(-50%, -50%) scale(${(1 + 1.4 * d).toFixed(3)})`;
    }
    if (debris) {
      debris.style.opacity = ((1 - d) * 0.75).toFixed(3);
      debris.style.transform = `translate(-50%, -50%) scale(${(1 + 1.7 * d).toFixed(3)})`;
    }

    for (const [i, shard] of SHARDS.entries()) {
      const img = shards[i];
      if (!img) continue;
      // Deeper chunks are nearer the lens, so they leave sooner and travel
      // further in the same span. That spread is what stops fourteen rocks
      // launching as one wave.
      const t = clamp01(blast * (0.55 + 0.75 * shard.depth));
      const rad = (shard.angle * Math.PI) / 180;
      const dx = (Math.cos(rad) * shard.reach * t * rigW) / 100;
      // Flattened vertically: the camera is looking along the wall, not at it.
      const dy = (Math.sin(rad) * shard.reach * t * 0.62 * rigH) / 100;
      img.style.opacity = clamp01(1.15 - t * 0.5).toFixed(3);
      img.style.transform =
        `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) rotate(${(shard.spin * t).toFixed(1)}deg) scale(${(1 + 2.6 * shard.depth * t).toFixed(3)})`;
    }
  } else {
    for (const cloud of dust) cloud.style.opacity = '0';
    if (debris) debris.style.opacity = '0';
    for (const img of shards) img.style.opacity = '0';
  }

  if (note) note.style.opacity = (1 - seg(p, 0.16, 0.26)).toFixed(3);
  if (line) {
    const arriving = seg(p, 0.95, 1);
    line.style.opacity = arriving.toFixed(3);
    line.style.transform = `translateX(-50%) translateY(${(26 * (1 - easeOut(arriving))).toFixed(1)}px)`;
  }
};

if (pin && rig && !still.matches) {
  body.classList.add('in-hero');
  measure();

  // One tween of one number. Everything else is `render` reading it — which
  // keeps the whole composition a pure function of scroll position, and means
  // there is exactly one place to change the pacing.
  const play = { p: 0 };
  gsap.to(play, {
    p: 1,
    ease: 'none',
    onUpdate: () => render(play.p),
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      end: SCROLL_LENGTH,
      pin,
      // Enough catch-up to smooth a notchy wheel, not enough to feel like the
      // picture is trailing the hand. At 0.8 the lag itself reads as jank.
      scrub: 0.3,
      anticipatePin: 1,
      invalidateOnRefresh: true,
      onRefresh: measure,
      onUpdate: (self) => pin.style.setProperty('--p', self.progress.toFixed(4)),
      // No header over the sequence; it returns the moment the hero releases,
      // in both directions.
      onLeave: () => body.classList.remove('in-hero'),
      onEnterBack: () => body.classList.add('in-hero'),
    },
  });

  window.addEventListener('resize', measure);
  render(0);
}

/* ── The argument, on arrival ───────────────────────────────────────────── */

// Everything below the hero. Built with gsap.from rather than a resting state
// in the stylesheet, so the page is fully legible with JavaScript off — nothing
// is hidden waiting for a script that might never run.
if (!still.matches) {
  // Blocks rise into place as they come up. Once only: re-animating on the way
  // back up makes a long page feel unstable under the hand.
  for (const el of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
    gsap.from(el, {
      opacity: 0,
      y: 26,
      duration: 0.7,
      ease: 'power2.out',
      scrollTrigger: { trigger: el, start: 'top 88%', once: true },
    });
  }

  // The rule across each pillar draws itself left to right.
  for (const el of document.querySelectorAll<HTMLElement>('.pillar')) {
    gsap.fromTo(
      el,
      { '--draw': 0 },
      {
        '--draw': 1,
        duration: 0.9,
        ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      },
    );
  }

  // Six struck through in sequence, then the two that hold are left standing.
  // The stagger is the point: read one at a time, the list becomes an argument
  // rather than a table.
  const broken = document.querySelectorAll<HTMLElement>('.ledger span:not(.holds)');
  const ledger = document.querySelector<HTMLElement>('.ledger');
  if (ledger && broken.length > 0) {
    gsap.fromTo(
      broken,
      { '--strike': 0 },
      {
        '--strike': 1,
        duration: 0.45,
        ease: 'power1.inOut',
        stagger: 0.09,
        scrollTrigger: { trigger: ledger, start: 'top 72%', once: true },
      },
    );
  }

  // Photographs drift against the scroll. Small: enough to separate them from
  // the type, not enough to read as a gimmick.
  for (const fig of document.querySelectorAll<HTMLElement>('.band')) {
    const img = fig.querySelector('img');
    if (!img) continue;
    gsap.fromTo(
      img,
      { yPercent: -6 },
      {
        yPercent: 6,
        ease: 'none',
        scrollTrigger: { trigger: fig, start: 'top bottom', end: 'bottom top', scrub: true },
      },
    );
  }
}

/* ── Tilt ───────────────────────────────────────────────────────────────── */

// Leans toward the cursor, lifts, and lights the surface under it. Two things
// on the page use it: the chip render and the refrigerator photograph.
//
// Angles are measured from each element's own centre, not from the viewport or
// the column it sits in, so the corner nearest the pointer is always the one
// that rises. Kept to ±14° horizontal and ±9° vertical on purpose — these are
// flat images with no modelled sides, and past roughly fifteen degrees the eye
// starts asking to see the edge of the object and there is none to show.
//
// Every frame is a lerp toward a target rather than a direct assignment, which
// is what stops it snapping around under a fast mouse. It also means letting go
// needs no transition: the target simply becomes the resting pose again.

// A coarse pointer has no hover, and nothing to lean toward.
const canHover = window.matchMedia('(hover: hover)').matches;

if (canHover && !still.matches) {
  const REST_X = 6; // degrees — the pose it sits in untouched
  const SWING_Y = 14;
  const SWING_X = 9;

  for (const host of document.querySelectorAll<HTMLElement>('[data-tilt]')) {
    const face = host.querySelector<HTMLElement>('.tilt__body');
    const glow = host.querySelector<HTMLElement>('.tilt__glow');
    if (!face || !glow) continue;

    const now = { rx: REST_X, ry: 0, lift: 0, lit: 0.25 };
    const want = { rx: REST_X, ry: 0, lift: 0, lit: 0.25 };
    let running = false;

    const frame = (): void => {
      // 0.1 rather than something snappier: the weight of the ease is most of
      // what makes it read as an object being handled.
      const ease = 0.1;
      now.rx += (want.rx - now.rx) * ease;
      now.ry += (want.ry - now.ry) * ease;
      now.lift += (want.lift - now.lift) * ease;
      now.lit += (want.lit - now.lit) * ease;

      face.style.transform =
        `perspective(1100px) rotateX(${now.rx.toFixed(2)}deg) rotateY(${now.ry.toFixed(2)}deg) translateY(${now.lift.toFixed(2)}px) scale(${(1 + now.lift * -0.0016).toFixed(4)})`;
      glow.style.setProperty('--lit', now.lit.toFixed(3));

      // Stop once it has settled rather than burning a frame forever on an
      // element nobody is touching.
      running =
        Math.abs(want.rx - now.rx) > 0.01 ||
        Math.abs(want.ry - now.ry) > 0.01 ||
        Math.abs(want.lift - now.lift) > 0.01 ||
        Math.abs(want.lit - now.lit) > 0.002;
      if (running) requestAnimationFrame(frame);
    };

    const wake = (): void => {
      if (running) return;
      running = true;
      requestAnimationFrame(frame);
    };

    host.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') return;
      const box = host.getBoundingClientRect();
      // -0.5 … 0.5 from the centre of this element, and clamped there. A
      // pointermove can carry coordinates outside the box it fired on — moving
      // fast across an edge, or while something else holds pointer capture —
      // and without this the swing multiplies straight past its limit. Seen at
      // 39° on an element meant to top out at 15.
      const half = (n: number): number => (n < -0.5 ? -0.5 : n > 0.5 ? 0.5 : n);
      const x = half((event.clientX - box.left) / box.width - 0.5);
      const y = half((event.clientY - box.top) / box.height - 0.5);
      want.ry = x * SWING_Y * 2;
      want.rx = REST_X - y * SWING_X * 2;
      want.lift = -10;
      want.lit = 0.62;
      wake();
    });

    host.addEventListener('pointerleave', () => {
      want.rx = REST_X;
      want.ry = 0;
      want.lift = 0;
      want.lit = 0.25;
      wake();
    });
  }
}

/* ── Boot gate ──────────────────────────────────────────────────────────── */

// Twenty-odd cut-outs composited over each other is unforgiving of a
// half-loaded rig: scroll in early and chunks fly out of a wall that has not
// arrived yet. So hold a black screen until they are all decoded. The element ships
// `hidden` and is only revealed here, so a visitor without JavaScript never
// meets a gate that nothing would ever lift.
const boot = document.querySelector<HTMLElement>('[data-boot]');
const bootBar = document.querySelector<HTMLElement>('[data-boot-bar]');
const everything = Array.from(document.querySelectorAll<HTMLImageElement>('.hero img'));

if (boot && bootBar && everything.length > 0) {
  boot.hidden = false;

  let decoded = 0;
  const step = (): void => {
    decoded += 1;
    bootBar.style.width = `${Math.round((decoded / everything.length) * 100)}%`;
    if (decoded < everything.length) return;
    boot.classList.add('is-done');
    // Belt and braces. This overlay is opaque black over the whole page, so a
    // transitionend that never fires — a background tab, a browser that skipped
    // the transition, anything — would strand the visitor behind it. Whichever
    // of the two lands first wins; remove() is idempotent.
    const lift = (): void => boot.remove();
    boot.addEventListener('transitionend', lift, { once: true });
    window.setTimeout(lift, 900);
    // The pin is measured around this content; re-measure so the beats stay on
    // the percentages above instead of drifting off them.
    ScrollTrigger.refresh();
  };

  for (const img of everything) {
    // decode() rejects on a broken or missing file. A missing asset should cost
    // that one layer, not strand every visitor behind a gate that never lifts,
    // so failure counts the same as success.
    img.decode().then(step).catch(() => step());
  }
}
