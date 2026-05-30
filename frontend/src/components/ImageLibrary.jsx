import { useState } from 'react'

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

function UploadForm({ onUpload }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null)
  const [label, setLabel] = useState('')
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [preset, setPreset] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)

  const handlePreset = (e) => {
    const name = e.target.value
    setPreset(name)
    const p = PRESETS.find(p => p.label === name)
    if (p) {
      setLat(String(p.lat))
      setLon(String(p.lon))
      if (!label) setLabel(name)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!file || !label || !lat || !lon) return
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('label', label)
      fd.append('lat', lat)
      fd.append('lon', lon)
      await onUpload(fd)
      setFile(null)
      setLabel('')
      setLat('')
      setLon('')
      setPreset('')
      setOpen(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="mb-6">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Ladda upp bild
        </button>
      ) : (
        <form onSubmit={handleSubmit} className="bg-slate-800 rounded-xl p-5 space-y-4">
          <h3 className="text-white font-medium text-sm">Ladda upp ny bild</h3>

          {error && (
            <p className="text-red-300 text-xs bg-red-900/40 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Plats (snabbval)</label>
            <select
              value={preset}
              onChange={handlePreset}
              className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600"
            >
              <option value="">— Välj plats —</option>
              {PRESETS.map(p => (
                <option key={p.label} value={p.label}>{p.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Fil</label>
            <input
              type="file"
              accept="image/*"
              required
              onChange={e => setFile(e.target.files[0] ?? null)}
              className="w-full text-sm text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-slate-600 file:text-white hover:file:bg-slate-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-slate-400 text-xs">Etikett</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              required
              placeholder="T.ex. Haga sommaren"
              className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 placeholder-slate-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-slate-400 text-xs">Latitud</label>
              <input
                type="number"
                step="any"
                value={lat}
                onChange={e => setLat(e.target.value)}
                required
                placeholder="57.706"
                className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 placeholder-slate-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-400 text-xs">Longitud</label>
              <input
                type="number"
                step="any"
                value={lon}
                onChange={e => setLon(e.target.value)}
                required
                placeholder="11.967"
                className="w-full bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 placeholder-slate-500"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={uploading}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {uploading ? 'Laddar upp…' : 'Ladda upp'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm px-4 py-2 rounded-lg transition-colors"
            >
              Avbryt
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function ImageCard({ image, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(image.label)
  const [lat, setLat] = useState(String(image.lat))
  const [lon, setLon] = useState(String(image.lon))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onUpdate(image.id, { label, lat: parseFloat(lat), lon: parseFloat(lon) })
      setEditing(false)
    } catch {
      // keep editing open on error
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Ta bort "${image.label}"?`)) return
    setDeleting(true)
    try {
      await onDelete(image.id)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden flex flex-col">
      <div className="relative aspect-video bg-slate-700">
        <img
          src={image.url}
          alt={image.label}
          className="w-full h-full object-cover"
        />
      </div>

      {editing ? (
        <div className="p-3 space-y-2 flex-1">
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="w-full bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <input
              type="number"
              step="any"
              value={lat}
              onChange={e => setLat(e.target.value)}
              placeholder="lat"
              className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 placeholder-slate-500"
            />
            <input
              type="number"
              step="any"
              value={lon}
              onChange={e => setLon(e.target.value)}
              placeholder="lon"
              className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 placeholder-slate-500"
            />
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-xs font-medium py-1.5 rounded transition-colors"
            >
              {saving ? '…' : 'Spara'}
            </button>
            <button
              onClick={() => {
                setLabel(image.label)
                setLat(String(image.lat))
                setLon(String(image.lon))
                setEditing(false)
              }}
              className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs py-1.5 rounded transition-colors"
            >
              Avbryt
            </button>
          </div>
        </div>
      ) : (
        <div className="p-3 flex-1 flex flex-col gap-1">
          <div className="flex items-start justify-between gap-1">
            <span className="text-white text-xs font-medium leading-tight flex-1">{image.label}</span>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => setEditing(true)}
                title="Redigera"
                className="text-slate-500 hover:text-slate-300 transition-colors text-sm px-1"
              >
                ✏
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                title="Ta bort"
                className="text-slate-500 hover:text-red-400 disabled:opacity-40 transition-colors text-sm px-1"
              >
                ×
              </button>
            </div>
          </div>
          <span className="text-slate-500 text-xs font-mono">
            {image.lat.toFixed(4)}, {image.lon.toFixed(4)}
          </span>
        </div>
      )}
    </div>
  )
}

export default function ImageLibrary({ data, onUpload, onUpdate, onDelete }) {
  const images = data ?? []

  return (
    <div className="bg-slate-800 rounded-xl p-5">
      <h2 className="text-white font-medium text-sm mb-4">Stadsbild-bibliotek</h2>

      <UploadForm onUpload={onUpload} />

      {images.length === 0 ? (
        <p className="text-slate-500 text-sm text-center py-4">Inga bilder uppladdade ännu.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {images.map(img => (
            <ImageCard
              key={img.id}
              image={img}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}
