// FotoFlow — mesin edit warna (auto grading ala fotografer profesional)
// Semua berjalan lokal di canvas. File asli tidak pernah diubah —
// hasil edit dirender sebagai file baru saat salin/upload.

export const DEFAULT_EDIT = {
  temp: 0,        // suhu warna: minus dingin, plus hangat
  exposure: 0,    // kecerahan (±1 stop pada ±100)
  contrast: 0,
  highlights: 0,  // minus = selamatkan bagian terang
  shadows: 0,     // plus = angkat bayangan
  saturation: 0,
  vibrance: 0,    // saturasi pintar: hanya dorong warna yang pucat
  vignette: 0,
}

export function isEdited(e) {
  return !!e && Object.keys(DEFAULT_EDIT).some((k) => (e[k] || 0) !== 0)
}

export const PRESETS = {
  natural: { label: '🌿 Natural Pro', edit: { temp: 3, exposure: 5, contrast: 10, highlights: -8, shadows: 6, saturation: 4, vibrance: 16, vignette: 0 } },
  hangat: { label: '🌇 Hangat Golden', edit: { temp: 18, exposure: 6, contrast: 8, highlights: -6, shadows: 8, saturation: 2, vibrance: 14, vignette: 12 } },
  sinematik: { label: '🎬 Sinematik', edit: { temp: -6, exposure: 2, contrast: 18, highlights: -14, shadows: 12, saturation: -8, vibrance: 12, vignette: 26 } },
  vivid: { label: '🌈 Vivid Tajam', edit: { temp: 0, exposure: 4, contrast: 15, highlights: -10, shadows: 4, saturation: 20, vibrance: 10, vignette: 0 } },
  bw: { label: '⬛ Hitam Putih', edit: { temp: 0, exposure: 3, contrast: 22, highlights: -8, shadows: 8, saturation: -100, vibrance: 0, vignette: 18 } },
}

// Terapkan parameter edit ke ImageData (mutasi langsung, kembalikan id yang sama)
export function applyEdits(id, e) {
  const d = id.data, w = id.width, h = id.height
  const expF = Math.pow(2, (e.exposure || 0) / 100)
  const con = 1 + (e.contrast || 0) / 100
  const sat = 1 + (e.saturation || 0) / 100
  const vib = (e.vibrance || 0) / 100
  const hi = (e.highlights || 0) / 100
  const sh = (e.shadows || 0) / 100
  const tR = 1 + (e.temp || 0) / 100 * 0.35
  const tB = 1 - (e.temp || 0) / 100 * 0.35
  const vig = (e.vignette || 0) / 100
  const cx = w / 2, cy = h / 2, maxD2 = cx * cx + cy * cy
  const hasCon = con !== 1, hasSat = sat !== 1 || vib !== 0

  for (let i = 0, px = 0; i < d.length; i += 4, px++) {
    let r = d[i] * tR * expF
    let g = d[i + 1] * expF
    let b = d[i + 2] * tB * expF

    if (sh || hi) {
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      if (sh) { const f = sh * Math.max(0, 1 - l * 2) * 70; r += f; g += f; b += f }
      if (hi) { const f = hi * Math.max(0, l * 2 - 1) * 70; r += f; g += f; b += f }
    }
    if (hasCon) {
      r = 128 + (r - 128) * con
      g = 128 + (g - 128) * con
      b = 128 + (b - 128) * con
    }
    if (hasSat) {
      const l2 = 0.299 * r + 0.587 * g + 0.114 * b
      let s = sat
      if (vib) {
        const cur = Math.min(1, Math.max(Math.abs(r - l2), Math.abs(g - l2), Math.abs(b - l2)) / 110)
        s += vib * (1 - cur) // dorong hanya warna yang masih pucat
      }
      r = l2 + (r - l2) * s
      g = l2 + (g - l2) * s
      b = l2 + (b - l2) * s
    }
    if (vig) {
      const x = px % w, y = (px / w) | 0
      const dd = ((x - cx) ** 2 + (y - cy) ** 2) / maxD2
      const v = 1 - vig * dd * 0.85
      r *= v; g *= v; b *= v
    }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r
    d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g
    d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
  }
  return id
}

// Analisis histogram → parameter otomatis "ala fotografer":
// koreksi white balance (gray world), eksposur ke mid-tone, regangkan kontras,
// selamatkan highlight, angkat bayangan, vibrance halus.
export function autoGrade(id) {
  const d = id.data, n = d.length / 4
  let mr = 0, mg = 0, mb = 0
  const hist = new Float64Array(256)
  for (let i = 0; i < d.length; i += 4) {
    mr += d[i]; mg += d[i + 1]; mb += d[i + 2]
    const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0
    hist[l > 255 ? 255 : l]++
  }
  mr /= n; mg /= n; mb /= n
  const mean = 0.299 * mr + 0.587 * mg + 0.114 * mb
  let acc = 0, p1 = 0, p99 = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc < n * 0.01) p1 = v
    if (acc <= n * 0.995) p99 = v
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
  // expF = 2^(e/100), jadi e = log2(target/mean) * 100 tepat membawa mid-tone ke target
  const exposure = clamp(Math.log2(118 / Math.max(20, mean)) * 100, -45, 45)
  const range = Math.max(40, p99 - p1)
  // foto sangat gelap: tahan kontras dulu supaya tidak melawan koreksi eksposur
  const contrast = clamp((215 / range - 1) * 70, 8, mean < 80 ? 15 : 30)
  const temp = clamp((mb - mr) * 0.6, -25, 25) // bluish → hangatkan, dan sebaliknya
  return {
    ...DEFAULT_EDIT,
    temp: Math.round(temp),
    exposure: Math.round(exposure),
    contrast: Math.round(contrast),
    highlights: -10,
    shadows: 8,
    saturation: 4,
    vibrance: 18,
  }
}

// Render hasil edit ke JPEG resolusi penuh (untuk salin ke PC / upload FB)
export async function renderEditedBlob(file, edit, quality = 0.95) {
  const bmp = await createImageBitmap(file)
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const id = ctx.getImageData(0, 0, c.width, c.height)
  applyEdits(id, edit)
  ctx.putImageData(id, 0, 0)
  return c.convertToBlob({ type: 'image/jpeg', quality })
}
