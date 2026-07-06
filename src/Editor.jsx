import { useEffect, useRef, useState } from 'react'
import { DEFAULT_EDIT, PRESETS, applyEdits, autoGrade } from './editor.js'

const SLIDERS = [
  ['temp', '🌡️ Suhu warna', -50, 50],
  ['exposure', '☀️ Kecerahan', -60, 60],
  ['contrast', '◐ Kontras', -50, 50],
  ['highlights', '🔆 Highlight', -60, 30],
  ['shadows', '🌑 Bayangan', -30, 60],
  ['saturation', '🎨 Saturasi', -100, 60],
  ['vibrance', '✨ Vibrance', -30, 60],
  ['vignette', '⭕ Vignette', 0, 60],
]

export default function Editor({ photo, initial, onSave, onSaveAll, onClose }) {
  const [edit, setEdit] = useState({ ...DEFAULT_EDIT, ...(initial || {}) })
  const [showOrig, setShowOrig] = useState(false)
  const [ready, setReady] = useState(false)
  const canvasRef = useRef(null)
  const baseRef = useRef(null)
  const rafRef = useRef(0)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const file = await photo.handle.getFile()
      const bmp = await createImageBitmap(file)
      const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height))
      const w = Math.max(1, Math.round(bmp.width * scale))
      const h = Math.max(1, Math.round(bmp.height * scale))
      const off = new OffscreenCanvas(w, h)
      const octx = off.getContext('2d', { willReadFrequently: true })
      octx.drawImage(bmp, 0, 0, w, h)
      bmp.close()
      if (dead) return
      baseRef.current = octx.getImageData(0, 0, w, h)
      const c = canvasRef.current
      if (c) { c.width = w; c.height = h }
      setReady(true)
    })()
    return () => { dead = true }
  }, [photo])

  useEffect(() => {
    if (!ready) return
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const base = baseRef.current, c = canvasRef.current
      if (!base || !c) return
      const ctx = c.getContext('2d')
      if (showOrig) { ctx.putImageData(base, 0, 0); return }
      const copy = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
      ctx.putImageData(applyEdits(copy, edit), 0, 0)
    })
  }, [edit, showOrig, ready])

  return (
    <div className="editor">
      <div className="ecanvas">
        <canvas ref={canvasRef} />
        {!ready && <div className="eloading">Memuat foto…</div>}
        <div className="ename">{photo.name}</div>
      </div>
      <div className="epanel">
        <h3>🎨 Editor Foto</h3>
        <button className="big sm wide" onClick={() => setEdit(autoGrade(baseRef.current))} disabled={!ready}>
          ✨ Auto — ala fotografer pro
        </button>
        <div className="presets">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} className="ghost" onClick={() => setEdit({ ...DEFAULT_EDIT, ...p.edit })}>{p.label}</button>
          ))}
        </div>
        <div className="sliders">
          {SLIDERS.map(([key, label, min, max]) => (
            <label key={key}>
              <span>{label} <b>{edit[key]}</b></span>
              <input type="range" min={min} max={max} value={edit[key]}
                onChange={(e) => setEdit((s) => ({ ...s, [key]: +e.target.value }))} />
            </label>
          ))}
        </div>
        <button className="ghost wide" onPointerDown={() => setShowOrig(true)} onPointerUp={() => setShowOrig(false)}
          onPointerLeave={() => setShowOrig(false)}>👁 Tahan untuk lihat foto asli</button>
        <div className="eactions">
          <button className="ghost" onClick={() => setEdit({ ...DEFAULT_EDIT })}>Reset</button>
          <button className="ghost" onClick={onClose}>Batal</button>
          <button className="big sm" onClick={() => onSave(edit)}>💾 Simpan</button>
        </div>
        <button className="ghost wide" onClick={() => onSaveAll(edit)}>💾 Simpan & terapkan ke SEMUA foto terpilih</button>
        <p className="dim enote">File asli tidak diubah — hasil edit dirender sebagai file baru saat disalin ke PC atau di-upload ke Facebook.</p>
      </div>
    </div>
  )
}
