// FotoFlow — mesin analisis kualitas foto (berjalan 100% lokal di browser)
// Menilai foto seperti fotografer: ketajaman, eksposur, kontras, warna,
// lalu mengelompokkan foto mirip (burst/duplikat) agar hanya yang terbaik terpilih.

const ANALYZE_SIZE = 384; // sisi terpanjang saat analisis (kecil = cepat, cukup akurat)
const HASH_SIZE = 8;      // dHash 8x8 untuk deteksi foto mirip

export const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i;

async function bitmapFromFile(file, maxSide) {
  const opts = {};
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale >= 1) return { bmp, w: bmp.width, h: bmp.height, ow: bmp.width, oh: bmp.height };
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const small = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
  const ow = bmp.width, oh = bmp.height;
  bmp.close();
  return { bmp: small, w, h, ow, oh };
}

function imageData(bmp, w, h) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// --- metrik ---------------------------------------------------------------

function toGray(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

// Ketajaman: variansi Laplacian (semakin tinggi = semakin tajam / tidak blur)
function sharpnessScore(gray, w, h) {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const variance = sumSq / n - (sum / n) ** 2;
  // skala log: var ~15 = sangat blur, ~500+ = sangat tajam
  const score = Math.max(0, Math.min(100, (Math.log10(variance + 1) - 1) / (2.8 - 1) * 100));
  return { score, variance };
}

// Eksposur: histogram luma — hukum clipping gelap/terang, hargai mid-tone & kontras
function exposureScore(gray) {
  const hist = new Float64Array(256);
  let mean = 0;
  for (let i = 0; i < gray.length; i++) { const v = gray[i] | 0; hist[v < 0 ? 0 : v > 255 ? 255 : v]++; mean += gray[i]; }
  mean /= gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) ** 2;
  const std = Math.sqrt(variance / gray.length);
  let dark = 0, bright = 0;
  for (let v = 0; v < 8; v++) dark += hist[v];
  for (let v = 248; v < 256; v++) bright += hist[v];
  dark /= gray.length; bright /= gray.length;

  // ideal: mean 105-150, std >= 40, clipping < 2%
  let s = 100;
  if (mean < 105) s -= Math.min(45, (105 - mean) * 0.75);
  if (mean > 150) s -= Math.min(45, (mean - 150) * 0.75);
  s -= Math.min(25, Math.max(0, dark - 0.02) * 250);
  s -= Math.min(25, Math.max(0, bright - 0.02) * 300);
  if (std < 40) s -= Math.min(25, (40 - std) * 0.9);
  return { score: Math.max(0, Math.min(100, s)), mean, std, dark, bright };
}

// Warna: metrik colorfulness Hasler–Süsstrunk
function colorfulnessScore(data) {
  let mRG = 0, mYB = 0, sRG = 0, sYB = 0;
  const n = data.length / 4;
  for (let p = 0; p < data.length; p += 4) {
    const rg = data[p] - data[p + 1];
    const yb = 0.5 * (data[p] + data[p + 1]) - data[p + 2];
    mRG += rg; mYB += yb; sRG += rg * rg; sYB += yb * yb;
  }
  mRG /= n; mYB /= n;
  const stdRG = Math.sqrt(Math.max(0, sRG / n - mRG * mRG));
  const stdYB = Math.sqrt(Math.max(0, sYB / n - mYB * mYB));
  const c = Math.sqrt(stdRG ** 2 + stdYB ** 2) + 0.3 * Math.sqrt(mRG ** 2 + mYB ** 2);
  // c ~0 = hitam-putih, ~40 = normal, 80+ = sangat vivid
  const score = Math.max(0, Math.min(100, (c / 75) * 100));
  return { score, c };
}

// dHash untuk deteksi foto mirip (burst / jepretan berulang)
function dHash(bmp) {
  const w = HASH_SIZE + 1, h = HASH_SIZE;
  const id = imageData(bmp, w, h);
  const g = toGray(id.data, w, h);
  let hi = 0, lo = 0, bit = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      const b = g[y * w + x] > g[y * w + x + 1] ? 1 : 0;
      if (bit < 32) lo = (lo << 1) | b; else hi = (hi << 1) | b;
      bit++;
    }
  }
  return [lo >>> 0, hi >>> 0];
}

export function hammingDistance(a, b) {
  let d = 0;
  for (let k = 0; k < 2; k++) {
    let x = (a[k] ^ b[k]) >>> 0;
    while (x) { d += x & 1; x >>>= 1; }
  }
  return d;
}

// --- analisis satu foto -----------------------------------------------------

export async function analyzePhoto(file) {
  const { bmp, w, h, ow, oh } = await bitmapFromFile(file, ANALYZE_SIZE);
  try {
    const id = imageData(bmp, w, h);
    const gray = toGray(id.data, w, h);
    const sharp = sharpnessScore(gray, w, h);
    const expo = exposureScore(gray);
    const color = colorfulnessScore(id.data);
    const hash = dHash(bmp);

    const mp = (ow * oh) / 1e6;
    const resBonus = Math.min(5, mp); // bonus kecil untuk resolusi tinggi

    const score = Math.round(
      Math.min(100,
        sharp.score * 0.45 + expo.score * 0.35 + color.score * 0.20 + resBonus * 0.5
      ) * 10
    ) / 10;

    return {
      score,
      sharpness: Math.round(sharp.score),
      exposure: Math.round(expo.score),
      color: Math.round(color.score),
      width: ow, height: oh, mp: Math.round(mp * 10) / 10,
      hash,
      flags: {
        blur: sharp.score < 35,
        gelap: expo.mean < 80,
        terang: expo.bright > 0.06,
        pucat: color.score < 15,
      },
    };
  } finally {
    bmp.close();
  }
}

// Kelompokkan foto mirip; dalam tiap grup, yang skor tertinggi = juara
export function groupSimilar(items, threshold = 10) {
  const groups = [];
  for (const it of items) {
    let placed = false;
    for (const g of groups) {
      if (hammingDistance(g[0].hash, it.hash) <= threshold) { g.push(it); placed = true; break; }
    }
    if (!placed) groups.push([it]);
  }
  let gid = 0;
  for (const g of groups) {
    g.sort((a, b) => b.score - a.score);
    g.forEach((it, i) => { it.group = gid; it.bestOfGroup = i === 0; it.groupSize = g.length; });
    gid++;
  }
  return groups;
}
