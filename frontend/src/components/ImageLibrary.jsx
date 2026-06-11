import { useState, useEffect, useRef, lazy, Suspense } from 'react'
const ImageMap = lazy(() => import('./ImageMap'))

// Find the nearest preset label for a given coordinate
function nearestPreset(lat, lon) {
  let best = null, minDist = Infinity
  for (const p of PRESETS) {
    const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2
    if (d < minDist) { minDist = d; best = p }
  }
  return best?.label ?? null
}

const SLOTS = [
  { key: 'night',   label: 'Natt',   hours: '00–06', icon: '🌙' },
  { key: 'morning', label: 'Morgon', hours: '06–12', icon: '🌅' },
  { key: 'day',     label: 'Dag',    hours: '12–18', icon: '☀️' },
  { key: 'evening', label: 'Kväll',  hours: '18–24', icon: '🌇' },
]

const PRESETS = [
  { label: 'Centrum',      lat: 57.7060, lon: 11.9670 },
  { label: 'Haga',         lat: 57.7010, lon: 11.9580 },
  { label: 'Majorna',      lat: 57.6940, lon: 11.9400 },
  { label: 'Linnéstaden',  lat: 57.6970, lon: 11.9520 },
  { label: 'Vasastan',     lat: 57.7100, lon: 11.9730 },
  { label: 'Eriksberg',    lat: 57.7210, lon: 11.9290 },
  { label: 'Backaplan',    lat: 57.7370, lon: 11.9630 },
  { label: 'Frölunda',     lat: 57.6590, lon: 11.9130 },
  { label: 'Örgryte',      lat: 57.6970, lon: 12.0050 },
  { label: 'Mölndal',      lat: 57.6560, lon: 12.0130 },
]

async function resizeToWebP(file, maxWidth = 1400, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width)
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        blob => resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' })),
        'image/webp',
        quality,
      )
    }
    img.src = URL.createObjectURL(file)
  })
}

// Group images by label → { label, lat, lon, slots: { night, morning, day, evening } }
function groupByLocation(images) {
  const map = {}
  for (const img of images ?? []) {
    if (!map[img.label]) {
      map[img.label] = { label: img.label, lat: img.lat, lon: img.lon, slots: {} }
    }
    map[img.label].slots[img.time_slot] = img
  }
  return Object.values(map).sort((a, b) => a.label.localeCompare(b.label))
}

// ── Upload form ───────────────────────────────────────────────────────────────

function UploadForm({ onUpload, defaultLabel = '', defaultLat = '', defaultLon = '', defaultSlot = 'day', onClose }) {
  const [file, setFile]         = useState(null)
  const [label, setLabel]       = useState(defaultLabel)
  const [lat, setLat]           = useState(defaultLat)
  const [lon, setLon]           = useState(defaultLon)
  const [slot, setSlot]         = useState(defaultSlot)
  const [preset, setPreset]     = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError]       = useState(null)
  const [progress, setProgress] = useState(null)

  // Sync lat/lon when parent updates them via map click (after form is already open)
  useEffect(() => { if (defaultLat) setLat(defaultLat) }, [defaultLat])
  useEffect(() => { if (defaultLon) setLon(defaultLon) }, [defaultLon])

  const handlePreset = e => {
    const name = e.target.value
    setPreset(name)
    const p = PRESETS.find(p => p.label === name)
    if (p) {
      // Only fill coordinates if not already set from a map click
      if (!lat) setLat(String(p.lat))
      if (!lon) setLon(String(p.lon))
      if (!label) setLabel(name)
    }
  }

  const handleSubmit = async e => {
    e.preventDefault()
    if (!file || !label || !lat || !lon) return
    setUploading(true)
    setError(null)
    setProgress('Komprimerar…')
    try {
      const resized = await resizeToWebP(file)
      setProgress('Laddar upp…')
      const fd = new FormData()
      fd.append('file', resized)
      fd.append('label', label)
      fd.append('lat', lat)
      fd.append('lon', lon)
      fd.append('time_slot', slot)
      await onUpload(fd)
      onClose?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Time slot picker */}
      <div>
        <label className="text-slate-400 text-xs mb-2 block">Tidslot</label>
        <div className="grid grid-cols-4 gap-2">
          {SLOTS.map(s => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSlot(s.key)}
              className={`flex flex-col items-center gap-1 py-2 rounded-lg text-xs transition-colors ${
                slot === s.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
            >
              <span>{s.icon}</span>
              <span className="font-medium">{s.label}</span>
              <span className="text-slate-400 text-[10px]">{s.hours}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Preset location — only fills label if coords already set from map */}
      <div>
        <label className="text-slate-400 text-xs mb-1 block">
          Snabbval etikett
          {lat && lon && <span className="text-blue-400 ml-2">· koordinater från kartan</span>}
        </label>
        <select
          value={preset}
          onChange={handlePreset}
          className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600"
        >
          <option value="">Välj förinställd etikett…</option>
          {PRESETS.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Etikett</label>
          <input
            value={label} onChange={e => setLabel(e.target.value)}
            placeholder="t.ex. Centrum"
            required
            className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600"
          />
        </div>
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Fil</label>
          <input
            type="file" accept="image/*" required
            onChange={e => setFile(e.target.files[0])}
            className="w-full text-slate-300 text-xs file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-slate-600 file:text-slate-200"
          />
        </div>
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Latitud</label>
          <input
            value={lat} onChange={e => setLat(e.target.value)}
            placeholder="57.706" required
            className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 font-mono"
          />
        </div>
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Longitud</label>
          <input
            value={lon} onChange={e => setLon(e.target.value)}
            placeholder="11.967" required
            className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 font-mono"
          />
        </div>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="flex gap-3 pt-1">
        <button
          type="submit" disabled={uploading}
          className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-sm font-medium py-2 rounded-lg transition-colors"
        >
          {progress ?? 'Ladda upp'}
        </button>
        {onClose && (
          <button type="button" onClick={onClose}
            className="px-4 text-slate-400 hover:text-slate-200 text-sm transition-colors"
          >
            Avbryt
          </button>
        )}
      </div>
    </form>
  )
}

// ── Location row (compact table row + expandable detail) ─────────────────────

function SlotDots({ slots }) {
  return (
    <div className="flex gap-1">
      {SLOTS.map(s => (
        <span key={s.key} title={s.label} className="text-base leading-none">
          {slots[s.key] ? s.icon : <span className="text-slate-700">·</span>}
        </span>
      ))}
    </div>
  )
}

function LocationRow({ location, neighborhood, onUpload, onDelete, onUpdate }) {
  const [open, setOpen]                   = useState(false)
  const [uploadingSlot, setUploadingSlot] = useState(null)
  const [editing, setEditing]             = useState(false)
  const [editVal, setEditVal]             = useState(location.label)
  const [saving, setSaving]               = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const filled = Object.keys(location.slots).length

  const deleteLocation = async () => {
    const images = Object.values(location.slots)
    await Promise.all(images.map(img => onDelete(img.id)))
    setConfirmDelete(false)
  }

  const saveLabel = async () => {
    if (!editVal.trim() || editVal === location.label) { setEditing(false); return }
    setSaving(true)
    // Update every image in this location group
    const images = Object.values(location.slots)
    await Promise.all(images.map(img =>
      onUpdate(img.id, { label: editVal.trim(), lat: location.lat, lon: location.lon, time_slot: img.time_slot })
    ))
    setSaving(false)
    setEditing(false)
  }

  return (
    <div className="border-b border-slate-700/50 last:border-0">
      {/* Compact row */}
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-slate-700/20 transition-colors">
        {/* Slot count */}
        <span className={`text-xs font-mono w-8 shrink-0 ${filled === 4 ? 'text-blue-400' : filled > 0 ? 'text-yellow-400' : 'text-slate-600'}`}>
          {filled}/4
        </span>

        {/* Neighborhood */}
        <span className="w-28 shrink-0 text-slate-400 text-xs truncate">
          {neighborhood ?? <span className="text-slate-700">…</span>}
        </span>

        {/* Label — editable */}
        {editing ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <input
              autoFocus
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveLabel(); if (e.key === 'Escape') setEditing(false) }}
              className="flex-1 bg-slate-600 text-white text-sm rounded px-2 py-1 border border-slate-500 outline-none focus:border-blue-500 min-w-0"
            />
            <button onClick={saveLabel} disabled={saving}
              className="text-xs text-green-400 hover:text-green-300 shrink-0">
              {saving ? '…' : '✓'}
            </button>
            <button onClick={() => setEditing(false)}
              className="text-xs text-slate-500 hover:text-slate-300 shrink-0">✕</button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-white text-sm font-medium truncate">{location.label}</span>
            <button onClick={e => { e.stopPropagation(); setEditing(true); setEditVal(location.label) }}
              className="text-slate-600 hover:text-slate-400 text-xs shrink-0" title="Redigera etikett">✎</button>
          </div>
        )}

        {/* Slot icons */}
        <SlotDots slots={location.slots} />

        {/* Delete — inline confirm */}
        {confirmDelete ? (
          <div className="flex items-center gap-1.5 shrink-0 ml-1">
            <span className="text-xs text-red-400">Radera {filled} bild{filled !== 1 ? 'er' : ''}?</span>
            <button onClick={deleteLocation} className="text-xs text-red-400 hover:text-red-300 font-medium">Ja</button>
            <button onClick={() => setConfirmDelete(false)} className="text-xs text-slate-500 hover:text-slate-300">Nej</button>
          </div>
        ) : (
          <button
            onClick={e => { e.stopPropagation(); setConfirmDelete(true) }}
            className="text-slate-700 hover:text-red-400 text-sm ml-1 shrink-0 transition-colors"
            title="Ta bort plats"
          >🗑</button>
        )}

        {/* Expand toggle */}
        <button
          onClick={() => { setOpen(o => !o); setUploadingSlot(null) }}
          className={`text-slate-500 text-xs ml-1 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >▼</button>
      </div>

      {/* Expanded detail */}
      {open && (
        <div className="bg-slate-700/20 border-t border-slate-700/50">
          {/* 4 slot thumbnails */}
          <div className="grid grid-cols-4 divide-x divide-slate-700/50">
            {SLOTS.map(slot => {
              const img = location.slots[slot.key]
              return (
                <div key={slot.key} className="flex flex-col">
                  <div className="px-2 py-1.5 bg-slate-700/30 text-center">
                    <span className="text-base">{slot.icon}</span>
                    <div className="text-slate-400 text-[10px]">{slot.label}</div>
                  </div>
                  {img ? (
                    <div className="relative group">
                      <img src={img.url} alt={`${location.label} ${slot.label}`}
                        className="w-full aspect-video object-cover" />
                      <button
                        onClick={() => onDelete(img.id)}
                        className="absolute top-1 right-1 w-5 h-5 bg-red-600/80 hover:bg-red-500 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      >✕</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setUploadingSlot(slot.key)}
                      className="flex-1 min-h-12 flex flex-col items-center justify-center gap-1 text-slate-600 hover:text-slate-400 hover:bg-slate-700/30 transition-colors"
                    >
                      <span>+</span>
                      <span className="text-[10px]">Ladda upp</span>
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Upload form for a specific slot */}
          {uploadingSlot && (
            <div className="p-4 border-t border-slate-700/50">
              <p className="text-slate-300 text-sm mb-3">
                Ladda upp bild för <strong>{SLOTS.find(s => s.key === uploadingSlot)?.label}</strong>
              </p>
              <UploadForm
                defaultLabel={location.label}
                defaultLat={String(location.lat)}
                defaultLon={String(location.lon)}
                defaultSlot={uploadingSlot}
                onUpload={onUpload}
                onClose={() => setUploadingSlot(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Motif section ─────────────────────────────────────────────────────────────

function MotifUploadForm({ onUpload, onClose, defaultLabel = '', defaultLat = '', defaultLon = '' }) {
  const [file, setFile]         = useState(null)
  const [label, setLabel]       = useState(defaultLabel)
  const [lat, setLat]           = useState(defaultLat)
  const [lon, setLon]           = useState(defaultLon)

  useEffect(() => { if (defaultLat) setLat(defaultLat) }, [defaultLat])
  useEffect(() => { if (defaultLon) setLon(defaultLon) }, [defaultLon])
  const [preset, setPreset]     = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError]       = useState(null)
  const [progress, setProgress] = useState(null)

  const handlePreset = e => {
    const name = e.target.value
    setPreset(name)
    const p = PRESETS.find(p => p.label === name)
    if (p) {
      if (!lat) setLat(String(p.lat))
      if (!lon) setLon(String(p.lon))
      if (!label) setLabel(name)
    }
  }

  const handleSubmit = async e => {
    e.preventDefault()
    if (!file || !label || !lat || !lon) return
    setUploading(true)
    setError(null)
    setProgress('Komprimerar…')
    try {
      const resized = await resizeToWebP(file)
      setProgress('Laddar upp…')
      const fd = new FormData()
      fd.append('file', resized)
      fd.append('label', label)
      fd.append('lat', lat)
      fd.append('lon', lon)
      fd.append('time_slot', 'day')
      fd.append('image_type', 'motif')
      await onUpload(fd)
      onClose?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="text-slate-400 text-xs mb-1 block">Snabbval etikett</label>
        <select
          value={preset}
          onChange={handlePreset}
          className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600"
        >
          <option value="">Välj förinställd etikett…</option>
          {PRESETS.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Etikett</label>
          <input
            value={label} onChange={e => setLabel(e.target.value)}
            placeholder="t.ex. Centrum"
            required
            className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600"
          />
        </div>
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Fil (PNG rekommenderas)</label>
          <input
            type="file" accept="image/*" required
            onChange={e => setFile(e.target.files[0])}
            className="w-full text-slate-300 text-xs file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-slate-600 file:text-slate-200"
          />
        </div>
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Latitud</label>
          <input
            value={lat} onChange={e => setLat(e.target.value)}
            placeholder="57.706" required
            className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 font-mono"
          />
        </div>
        <div>
          <label className="text-slate-400 text-xs mb-1 block">Longitud</label>
          <input
            value={lon} onChange={e => setLon(e.target.value)}
            placeholder="11.967" required
            className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 font-mono"
          />
        </div>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="flex gap-3 pt-1">
        <button
          type="submit" disabled={uploading}
          className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-sm font-medium py-2 rounded-lg transition-colors"
        >
          {progress ?? 'Ladda upp motiv'}
        </button>
        {onClose && (
          <button type="button" onClick={onClose}
            className="px-4 text-slate-400 hover:text-slate-200 text-sm transition-colors"
          >
            Avbryt
          </button>
        )}
      </div>
    </form>
  )
}

function MotifSection({ data, onUpload, onDelete }) {
  const [showUpload, setShowUpload] = useState(false)
  const motifs = (data ?? []).filter(img => img.image_type === 'motif')

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Motiv</h2>
          <p className="text-slate-500 text-xs mt-0.5">
            Transparenta PNG-motiv (byggnader/landmärken) — ett per plats, visas i Nu-vyn
          </p>
        </div>
        <button
          onClick={() => setShowUpload(o => !o)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {showUpload ? 'Avbryt' : '+ Nytt motiv'}
        </button>
      </div>

      {showUpload && (
        <div className="bg-slate-800 rounded-xl p-5">
          <p className="text-white font-medium mb-4">Ladda upp motiv</p>
          <MotifUploadForm
            onUpload={onUpload}
            onClose={() => setShowUpload(false)}
          />
        </div>
      )}

      {motifs.length === 0 && !showUpload ? (
        <div className="bg-slate-800 rounded-xl p-6 text-center text-slate-500 text-sm">
          Inga motiv uppladdade ännu. Klicka "+ Nytt motiv" för att börja.
        </div>
      ) : motifs.length > 0 && (
        <div className="bg-slate-800 rounded-xl overflow-hidden">
          {motifs.map(img => (
            <MotifRow key={img.id} img={img} onDelete={onDelete} onUpload={onUpload} />
          ))}
        </div>
      )}
    </div>
  )
}

function MotifRow({ img, onDelete, onUpload }) {
  const [open, setOpen]         = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError]       = useState(null)
  const fileRef                 = useRef(null)

  async function handleReplace(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    setProgress('Komprimerar…')
    try {
      const resized = await resizeToWebP(file)
      setProgress('Laddar upp…')
      const fd = new FormData()
      fd.append('file', resized)
      fd.append('label', img.label)
      fd.append('lat', String(img.lat))
      fd.append('lon', String(img.lon))
      fd.append('time_slot', 'day')
      fd.append('image_type', 'motif')
      await onUpload(fd)
      setOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
      setProgress(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="border-b border-slate-700/50 last:border-0">
      {/* Compact row */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-700/20 transition-colors text-left"
      >
        <span className="w-28 shrink-0 text-slate-400 text-xs truncate">
          {nearestPreset(img.lat, img.lon) ?? '—'}
        </span>
        <span className="flex-1 text-white text-sm font-medium truncate">{img.label}</span>
        <span className="text-slate-600 text-xs font-mono hidden sm:block">
          {img.lat.toFixed(3)}, {img.lon.toFixed(3)}
        </span>
        <span className={`text-slate-500 text-xs ml-2 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {/* Expanded — preview / replace / delete */}
      {open && (
        <div className="px-4 pb-4 border-t border-slate-700/40 bg-slate-700/10 space-y-3">
          {/* Preview + metadata */}
          <div className="flex gap-3 pt-3">
            <img src={img.url} alt={img.label}
              className="w-20 h-14 object-contain rounded bg-slate-700/40 shrink-0" />
            <div className="text-xs text-slate-400 space-y-0.5">
              <div><span className="text-slate-500">Etikett:</span> {img.label}</div>
              <div><span className="text-slate-500">Plats:</span> {img.lat.toFixed(5)}, {img.lon.toFixed(5)}</div>
            </div>
          </div>

          {/* Replace — single file button */}
          <div className="flex items-center gap-3">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleReplace} />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="bg-slate-600 hover:bg-slate-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              {progress ?? 'Ersätt motivbild…'}
            </button>
            {error && <span className="text-red-400 text-xs">{error}</span>}
          </div>

          {/* Delete */}
          <div className="pt-1 border-t border-slate-700/40">
            {confirmDelete ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-red-400">Radera motivet?</span>
                <button onClick={() => onDelete(img.id)} className="text-red-400 hover:text-red-300 font-medium">Ja</button>
                <button onClick={() => setConfirmDelete(false)} className="text-slate-500 hover:text-slate-300">Nej</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-slate-600 hover:text-red-400 transition-colors"
              >🗑 Ta bort motiv</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ImageLibrary({ data, onUpload, onUpdate, onDelete }) {
  const [pendingPos, setPendingPos]             = useState(null)
  const [showMotifForm, setShowMotifForm]       = useState(false)
  const [selectedMotif, setSelectedMotif]       = useState(null)

  // Motif images only — these drive the map
  const motifData   = (data ?? []).filter(img => img.image_type === 'motif')
  // Group motifs by label for the map pins
  const motifGroups = motifData.reduce((acc, img) => {
    if (!acc[img.label]) acc[img.label] = { label: img.label, lat: img.lat, lon: img.lon, slots: {} }
    acc[img.label].slots['day'] = img   // motifs have one image, use 'day' slot key for map compat
    return acc
  }, {})
  const mapLocations = Object.values(motifGroups)

  const handleMapClick = (lat, lon) => {
    setPendingPos({ lat, lon })
    setSelectedMotif(null)
    setShowMotifForm(true)
  }

  const handlePinClick = (loc) => {
    setSelectedMotif(loc)
    setPendingPos({ lat: loc.lat, lon: loc.lon })
    setShowMotifForm(true)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Motivbilder</h2>
          <p className="text-slate-500 text-xs mt-0.5">
            En motivbild per plats · Klicka på kartan för att lägga till
          </p>
        </div>
        <button
          onClick={() => { setShowMotifForm(o => !o); setPendingPos(null); setSelectedMotif(null) }}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {showMotifForm ? 'Avbryt' : '+ Nytt motiv'}
        </button>
      </div>

      {/* Map — shows motif pins */}
      <div className="relative">
        <Suspense fallback={<div className="h-[360px] bg-slate-800 rounded-xl flex items-center justify-center text-slate-500 text-sm">Laddar karta…</div>}>
          <ImageMap
            locations={mapLocations}
            pendingPos={pendingPos}
            onMapClick={handleMapClick}
            onPinClick={handlePinClick}
          />
        </Suspense>
      </div>

      {/* Motif upload form — opened by map click or button */}
      {showMotifForm && (
        <div className="bg-slate-800 rounded-xl p-5">
          <p className="text-white font-medium mb-4">
            {selectedMotif ? `Ersätt motiv för ${selectedMotif.label}` : 'Lägg till nytt motiv'}
          </p>
          <MotifUploadForm
            defaultLabel={selectedMotif?.label ?? ''}
            defaultLat={pendingPos ? String(pendingPos.lat.toFixed(6)) : ''}
            defaultLon={pendingPos ? String(pendingPos.lon.toFixed(6)) : ''}
            onUpload={onUpload}
            onClose={() => { setShowMotifForm(false); setPendingPos(null); setSelectedMotif(null) }}
          />
        </div>
      )}

      {/* Motif list */}
      {motifData.length === 0 && !showMotifForm ? (
        <div className="bg-slate-800 rounded-xl p-8 text-center text-slate-500 text-sm">
          Inga motivbilder uppladdade ännu. Klicka på kartan eller "+ Nytt motiv".
        </div>
      ) : motifData.length > 0 && (
        <div className="bg-slate-800 rounded-xl overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-700 text-xs text-slate-500">
            <span className="w-28 shrink-0">Stadsdel</span>
            <span className="flex-1">Etikett</span>
            <span className="w-20 text-right">Koordinater</span>
            <span className="w-8" />
          </div>
          {motifData.map(img => (
            <MotifRow key={img.id} img={img} onDelete={onDelete} onUpload={onUpload} />
          ))}
        </div>
      )}
    </div>
  )
}
