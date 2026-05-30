import { useState } from 'react'

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

  const handlePreset = e => {
    const name = e.target.value
    setPreset(name)
    const p = PRESETS.find(p => p.label === name)
    if (p) {
      setLat(String(p.lat))
      setLon(String(p.lon))
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

      {/* Preset location */}
      <div>
        <label className="text-slate-400 text-xs mb-1 block">Snabbval plats</label>
        <select
          value={preset}
          onChange={handlePreset}
          className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600"
        >
          <option value="">Välj förinställd plats…</option>
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

// ── Location card (4 slots) ───────────────────────────────────────────────────

function LocationCard({ location, onUpload, onDelete }) {
  const [uploadingSlot, setUploadingSlot] = useState(null)
  const [editLabel, setEditLabel] = useState(null)

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
        <div>
          <span className="text-white font-medium">{location.label}</span>
          <span className="text-slate-500 text-xs ml-2 font-mono">
            {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
          </span>
        </div>
      </div>

      {/* 4 time slots */}
      <div className="grid grid-cols-4 gap-0 divide-x divide-slate-700">
        {SLOTS.map(slot => {
          const img = location.slots[slot.key]
          return (
            <div key={slot.key} className="flex flex-col">
              {/* Slot header */}
              <div className="px-2 py-1.5 bg-slate-700/50 text-center">
                <div className="text-base">{slot.icon}</div>
                <div className="text-slate-400 text-[10px]">{slot.label}</div>
              </div>

              {img ? (
                /* Uploaded image */
                <div className="relative group">
                  <img
                    src={img.url}
                    alt={`${location.label} ${slot.label}`}
                    className="w-full aspect-video object-cover"
                  />
                  <button
                    onClick={() => onDelete(img.id)}
                    className="absolute top-1 right-1 w-5 h-5 bg-red-600/80 hover:bg-red-500 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="Ta bort"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                /* Empty slot — upload button */
                <button
                  onClick={() => setUploadingSlot(slot.key)}
                  className="flex-1 min-h-16 flex flex-col items-center justify-center gap-1 text-slate-600 hover:text-slate-400 hover:bg-slate-700/30 transition-colors"
                >
                  <span className="text-lg">+</span>
                  <span className="text-[10px]">Ladda upp</span>
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Inline upload form for a specific slot */}
      {uploadingSlot && (
        <div className="p-4 border-t border-slate-700 bg-slate-700/20">
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
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ImageLibrary({ data, onUpload, onDelete }) {
  const [showNewLocation, setShowNewLocation] = useState(false)
  const locations = groupByLocation(data)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Bildbibliotek</h2>
          <p className="text-slate-500 text-xs mt-0.5">
            Upp till 4 bilder per plats — en per tidslot
          </p>
        </div>
        <button
          onClick={() => setShowNewLocation(o => !o)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {showNewLocation ? 'Avbryt' : '+ Ny plats'}
        </button>
      </div>

      {/* New location upload form */}
      {showNewLocation && (
        <div className="bg-slate-800 rounded-xl p-5">
          <p className="text-white font-medium mb-4">Lägg till ny plats</p>
          <UploadForm
            onUpload={onUpload}
            onClose={() => setShowNewLocation(false)}
          />
        </div>
      )}

      {/* Location cards */}
      {locations.length === 0 && !showNewLocation && (
        <div className="bg-slate-800 rounded-xl p-8 text-center text-slate-500 text-sm">
          Inga bilder uppladdade ännu. Klicka "+ Ny plats" för att börja.
        </div>
      )}

      {locations.map(loc => (
        <LocationCard
          key={loc.label}
          location={loc}
          onUpload={onUpload}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
