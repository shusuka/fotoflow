// FotoFlow — pemeriksaan AI (Claude vision) + auto caption
// Menyaring foto yang tidak layak posting: uang, struk/transaksi, produk ilegal,
// screenshot, wajah tanpa ekspresi — dan membuat caption menarik untuk yang layak.
// Butuh API key Claude (console.anthropic.com). Berjalan langsung dari browser.

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001' // cepat & murah, cukup untuk kurasi foto

const PROMPT = `Kamu kurator foto untuk halaman Facebook yang ingin semua postingannya ENAK DILIHAT dan menarik perhatian orang.

Nilai foto ini. Foto TIDAK LAYAK jika termasuk salah satu:
- screenshot layar HP/komputer, chat, atau aplikasi
- foto uang, transfer, struk, nota, bukti transaksi, atau dokumen
- produk ilegal / berbahaya (obat terlarang, senjata, judi, dsb.)
- wajah orang tanpa ekspresi / datar / tidak menarik sebagai subjek utama
- kualitas jelek (blur parah, terlalu gelap, tidak jelas objeknya)
- membosankan / tidak ada daya tarik visual sama sekali

Jika LAYAK, buatkan caption bahasa Indonesia yang santai, hangat, dan bikin orang berhenti scroll: 1-2 kalimat, boleh 1 emoji, akhiri dengan 2 hashtag relevan.

Balas HANYA JSON valid tanpa teks lain:
{"layak": true/false, "kategori": "oke|screenshot|uang|transaksi|produk_ilegal|wajah_datar|kualitas_jelek|membosankan", "alasan": "penjelasan singkat", "caption": "caption jika layak, kosongkan jika tidak"}`

async function fileToJpegBase64(file, maxSide = 896) {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d').drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
  const buf = await blob.arrayBuffer()
  let bin = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(bin)
}

export async function aiReviewPhoto({ apiKey, file }) {
  const data = await fileToJpegBase64(file)
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  const text = j.content?.map((c) => c.text || '').join('') || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('Jawaban AI tidak terbaca')
  const out = JSON.parse(m[0])
  return {
    layak: !!out.layak,
    kategori: out.kategori || (out.layak ? 'oke' : 'membosankan'),
    alasan: out.alasan || '',
    caption: out.caption || '',
  }
}

export const KATEGORI_LABEL = {
  oke: 'layak',
  screenshot: 'screenshot',
  uang: 'foto uang',
  transaksi: 'struk/transaksi',
  produk_ilegal: 'produk terlarang',
  wajah_datar: 'wajah tanpa ekspresi',
  kualitas_jelek: 'kualitas jelek',
  membosankan: 'kurang menarik',
}
