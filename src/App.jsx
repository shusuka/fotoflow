import { useEffect, useMemo, useRef, useState } from 'react'
import { analyzePhoto, groupSimilar, IMAGE_EXT } from './scoring.js'
import { fbCheckToken, fbSchedulePhoto } from './fb.js'

const LS_FB = 'fotoflow_fb'
const LS_META = 'fotoflow_meta' // judul & jadwal per foto (terpisah dari file)

const fmtBytes = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB'
const pad = (n) => String(n).padStart(2, '0')
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

async function* walkDir(dirHandle, path = '') {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && IMAGE_EXT.test(entry.name)) {
      yield { handle: entry, path: path + entry.name }
    } else if (entry.kind === 'directory') {
      yield* walkDir(entry, path + entry.name + '/')
    }
  }
}

async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 360 / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const c = new OffscreenCanvas(w, h)
    c.getContext('2d').drawImage(bmp, 0, 0, w, h)
    bmp.close()
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
    return URL.createObjectURL(blob)
  } catch { return null }
}

export default function App() {
  const [step, setStep] = useState(1)
  const [photos, setPhotos] = useState([])
  const [progress, setProgress] = useState(null) // {done,total,name}
  const [folderName, setFolderName] = useState('')
  const [minScore, setMinScore] = useState(60)
  const [autoBest, setAutoBest] = useState(true) // hanya juara grup mirip
  const [preview, setPreview] = useState(null)
  const [meta, setMeta] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_META)) || {} } catch { return {} } })
  const [copyState, setCopyState] = useState(null)
  const [fb, setFb] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_FB)) || { pageId: '', token: '' } } catch { return { pageId: '', token: '' } } })
  const [fbStatus, setFbStatus] = useState(null)
  const [schedBase, setSchedBase] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))
  const [schedGapH, setSchedGapH] = useState(24)
  const [uploadState, setUploadState] = useState(null)
  const cancelRef = useRef(false)

  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  useEffect(() => { localStorage.setItem(LS_META, JSON.stringify(meta)) }, [meta])
  useEffect(() => { localStorage.setItem(LS_FB, JSON.stringify(fb)) }, [fb])

  const setPhotoMeta = (key, patch) =>
    setMeta((m) => ({ ...m, [key]: { ...(m[key] || {}), ...patch } }))

  // ---- LANGKAH 1: pilih folder & analisis --------------------------------
  async function pickSource() {
    let dir
    try { dir = await window.showDirectoryPicker({ id: 'fotoflow-src' }) } catch { return }
    setFolderName(dir.name)
    setPhotos([]); setStep(1); cancelRef.current = false

    const entries = []
    for await (const e of walkDir(dir)) entries.push(e)
    if (!entries.length) { setProgress(null); alert('Tidak ada file foto di folder ini.'); return }

    setProgress({ done: 0, total: entries.length, name: '' })
    const results = []
    for (let i = 0; i < entries.length; i++) {
      if (cancelRef.current) break
      const { handle, path } = entries[i]
      setProgress({ done: i, total: entries.length, name: handle.name })
      try {
        const file = await handle.getFile()
        const [a, thumb] = await Promise.all([analyzePhoto(file), makeThumb(file)])
        results.push({
          id: path, name: handle.name, path, handle,
          size: file.size, lastModified: file.lastModified,
          thumb, ...a, selected: false,
        })
      } catch (e) { console.warn('Gagal analisis', path, e) }
      if (i % 8 === 0) await new Promise((r) => setTimeout(r)) // biar UI tetap responsif
    }
    groupSimilar(results)
    results.sort((a, b) => b.score - a.score)
    // seleksi awal otomatis: skor >= ambang & juara grupnya
    for (const p of results) p.selected = p.score >= 60 && p.bestOfGroup
    setPhotos(results)
    setProgress(null)
    setStep(2)
  }

  function applyAutoSelect(ms = minScore, best = autoBest) {
    setPhotos((ps) => ps.map((p) => ({ ...p, selected: p.score >= ms && (!best || p.bestOfGroup) })))
  }

  const selected = useMemo(() => photos.filter((p) => p.selected), [photos])

  const toggle = (id) => setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p)))

  // ---- LANGKAH 3: jadwal otomatis -----------------------------------------
  function autoSchedule() {
    const base = new Date(schedBase)
    selected.forEach((p, i) => {
      const t = new Date(base.getTime() + i * schedGapH * 3600 * 1000)
      setPhotoMeta(p.id, { jadwal: toLocalInput(t) })
    })
  }

  // ---- LANGKAH 4: salin file asli ke folder output -------------------------
  async function copyToOutput() {
    let out
    try { out = await window.showDirectoryPicker({ id: 'fotoflow-out', mode: 'readwrite' }) } catch { return }
    setCopyState({ done: 0, total: selected.length, errors: [] })
    const manifest = []
    for (let i = 0; i < selected.length; i++) {
      const p = selected[i]
      try {
        const file = await p.handle.getFile()
        const outName = `${pad(i + 1)}_${p.name}`
        const fh = await out.getFileHandle(outName, { create: true })
        const w = await fh.createWritable()
        await w.write(file) // salinan byte asli, tanpa kompres ulang
        await w.close()
        manifest.push({
          file: outName, asli: p.path, skor: p.score,
          judul: meta[p.id]?.judul || '', jadwal: meta[p.id]?.jadwal || '',
          ketajaman: p.sharpness, eksposur: p.exposure, warna: p.color,
          resolusi: `${p.width}x${p.height}`,
        })
        setCopyState({ done: i + 1, total: selected.length, errors: [] })
      } catch (e) {
        setCopyState((s) => ({ ...s, errors: [...s.errors, `${p.name}: ${e.message}`] }))
      }
    }
    // database judul/jadwal disimpan TERPISAH sebagai file JSON di folder output
    try {
      const fh = await out.getFileHandle('fotoflow-data.json', { create: true })
      const w = await fh.createWritable()
      await w.write(JSON.stringify({ dibuat: new Date().toISOString(), sumber: folderName, foto: manifest }, null, 2))
      await w.close()
    } catch (e) { console.warn(e) }
    setCopyState((s) => ({ ...s, finished: true, outName: out.name }))
  }

  // ---- LANGKAH 5: Facebook -------------------------------------------------
  async function testFb() {
    setFbStatus({ loading: true })
    try {
      const j = await fbCheckToken(fb.pageId.trim(), fb.token.trim())
      setFbStatus({ ok: true, name: j.name })
    } catch (e) { setFbStatus({ error: e.message }) }
  }

  async function uploadAll() {
    const list = selected.filter((p) => meta[p.id]?.jadwal)
    if (!list.length) { alert('Belum ada foto terpilih yang punya jadwal. Isi jadwal dulu di langkah 3.'); return }
    if (!fb.pageId || !fb.token) { alert('Isi Page ID dan Access Token dulu.'); return }
    setUploadState({ done: 0, total: list.length, log: [] })
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      try {
        const file = await p.handle.getFile()
        await fbSchedulePhoto({
          pageId: fb.pageId.trim(), token: fb.token.trim(), file,
          caption: meta[p.id]?.judul || '', publishAt: new Date(meta[p.id].jadwal),
        })
        setUploadState((s) => ({ ...s, done: i + 1, log: [...s.log, { ok: true, name: p.name, at: meta[p.id].jadwal }] }))
      } catch (e) {
        setUploadState((s) => ({ ...s, done: i + 1, log: [...s.log, { ok: false, name: p.name, err: e.message }] }))
      }
    }
    setUploadState((s) => ({ ...s, finished: true }))
  }

  // ---- render ----------------------------------------------------------------
  const steps = ['Pilih Folder', 'Sortir Otomatis', 'Judul & Jadwal', 'Salin ke PC', 'Upload Facebook']

  return (
    <div className="app">
      <header>
        <div className="logo">📸 <b>FotoFlow</b> <span className="tag">sortir foto otomatis ala fotografer</span></div>
        <nav className="steps">
          {steps.map((s, i) => (
            <button key={s} className={step === i + 1 ? 'on' : ''} disabled={i + 1 > 2 && !photos.length}
              onClick={() => setStep(i + 1)}>{i + 1}. {s}</button>
          ))}
        </nav>
      </header>

      {!supported && (
        <div className="warn">Browser ini belum mendukung akses folder. Gunakan <b>Chrome</b> atau <b>Edge</b> di PC.</div>
      )}

      {step === 1 && (
        <section className="panel center">
          <h1>Pilih folder foto di PC kamu</h1>
          <p>FotoFlow membaca foto langsung dari folder (termasuk sub-folder), menilai <b>ketajaman, eksposur, dan warna</b> setiap foto,
            lalu mengelompokkan jepretan yang mirip supaya hanya <b>yang terbaik</b> yang terpilih.
            Semua proses berjalan <b>lokal di browser</b> — foto tidak dikirim ke mana-mana.</p>
          <button className="big" onClick={pickSource} disabled={!supported || !!progress}>📂 Pilih Folder Foto</button>
          {progress && (
            <div className="progress">
              <div className="bar"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
              <div className="plabel">Menganalisis {progress.done + 1}/{progress.total} — {progress.name}</div>
              <button className="ghost" onClick={() => { cancelRef.current = true }}>Berhenti</button>
            </div>
          )}
          {!!photos.length && !progress && (
            <p className="ok">✔ {photos.length} foto dari folder <b>{folderName}</b> sudah dianalisis. Lanjut ke langkah 2.</p>
          )}
        </section>
      )}

      {step === 2 && (
        <section>
          <div className="toolbar">
            <div><b>{photos.length}</b> foto · terpilih <b className="hl">{selected.length}</b></div>
            <label>Skor minimal <input type="range" min="0" max="95" value={minScore}
              onChange={(e) => { const v = +e.target.value; setMinScore(v); applyAutoSelect(v, autoBest) }} /> <b>{minScore}</b></label>
            <label><input type="checkbox" checked={autoBest}
              onChange={(e) => { setAutoBest(e.target.checked); applyAutoSelect(minScore, e.target.checked) }} />
              Hanya juara dari foto mirip</label>
            <button className="ghost" onClick={() => setPhotos((ps) => ps.map((p) => ({ ...p, selected: true })))}>Pilih semua</button>
            <button className="ghost" onClick={() => setPhotos((ps) => ps.map((p) => ({ ...p, selected: false })))}>Kosongkan</button>
            <button className="big sm" disabled={!selected.length} onClick={() => setStep(3)}>Lanjut: Judul & Jadwal →</button>
          </div>
          <div className="grid">
            {photos.map((p) => (
              <div key={p.id} className={'card' + (p.selected ? ' sel' : '')}>
                <div className="imgwrap" onClick={() => setPreview(p)}>
                  {p.thumb ? <img src={p.thumb} alt={p.name} loading="lazy" /> : <div className="noimg">?</div>}
                  <span className={'score s' + (p.score >= 75 ? 'g' : p.score >= 55 ? 'y' : 'r')}>{p.score}</span>
                  {p.groupSize > 1 && <span className="dup">{p.bestOfGroup ? '★ terbaik' : '≈ mirip'} ({p.groupSize})</span>}
                </div>
                <div className="cinfo">
                  <label className="pick"><input type="checkbox" checked={p.selected} onChange={() => toggle(p.id)} /> <span className="fname" title={p.path}>{p.name}</span></label>
                  <div className="badges">
                    {p.flags.blur && <em className="bad">blur</em>}
                    {p.flags.gelap && <em className="bad">gelap</em>}
                    {p.flags.terang && <em className="bad">over</em>}
                    {p.flags.pucat && <em>pucat</em>}
                    {!p.flags.blur && p.sharpness >= 70 && <em className="good">tajam</em>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="panel">
          <h2>Judul & jadwal untuk {selected.length} foto terpilih</h2>
          <p className="dim">Judul inilah yang tampil sebagai caption di Facebook. Buat yang enak dibaca orang 😊</p>
          <div className="schedrow">
            <label>Mulai tayang <input type="datetime-local" value={schedBase} onChange={(e) => setSchedBase(e.target.value)} /></label>
            <label>Jarak antar posting <input type="number" min="1" max="168" value={schedGapH} onChange={(e) => setSchedGapH(+e.target.value || 24)} style={{ width: 60 }} /> jam</label>
            <button className="ghost" onClick={autoSchedule}>⚡ Isi jadwal otomatis</button>
            <button className="big sm" onClick={() => setStep(4)}>Lanjut: Salin ke PC →</button>
          </div>
          <div className="rows">
            {selected.map((p, i) => (
              <div key={p.id} className="row">
                <img src={p.thumb} alt="" onClick={() => setPreview(p)} />
                <div className="rmain">
                  <div className="rname">{pad(i + 1)} · {p.name} <span className={'score inline s' + (p.score >= 75 ? 'g' : 'y')}>{p.score}</span></div>
                  <input className="judul" placeholder="Tulis judul / caption foto ini…"
                    value={meta[p.id]?.judul || ''} onChange={(e) => setPhotoMeta(p.id, { judul: e.target.value })} />
                </div>
                <input type="datetime-local" value={meta[p.id]?.jadwal || ''} onChange={(e) => setPhotoMeta(p.id, { jadwal: e.target.value })} />
              </div>
            ))}
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="panel center">
          <h2>Salin {selected.length} foto terpilih ke folder output</h2>
          <p>File disalin <b>persis seperti aslinya</b> (tanpa kompres ulang), diberi nomor urut,
            dan datanya (judul, jadwal, skor) disimpan terpisah di <code>fotoflow-data.json</code>.</p>
          <button className="big" onClick={copyToOutput} disabled={!selected.length || (copyState && !copyState.finished)}>📁 Pilih Folder Output & Salin</button>
          {copyState && (
            <div className="progress">
              <div className="bar"><div style={{ width: `${(copyState.done / copyState.total) * 100}%` }} /></div>
              <div className="plabel">{copyState.done}/{copyState.total} tersalin</div>
              {copyState.finished && <p className="ok">✔ Selesai! Foto + fotoflow-data.json ada di folder <b>{copyState.outName}</b>.</p>}
              {copyState.errors?.map((e, i) => <p key={i} className="err">{e}</p>)}
            </div>
          )}
          <button className="ghost" onClick={() => setStep(5)}>Lanjut: Upload Facebook →</button>
        </section>
      )}

      {step === 5 && (
        <section className="panel">
          <h2>Upload terjadwal ke Facebook Page</h2>
          <p className="dim">Penjadwalan hanya bisa untuk <b>Halaman (Page)</b>, bukan profil pribadi — ini aturan Facebook.
            Buat token di <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">Graph API Explorer</a> dengan
            izin <code>pages_manage_posts</code>. Jadwal minimal 10 menit & maksimal 75 hari ke depan.</p>
          <div className="fbform">
            <input placeholder="Page ID" value={fb.pageId} onChange={(e) => setFb({ ...fb, pageId: e.target.value })} />
            <input placeholder="Page Access Token" type="password" value={fb.token} onChange={(e) => setFb({ ...fb, token: e.target.value })} />
            <button className="ghost" onClick={testFb}>Tes koneksi</button>
            {fbStatus?.loading && <span className="dim">memeriksa…</span>}
            {fbStatus?.ok && <span className="ok">✔ Terhubung ke Page: <b>{fbStatus.name}</b></span>}
            {fbStatus?.error && <span className="err">✖ {fbStatus.error}</span>}
          </div>
          <button className="big" onClick={uploadAll} disabled={uploadState && !uploadState.finished}>
            🚀 Jadwalkan {selected.filter((p) => meta[p.id]?.jadwal).length} foto ke Facebook
          </button>
          {uploadState && (
            <div className="progress">
              <div className="bar"><div style={{ width: `${(uploadState.done / uploadState.total) * 100}%` }} /></div>
              <div className="plabel">{uploadState.done}/{uploadState.total} diproses</div>
              <div className="rows">
                {uploadState.log.map((l, i) => (
                  <p key={i} className={l.ok ? 'ok' : 'err'}>{l.ok ? `✔ ${l.name} → tayang ${l.at.replace('T', ' ')}` : `✖ ${l.name}: ${l.err}`}</p>
                ))}
              </div>
              {uploadState.finished && <p className="ok"><b>Selesai.</b> Cek di Meta Business Suite → Konten Terjadwal.</p>}
            </div>
          )}
        </section>
      )}

      {preview && (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <img src={preview.thumb} alt={preview.name} />
          <div className="ldetail">
            <b>{preview.name}</b> · skor <b>{preview.score}</b>
            <div>Ketajaman {preview.sharpness} · Eksposur {preview.exposure} · Warna {preview.color}</div>
            <div>{preview.width}×{preview.height} ({preview.mp} MP) · {fmtBytes(preview.size)}</div>
          </div>
        </div>
      )}

      <footer>FotoFlow — sortir lokal di browser, foto tidak pernah meninggalkan PC kecuali kamu upload ke Facebook.</footer>
    </div>
  )
}
