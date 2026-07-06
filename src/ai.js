// FotoFlow — pemeriksaan AI (vision) + auto caption
// Menyaring foto yang tidak layak posting: uang, struk/transaksi, produk ilegal,
// screenshot, wajah tanpa ekspresi — dan membuat caption menarik untuk yang layak.
// Mendukung 2 penyedia, dideteksi otomatis dari bentuk API key:
//   - Claude  (console.anthropic.com, key "sk-ant-...")
//   - Gemini  (aistudio.google.com,   key "AIza...") — ada kuota gratis
// Berjalan langsung dari browser.

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001' // cepat & murah, cukup untuk kurasi foto
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'] // coba berurutan

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

// Bersihkan key dari karakter tersembunyi hasil copy-paste (spasi, zero-width, dsb.)
// — header fetch hanya menerima ASCII, karakter aneh bikin error "non ISO-8859-1".
function cleanKey(apiKey) {
  return (apiKey || '').replace(/[^\x21-\x7E]/g, '')
}

function parseVerdict(text) {
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

async function claudeReview(key, data) {
  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
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
  return parseVerdict(j.content?.map((c) => c.text || '').join('') || '')
}

async function geminiReview(key, data) {
  let lastErr
  for (const model of GEMINI_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data } },
              { text: PROMPT },
            ],
          }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
        }),
      },
    )
    const j = await res.json()
    if (j.error) {
      lastErr = new Error(j.error.message)
      // model belum tersedia untuk key ini → coba model berikutnya
      if (res.status === 404 || /not\s*found|NOT_FOUND/i.test(j.error.message || '')) continue
      throw lastErr
    }
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
    return parseVerdict(text)
  }
  throw lastErr || new Error('Model Gemini tidak tersedia untuk key ini')
}

export async function aiReviewPhoto({ apiKey, file }) {
  const key = cleanKey(apiKey)
  if (!key) throw new Error('API key kosong')
  const data = await fileToJpegBase64(file)
  if (key.startsWith('AIza')) return geminiReview(key, data)
  if (key.startsWith('sk-ant')) return claudeReview(key, data)
  throw new Error('API key tidak dikenali — pakai key Claude (sk-ant-...) atau Gemini (AIza...)')
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
