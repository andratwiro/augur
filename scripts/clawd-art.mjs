// clawd-art — the Clawd mascot as tintable pixel-SVG, with expression STATES.
// One shared 14x12 pixel grid; each expression overrides eyes/mouth/arms/accessories.
// Body pixels ('B') take the peer's color ({C}); features are fixed hues. A white outline
// (feMorphology) keeps Clawd legible on any canvas background. clawdSvg(expr, color) -> string.
//
// States (so the cursor can "act"): idle · coding · thinking · happy · sleeping · love ·
// sunglasses · handsUp. Add more from the official sheet by adding a pixel map below.

const U = 4;                     // px per grid cell
const COLS = 14, ROWS = 12;
const K = '#1a1a1a', WHITE = '#fff', RED = '#e03131', BLUE = '#4dabf7', YELLOW = '#ffd43b', GREY = '#adb5bd';

// base body silhouette (B). Head block + small side-arm nubs (rows 6-7 cols 0 & 13) + 4 feet.
const BODY = [
  '..BBBBBBBBBB..',
  '.BBBBBBBBBBBB.',
  '.BBBBBBBBBBBB.',
  '.BBBBBBBBBBBB.',
  '.BBBBBBBBBBBB.',
  '.BBBBBBBBBBBB.',
  'BBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBB',
  '.BBBBBBBBBBBB.',
  '.BBBBBBBBBBBB.',
  '.BB.BB..BB.BB.',
  '.BB.BB..BB.BB.',
];

// feature layers per expression: [row, col, color] cells painted ON TOP of the body
function eyes(open = true, color = K) {
  // two 2x2 eyes at rows 3-4, cols 4-5 and 8-9
  const c = [];
  const rows = open ? [3, 4] : [4];
  for (const r of rows) for (const col of [4, 5, 8, 9]) c.push([r, col, color]);
  return c;
}
const EXPR = {
  idle: () => eyes(true),
  // squint (single-row eyes) = focused on the work
  coding: () => [...eyes(false), [3, 4, K], [3, 9, K]],
  // normal eyes + a trailing "..." up to the right
  thinking: () => [...eyes(true), [1, 12, K], [0, 13, K], [2, 11, K]],
  // upward (top-row) eyes = happy squint + tiny rosy cheeks
  happy: () => [[3, 4, K], [3, 5, K], [3, 8, K], [3, 9, K], [5, 3, '#ff8787'], [5, 10, '#ff8787']],
  // closed dash eyes + "z z" drifting up-right
  sleeping: () => [...eyes(false), [1, 12, GREY], [0, 13, GREY]],
  // red hearts for eyes + a floating heart
  love: () => [[3, 4, RED], [3, 5, RED], [4, 4, RED], [3, 8, RED], [3, 9, RED], [4, 8, RED], [0, 11, RED], [0, 12, RED]],
  // solid black bar across the eyes
  sunglasses: () => { const c = []; for (const col of [3, 4, 5, 6, 7, 8, 9, 10]) c.push([3, col, K]); for (const col of [4, 5, 8, 9]) c.push([4, col, K]); return c; },
  // idle face but arms raised (extra body pixels up at the top corners)
  handsUp: () => [...eyes(true), [0, 0, 'B'], [1, 0, 'B'], [0, 1, 'B'], [0, 13, 'B'], [1, 13, 'B'], [0, 12, 'B']],
};

export const CLAWD_STATES = Object.keys(EXPR);

export function clawdSvg(expr = 'idle', color = '#d97757') {
  const cells = new Map(); // "r,c" -> color
  BODY.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === 'B') cells.set(r + ',' + c, 'B'); }));
  (EXPR[expr] || EXPR.idle)().forEach(([r, c, col]) => cells.set(r + ',' + c, col));
  let rects = '';
  for (const [k, col] of cells) {
    const [r, c] = k.split(',').map(Number);
    const fill = col === 'B' ? '{C}' : col;
    rects += `<rect x="${c * U}" y="${r * U}" width="${U}" height="${U}" fill="${fill}"/>`;
  }
  const W = COLS * U, H = ROWS * U;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><filter id="clawd-o" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feMorphology in="SourceAlpha" operator="dilate" radius="1.3" result="d"/>` +
    `<feFlood flood-color="${WHITE}"/><feComposite in2="d" operator="in" result="o"/>` +
    `<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
    `<g filter="url(#clawd-o)">${rects}</g></svg>`;
  return svg.replace(/\{C\}/g, color);
}
