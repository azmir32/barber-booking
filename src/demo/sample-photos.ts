// The demo's photos of Ali's cuts. With no photos of real people to ship
// offline, each is a drawn card instead: a head with the cut's shape, in the
// app's colours, its name, and a label saying it is a sample. Drawn as SVG
// from its name, so nothing is stored for them and a reset brings them back.

/** One sample cut: its file name, what the card says, and how it is drawn. */
export type SampleCut = {
  slug: string;
  name: string;
  caption: string;
  /** Who did it, by the sample barber's name. */
  barber: 'Ali' | 'Danial';
  square?: boolean;
  look: Look;
  skin: string;
  hair: Hair;
  kid?: boolean;
};

type Hair = 'skin-fade' | 'taper' | 'crop' | 'beard' | 'side-part' | 'buzz' | 'quiff';
type Look = 'light' | 'sand' | 'brand';

export const SAMPLE_CUTS: SampleCut[] = [
  { slug: 'skin-fade', name: 'Skin fade', caption: 'Skin fade with a hard part', barber: 'Ali', look: 'light', skin: '#C68E63', hair: 'skin-fade' },
  { slug: 'kids-cut', name: 'Kids cut', caption: 'First proper haircut, neat side part', barber: 'Danial', square: true, look: 'sand', skin: '#E0B38C', hair: 'side-part', kid: true },
  { slug: 'beard', name: 'Beard line-up', caption: 'Beard trim and a sharp line-up', barber: 'Ali', look: 'brand', skin: '#9A6440', hair: 'beard' },
  { slug: 'low-taper', name: 'Low taper', caption: 'Low taper, longer on top', barber: 'Danial', look: 'light', skin: '#B97C55', hair: 'taper' },
  { slug: 'textured-crop', name: 'Textured crop', caption: 'Textured crop with a mid fade', barber: 'Ali', square: true, look: 'sand', skin: '#C68E63', hair: 'crop' },
  { slug: 'buzz-cut', name: 'Buzz cut', caption: 'Buzz cut, number two all over', barber: 'Danial', look: 'sand', skin: '#9A6440', hair: 'buzz' },
  { slug: 'quiff', name: 'Quiff', caption: 'Quiff for a wedding', barber: 'Ali', look: 'light', skin: '#E0B38C', hair: 'quiff' },
];

/** The size a sample card is listed at, as an upload's would be (at most 1600 px). */
export const sampleSize = (cut: SampleCut) => (cut.square ? { width: 1200, height: 1200 } : { width: 1200, height: 1500 });

const THUMB = '-thumb';

/** The files of a sample photo in a shop's folder. */
export const samplePaths = (shopId: string, cut: SampleCut) => ({
  path: `${shopId}/sample-${cut.slug}.svg`,
  thumb_path: `${shopId}/sample-${cut.slug}${THUMB}.svg`,
});

/** The drawing for a sample photo's file, by its name in any shop's folder; null for any other file. */
export function sampleFile(name: string): string | null {
  const m = /^[^/]+\/sample-([a-z-]+?)(-thumb)?\.svg$/.exec(name);
  const cut = m && SAMPLE_CUTS.find((c) => c.slug === m[1]);
  if (!cut) return null;
  const size = sampleSize(cut);
  // The thumbnail is the same drawing asked for at about 400 px, as an upload's would be.
  const scale = m![2] ? 400 / size.width : 1;
  return cutCard(cut, Math.round(size.width * scale), Math.round(size.height * scale));
}

const LOOKS: Record<Look, { bg: string; halo: string; haloOpacity: number; ink: string; muted: string; shirt: string; pill: string; pillText: string }> = {
  light: { bg: '#F7F6F3', halo: '#C8283C', haloOpacity: 0.1, ink: '#15171C', muted: '#5F6470', shirt: '#2A2E36', pill: '#C8283C', pillText: '#FFFFFF' },
  sand: { bg: '#EFE4D6', halo: '#FFFFFF', haloOpacity: 0.55, ink: '#15171C', muted: '#5F6470', shirt: '#C8283C', pill: '#15171C', pillText: '#FFFFFF' },
  brand: { bg: '#C8283C', halo: '#FFFFFF', haloOpacity: 0.14, ink: '#FFFFFF', muted: '#FDECEA', shirt: '#15171C', pill: '#FFFFFF', pillText: '#C8283C' },
};
const HAIR = '#1E1A17';

/** A darker shade of a skin tone, for the neck and the shadow under the jaw. */
function shade(hex: string, amount = 0.82) {
  const n = parseInt(hex.slice(1), 16);
  const c = [16, 8, 0].map((s) => Math.round(((n >> s) & 255) * amount));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// A head from the front in a 1200 × 1200 box: the crown at y 345, the
// temples at x 395 and 805, the jaw at y 870. Each cut is drawn over it.
const HAIRCUTS: Record<Hair, string> = {
  'skin-fade': `
    <path d="M395 600 C395 470 450 380 520 360 L680 360 C750 380 805 470 805 600 L782 600 C776 520 742 470 700 456 L500 456 C458 470 424 520 418 600 Z" fill="url(#fade)"/>
    <path d="M418 500 C408 380 482 300 600 294 C718 300 792 380 782 500 C756 452 700 430 600 432 C500 430 444 452 418 500 Z" fill="${HAIR}"/>
    <path d="M462 446 C498 404 540 386 588 380" stroke="#F7F6F3" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.8"/>`,
  taper: `
    <path d="M396 640 C396 560 404 520 420 500 L438 520 C428 560 424 600 424 640 Z M804 640 C804 560 796 520 780 500 L762 520 C772 560 776 600 776 640 Z" fill="url(#fade)"/>
    <path d="M404 540 C384 368 478 266 612 266 C744 270 822 360 798 520 C774 470 724 446 652 450 C598 440 522 468 480 500 C452 476 426 492 404 540 Z" fill="${HAIR}"/>
    <path d="M520 330 C600 300 690 310 750 360" stroke="#3A332E" stroke-width="10" stroke-linecap="round" fill="none"/>`,
  crop: `
    <path d="M395 610 C395 500 430 430 470 400 L730 400 C770 430 805 500 805 610 L784 610 C780 540 760 500 730 480 L470 480 C440 500 420 540 416 610 Z" fill="url(#fade)"/>
    <path d="M410 520 C400 380 480 300 600 296 C720 300 800 380 790 520 L770 480 L745 470 L720 488 L690 466 L660 486 L630 464 L600 484 L570 462 L540 486 L510 464 L480 488 L455 470 L430 492 Z" fill="${HAIR}"/>`,
  beard: `
    <path d="M398 560 C395 430 470 336 600 334 C730 336 805 430 802 560 C790 470 722 402 600 400 C478 402 410 470 398 560 Z" fill="${HAIR}" opacity="0.85"/>
    <path d="M398 630 C404 762 470 884 600 908 C730 884 796 762 802 630 C784 690 762 734 732 756 C692 786 650 768 600 770 C550 768 508 786 468 756 C438 734 416 690 398 630 Z" fill="${HAIR}"/>
    <path d="M516 744 C556 718 644 718 684 744 C644 756 556 756 516 744 Z" fill="${HAIR}"/>`,
  'side-part': `
    <path d="M400 570 C378 380 470 286 600 284 C730 286 822 380 800 570 C792 500 770 468 738 452 C676 428 560 440 468 470 C438 492 410 526 400 570 Z" fill="${HAIR}"/>
    <path d="M488 300 C478 360 474 410 478 462" stroke="#F7F6F3" stroke-width="6" stroke-linecap="round" fill="none" opacity="0.7"/>`,
  buzz: `
    <path d="M398 560 C395 430 470 330 600 328 C730 330 805 430 802 560 C790 470 720 400 600 398 C480 400 410 470 398 560 Z" fill="${HAIR}" opacity="0.72"/>`,
  quiff: `
    <path d="M395 600 C395 480 440 400 500 372 L700 372 C760 400 805 480 805 600 L784 600 C778 528 746 484 708 468 L492 468 C454 484 422 528 416 600 Z" fill="url(#fade)"/>
    <path d="M412 520 C394 380 452 246 604 226 C724 210 834 288 812 402 C804 450 794 480 788 520 C768 470 718 444 648 440 C558 440 478 466 412 520 Z" fill="${HAIR}"/>
    <path d="M500 300 C580 250 690 250 760 320" stroke="#3A332E" stroke-width="12" stroke-linecap="round" fill="none"/>`,
};

function head(cut: SampleCut, shirt: string) {
  const skin = cut.skin;
  return `
    <path d="M180 1200 C200 1010 360 950 520 930 L680 930 C840 950 1000 1010 1020 1200 Z" fill="${shirt}"/>
    <path d="M515 790 L515 950 C560 985 640 985 685 950 L685 790 Z" fill="${shade(skin)}"/>
    <ellipse cx="398" cy="610" rx="40" ry="72" fill="${skin}"/>
    <ellipse cx="802" cy="610" rx="40" ry="72" fill="${skin}"/>
    <path d="M600 345 C735 345 805 450 805 600 C805 760 715 870 600 870 C485 870 395 760 395 600 C395 450 465 345 600 345 Z" fill="${skin}"/>
    ${HAIRCUTS[cut.hair]}`;
}

const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/** The card itself: the head with the cut above its name, at any size of the card's shape. */
export function cutCard(cut: SampleCut, width: number, height: number): string {
  const look = LOOKS[cut.look];
  const { width: w, height: h } = sampleSize(cut);
  // The drawing sits in the square middle of a tall card, so a square thumbnail still shows the name.
  const art = cut.square ? { scale: 0.72, x: 168, y: 70 } : { scale: 0.9, x: 60, y: 110 };
  const figure = cut.kid ? 'translate(84 168) scale(0.86)' : '';
  const nameY = cut.square ? 1060 : 1290;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="fade" x1="0" y1="${cut.hair === 'taper' ? 500 : 380}" x2="0" y2="${cut.hair === 'taper' ? 650 : 620}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${HAIR}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${HAIR}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="${look.bg}"/>
  <g transform="translate(${art.x} ${art.y}) scale(${art.scale})">
    <circle cx="600" cy="600" r="470" fill="${look.halo}" opacity="${look.haloOpacity}"/>
    <g transform="${figure}">${head(cut, look.shirt)}</g>
  </g>
  <rect x="${cut.square ? 48 : 60}" y="${cut.square ? 40 : 170}" width="250" height="60" rx="30" fill="${look.pill}"/>
  <text x="${(cut.square ? 48 : 60) + 125}" y="${cut.square ? 81 : 211}" font-family="${FONT}" font-size="30" font-weight="700" letter-spacing="5" text-anchor="middle" fill="${look.pillText}">SAMPLE</text>
  <text x="600" y="${nameY}" font-family="${FONT}" font-size="80" font-weight="700" text-anchor="middle" fill="${look.ink}">${cut.name}</text>
  <text x="600" y="${nameY + 64}" font-family="${FONT}" font-size="34" text-anchor="middle" fill="${look.muted}">Sample illustration · Ilustrasi contoh</text>
</svg>`;
}

/**
 * Shown for a photo whose file the demo no longer has: photos added in the
 * demo are kept only while its page is open.
 */
export function missingFile(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <rect width="400" height="400" fill="#E4E1DA"/>
  <text x="200" y="190" font-family="${FONT}" font-size="26" font-weight="700" text-anchor="middle" fill="#15171C">Photo not kept</text>
  <text x="200" y="230" font-family="${FONT}" font-size="18" text-anchor="middle" fill="#5F6470">The demo keeps added photos</text>
  <text x="200" y="256" font-family="${FONT}" font-size="18" text-anchor="middle" fill="#5F6470">only while the page is open</text>
</svg>`;
}
