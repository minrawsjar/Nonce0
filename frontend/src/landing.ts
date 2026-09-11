// One scroll clock drives the artwork, copy, and progress indicator together.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

const body = document.body;
const pin = document.querySelector<HTMLElement>('.hero__pin');
const plates = Array.from(document.querySelectorAll<HTMLImageElement>('[data-wide]'));
const note = document.querySelector<HTMLElement>('[data-note]');
const mark = document.querySelector<HTMLElement>('[data-reveal-mark]');
const nav = document.querySelector<HTMLElement>('.nav');
const fsButton = document.querySelector<HTMLButtonElement>('[data-fs]');
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const segment = (p: number, start: number, end: number): number => clamp((p - start) / (end - start));

// Allocate more scroll to larger composition changes. Transitions meet without
// pauses; the incoming image fades over an opaque base to avoid dark pulses.
const distances = [4.6, 8.4, 5.5, 8.3, 8.1, 13.5, 27.7];
const total = distances.reduce((sum, distance) => sum + distance, 0);
const stops = [0];
for (const distance of distances) stops.push(stops[stops.length - 1]! + distance / total);
stops[stops.length - 1] = 1;

if (fsButton && document.fullscreenEnabled) {
  fsButton.addEventListener('click', () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    void action.catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    const full = document.fullscreenElement !== null;
    body.classList.toggle('is-full', full);
    fsButton.setAttribute('aria-label', full ? 'Exit full screen' : 'Enter full screen');
  });
} else if (fsButton) {
  fsButton.hidden = true;
}

const updateNav = (): void => { nav?.classList.toggle('is-scrolled', window.scrollY > 24); };
window.addEventListener('scroll', updateNav, { passive: true });
updateNav();

// Pinning must not wait for every image to decode. On a cold production load,
// that delay left the navigation over the artwork and could skip the timeline
// entirely when fewer than two frames decoded before the timeout.
function initHero(): void {
  if (!pin || plates.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    body.classList.remove('in-hero');
    return;
  }
  body.classList.add('in-hero');
  const frames = plates.map((plate, index) => ({ plate, stop: stops[index] ?? 1 }));
  frames[0]!.stop = 0;
  frames[frames.length - 1]!.stop = 1;

  const media = gsap.matchMedia();
  media.add({ motion: '(prefers-reduced-motion: no-preference)', narrow: '(max-width: 600px)' }, (context) => {
    if (!context.conditions?.motion) return;
    const render = (progress: number): void => {
      const scene = segment(progress, 0.035, 0.62);
      let current = frames.length - 2;
      for (let i = 0; i < frames.length - 1; i += 1) {
        if (scene < frames[i + 1]!.stop) { current = i; break; }
      }
      const from = frames[current]!;
      const to = frames[current + 1]!;
      const mix = segment(scene, from.stop, to.stop);
      let paintedFrom = from;
      for (let i = current; i >= 0; i -= 1) {
        if (frames[i]!.plate.naturalWidth > 0) { paintedFrom = frames[i]!; break; }
      }
      const paintedTo = to.plate.naturalWidth > 0 ? to : undefined;
      for (const plate of plates) {
        const visible = plate === paintedFrom.plate || (plate === paintedTo?.plate && mix > 0);
        plate.style.visibility = visible ? 'visible' : 'hidden';
        plate.style.opacity = plate === paintedTo?.plate ? String(mix) : plate === paintedFrom.plate ? '1' : '0';
        plate.style.willChange = visible ? 'opacity' : 'auto';
      }
      pin.style.setProperty('--p', String(progress));
      if (note) note.style.opacity = String(1 - segment(progress, 0.04, 0.15));
      if (mark) {
        // Four overlapping steps, in the order they were asked for: the black
        // closes over the artwork, the letters arrive on it, the p and q take
        // the accent, the words they stand for follow, then the tagline.
        // Each starts before the one before it has finished, so the whole
        // thing reads as one movement rather than four cues.
        mark.style.setProperty('--veil', String(segment(progress, 0.60, 0.74)));
        mark.style.setProperty('--mark-in', String(segment(progress, 0.68, 0.80)));
        mark.style.setProperty('--accent', String(segment(progress, 0.80, 0.88)));
        mark.style.setProperty('--sub-in', String(segment(progress, 0.85, 0.93)));
        mark.style.setProperty('--tag-in', String(segment(progress, 0.91, 0.99)));
      }
    };
    const play = { progress: 0 };
    for (const plate of plates) {
      if (!plate.complete) plate.addEventListener('load', () => render(play.progress), { once: true });
    }
    const syncHeader = (active: boolean): void => { body.classList.toggle('in-hero', active); };
    const tween = gsap.to(play, {
      progress: 1,
      ease: 'none',
      onUpdate: () => render(play.progress),
      scrollTrigger: {
        trigger: '.hero', start: 'top top',
        end: () => `+=${pin.clientHeight * (context.conditions?.narrow ? 3.2 : 4.5)}`,
        pin, scrub: 0.45, anticipatePin: 1, invalidateOnRefresh: true,
        onToggle: (self) => syncHeader(self.progress < 1),
        onRefresh: (self) => syncHeader(self.progress < 1 && window.scrollY <= self.end),
      },
    });
    render(tween.scrollTrigger?.progress ?? 0);
    // Restored scroll positions and direct anchors may start past the hero.
    syncHeader((tween.scrollTrigger?.progress ?? 0) < 1);
    return () => {
      body.classList.remove('in-hero');
      for (const element of [...plates, pin, note, mark]) element?.removeAttribute('style');
    };
  });
}
initHero();

// Content motion starts only as each section approaches the viewport. It runs
// once so the long-form page stays settled when a reader scrolls back.
const contentMotion = gsap.matchMedia();
contentMotion.add('(prefers-reduced-motion: no-preference)', () => {
  for (const element of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
    gsap.from(element, {
      opacity: 0,
      y: 20,
      duration: 0.65,
      ease: 'power2.out',
      scrollTrigger: { trigger: element, start: 'top 90%', once: true },
    });
  }

  for (const pillar of document.querySelectorAll<HTMLElement>('.pillar')) {
    gsap.fromTo(pillar, { '--draw': 0 }, {
      '--draw': 1,
      duration: 0.8,
      ease: 'power2.out',
      scrollTrigger: { trigger: pillar, start: 'top 88%', once: true },
    });
  }

  const ledger = document.querySelector<HTMLElement>('.ledger');
  const broken = document.querySelectorAll<HTMLElement>('.ledger span:not(.holds)');
  if (ledger && broken.length > 0) {
    gsap.fromTo(broken, { '--strike': 0 }, {
      '--strike': 1,
      duration: 0.4,
      ease: 'power1.inOut',
      stagger: 0.08,
      scrollTrigger: { trigger: ledger, start: 'top 76%', once: true },
    });
  }

  for (const band of document.querySelectorAll<HTMLElement>('.band')) {
    const image = band.querySelector<HTMLImageElement>('img');
    if (!image) continue;
    gsap.fromTo(image, { yPercent: -4 }, {
      yPercent: 4,
      ease: 'none',
      scrollTrigger: { trigger: band, start: 'top bottom', end: 'bottom top', scrub: 0.5 },
    });
  }
});

// Cut-out hardware images get a restrained pointer tilt on fine pointers.
// A small range keeps the flat artwork convincing and avoids competing with
// the page's scroll motion.
if (window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches) {
  for (const host of document.querySelectorAll<HTMLElement>('[data-tilt]')) {
    const face = host.querySelector<HTMLElement>('.tilt__body');
    const glow = host.querySelector<HTMLElement>('.tilt__glow');
    if (!face || !glow) continue;

    const rotateX = gsap.quickTo(face, 'rotationX', { duration: 0.45, ease: 'power2.out' });
    const rotateY = gsap.quickTo(face, 'rotationY', { duration: 0.45, ease: 'power2.out' });
    const lift = gsap.quickTo(face, 'y', { duration: 0.45, ease: 'power2.out' });

    host.addEventListener('pointermove', (event) => {
      const box = host.getBoundingClientRect();
      const x = clamp((event.clientX - box.left) / box.width) - 0.5;
      const y = clamp((event.clientY - box.top) / box.height) - 0.5;
      rotateX(6 - y * 12);
      rotateY(x * 16);
      lift(-6);
      glow.style.setProperty('--lit', '0.55');
    });

    host.addEventListener('pointerleave', () => {
      rotateX(6);
      rotateY(0);
      lift(0);
      glow.style.setProperty('--lit', '0.25');
    });
  }
}
