#!/usr/bin/env node
// Convierte las 3 imágenes del banner en nubes de puntos (mismo N por imagen) para el
// efecto "VISUAL.MAP". Sin dependencias: ffmpeg entrega los píxeles RGBA crudos.
//
//   node scripts/sample-points.mjs  → escribe assets/points.js (window.POINTS)
//
// Cada imagen define un "peso" por píxel (probabilidad de dejar un punto ahí):
//   photo   → recorte sin fondo (alpha), más puntos en zonas claras (piel, polera)
//   penguin → ya es un dibujo de puntos rosados: se toma tal cual
//   claude  → bloque naranjo + cuadros blancos de los lentes; los lentes negros quedan vacíos
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const src = (f) => join(ROOT, "assets/src", f);
const BOX_W = 300, BOX_H = 340; // área de dibujo del panel VISUAL.MAP
const N = 5200;                 // puntos por imagen (iguales para poder transformar 1:1)

let seed = 20261002;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function pixels(file, w, h, crop) {
  const pre = crop ? `crop=${crop.join(":")},` : "";
  const buf = execFileSync("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `${pre}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
    "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  return (x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]; };
}

function sample(file, weight, { w = BOX_W, h = BOX_H, crop } = {}) {
  const px = pixels(file, w, h, crop);
  // Mapa de pesos → densidad objetivo de ~N puntos, y difusión de error Floyd–Steinberg:
  // a diferencia de un sorteo independiente por píxel, conserva bordes y rasgos (ojos, pelo).
  const wm = new Float32Array(w * h);
  let total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.max(0, weight(...px(x, y), x, y, px));
    wm[y * w + x] = v; total += v;
  }
  // Tope de densidad (~70 %): si la figura es chica, saturar todo al 100 % borra los rasgos.
  let maxW = 0;
  for (let i = 0; i < wm.length; i++) maxW = Math.max(maxW, wm[i]);
  const k = total > 0 ? Math.min(N / total, 0.7 / maxW) : 0;
  for (let i = 0; i < wm.length; i++) wm[i] = Math.min(1, wm[i] * k);
  const cand = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, old = wm[i], q = old >= 0.5 ? 1 : 0, err = old - q;
    if (q) cand.push([x + (rnd() - 0.5) * 0.6, y + (rnd() - 0.5) * 0.6]);
    if (x + 1 < w) wm[i + 1] += err * 7 / 16;
    if (y + 1 < h) {
      if (x > 0) wm[i + w - 1] += err * 3 / 16;
      wm[i + w] += err * 5 / 16;
      if (x + 1 < w) wm[i + w + 1] += err * 1 / 16;
    }
  }
  // Ajustar a exactamente N: submuestreo uniforme o repetición con jitter.
  const out = [];
  if (cand.length >= N) {
    const step = cand.length / N;
    for (let i = 0; i < N; i++) out.push(cand[Math.floor(i * step)]);
  } else {
    for (let i = 0; i < N; i++) {
      const c = cand[i % cand.length];
      out.push(i < cand.length ? c : [c[0] + rnd() * 1.6 - 0.8, c[1] + rnd() * 1.6 - 0.8]);
    }
  }
  // Centrar la figura en el panel (cada imagen trae márgenes distintos).
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const [x, y] of out) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  const dx = (BOX_W - (bx1 - bx0)) / 2 - bx0, dy = (BOX_H - (by1 - by0)) / 2 - by0;
  for (const p of out) { p[0] += dx; p[1] += dy; }
  // Orden de arriba hacia abajo: la transformación A→B conserva la "altura" de cada punto.
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  console.error(`${file.split("/").pop()}: ${cand.length} candidatos → ${N}`);
  return out.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}


// Foto: recorte a cabeza y hombros (como el retrato de la referencia) y tonos
// ecualizados dentro de la silueta, para que se lean ojos, pelo y sonrisa.
const PHOTO_CROP = [196, 214, 88, 62]; // w:h:x:y en píxeles de la imagen original (373×334)
const photoPx = pixels(src("photo-cut.png"), BOX_W, BOX_H, PHOTO_CROP);
const inPhoto = (r, g, b, a) => a >= 140 && !(b > r + 35 && b > 110); // sin fondo ni aro azul
// Luminancia con realce local (unsharp mask, radio ~3 px): marca ojos, cejas, sonrisa y pelo.
const Lmap = new Float32Array(BOX_W * BOX_H);
for (let y = 0; y < BOX_H; y++) for (let x = 0; x < BOX_W; x++) {
  const [r, g, b, a] = photoPx(x, y);
  Lmap[y * BOX_W + x] = inPhoto(r, g, b, a) ? lum(r, g, b) : -1;
}
const R = 3, sharp = new Float32Array(BOX_W * BOX_H).fill(-1);
for (let y = 0; y < BOX_H; y++) for (let x = 0; x < BOX_W; x++) {
  const c = Lmap[y * BOX_W + x];
  if (c < 0) continue;
  let sum = 0, n = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= BOX_W || yy >= BOX_H) continue;
    const v = Lmap[yy * BOX_W + xx];
    if (v >= 0) { sum += v; n++; }
  }
  sharp[y * BOX_W + x] = Math.min(1, Math.max(0, c + 1.6 * (c - sum / n)));
}
const hist = new Array(256).fill(0);
let inMask = 0;
for (const v of sharp) if (v >= 0) { hist[Math.round(v * 255)]++; inMask++; }
const cdf = []; let acc = 0;
for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = acc / Math.max(1, inMask); }
// Pelo: es oscuro, así que por tono casi no recibe puntos y la cabeza se ve "pelada".
// Zona de pelo = píxeles oscuros sobre la frente, o a los costados de la cara (sienes).
let headTop = BOX_H, sumX = 0, cntX = 0;
for (let y = 0; y < BOX_H; y++) for (let x = 0; x < BOX_W; x++) {
  if (Lmap[y * BOX_W + x] < 0) continue;
  headTop = Math.min(headTop, y);
}
for (let y = headTop; y < headTop + 40; y++) for (let x = 0; x < BOX_W; x++) {
  if (Lmap[y * BOX_W + x] >= 0) { sumX += x; cntX++; }
}
const headCx = sumX / Math.max(1, cntX);
const isHair = (x, y, L) =>
  L >= 0 && L < 0.33 && (y < headTop + 30 || (y < headTop + 62 && Math.abs(x - headCx) > 30));

const photo = sample(src("photo-cut.png"), (r, g, b, a, x, y) => {
  const v = sharp[y * BOX_W + x];
  if (v < 0) return 0;
  // El pecho se desvanece hacia abajo: la cara es el foco (como el retrato de la referencia).
  const fade = y < BOX_H * 0.5 ? 1 : 1 - 0.6 * ((y - BOX_H * 0.5) / (BOX_H * 0.5));
  const tone = 0.03 + Math.pow(cdf[Math.round(v * 255)], 1.8);
  // Textura de mechones: el realce local (v) varía la densidad dentro del pelo.
  const hair = isHair(x, y, Lmap[y * BOX_W + x]) ? 0.16 + 0.5 * v : 0;
  return Math.max(tone, hair) * fade;
}, { crop: PHOTO_CROP });

const penguin = sample(src("penguin.png"), (r, g, b) => (r > 120 && r > b + 30 ? 0.9 : 0), { w: 260, h: 340 });

// Claude: naranjo incluyendo los tonos en sombra (las 2 patas traseras son más oscuras).
// Después se dejan solo las piezas grandes conectadas del muñeco: así se descartan
// manchas sueltas del fondo (algo "colgando" de la mano, reflejos de la baranda).
const claudePx = pixels(src("claude.png"), BOX_W, BOX_H);
const isOrange = (r, g, b) => r > 115 && r - g > 45 && g < 165 && b < 95 && r - b > 70;
const orange = new Uint8Array(BOX_W * BOX_H);
for (let y = 0; y < BOX_H; y++) for (let x = 0; x < BOX_W; x++) {
  const [r, g, b] = claudePx(x, y);
  if (isOrange(r, g, b)) orange[y * BOX_W + x] = 1;
}
const keep = new Uint8Array(BOX_W * BOX_H), seen = new Uint8Array(BOX_W * BOX_H);
for (let i = 0; i < orange.length; i++) {
  if (!orange[i] || seen[i]) continue;
  const comp = [], stack = [i];
  seen[i] = 1;
  while (stack.length) {
    const j = stack.pop(); comp.push(j);
    const x = j % BOX_W, y = (j / BOX_W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= BOX_W || yy >= BOX_H) continue;
      const k = yy * BOX_W + xx;
      if (orange[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
  }
  if (comp.length >= 250) for (const j of comp) keep[j] = 1; // patas incluidas (~600 px c/u)
}
// Apertura morfológica (erosión + dilatación, radio 2): borra salientes delgadas
// (el "hilo" bajo el brazo derecho, el gancho arriba a la izquierda) sin tocar brazos ni patas.
function morph(src, R, op) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < BOX_H; y++) for (let x = 0; x < BOX_W; x++) {
    let v = op === "erode" ? 1 : 0;
    for (let dy = -R; dy <= R && (op === "erode" ? v : !v); dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      const inside = xx >= 0 && yy >= 0 && xx < BOX_W && yy < BOX_H ? src[yy * BOX_W + xx] : 0;
      if (op === "erode" && !inside) { v = 0; break; }
      if (op === "dilate" && inside) { v = 1; break; }
    }
    out[y * BOX_W + x] = v;
  }
  return out;
}
const opened = morph(morph(keep, 2, "erode"), 2, "dilate");
for (let i = 0; i < keep.length; i++) keep[i] = keep[i] && opened[i];
let x0 = BOX_W, x1 = 0, y0 = BOX_H, y1 = 0;
for (let i = 0; i < keep.length; i++) if (keep[i]) {
  const x = i % BOX_W, y = (i / BOX_W) | 0;
  x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
}
const nearDark = (x, y) => {
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= BOX_W || yy >= BOX_H) continue;
    const [r, g, b] = claudePx(xx, yy);
    if (lum(r, g, b) < 0.16) return true;
  }
  return false;
};
const claude = sample(src("claude.png"), (r, g, b, a, x, y) => {
  if (keep[y * BOX_W + x]) return 0.34;
  if (x < x0 || x > x1 || y < y0 || y > y1) return 0;
  // Blancos de los lentes "deal with it": solo si hay negro de los lentes al lado. Sin esto
  // entraban blancos del fondo (baranda bajo el brazo, casa arriba a la izquierda).
  if (r > 165 && g > 165 && b > 165 && nearDark(x, y)) return 1;
  return 0;
});

const data = JSON.stringify({ box: [BOX_W, BOX_H], n: N, frames: [photo, penguin, claude] });
writeFileSync(join(ROOT, "assets/points.js"), `// Generado por scripts/sample-points.mjs — no editar a mano.\nwindow.POINTS = ${data};\n`);
console.error("ok → assets/points.js");
