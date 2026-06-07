import { useState, useEffect } from 'react'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix default marker icon paths broken by Vite bundling
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const ORIENTATIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'UNKNOWN']

// Compass rose — 8-direction picker
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const DIR_ANGLES = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 }

function CompassPicker({ value, onChange }) {
  const r = 60   // outer radius
  const btnR = 14 // button circle radius

  return (
    <svg width={r * 2 + btnR * 2 + 4} height={r * 2 + btnR * 2 + 4} className="select-none">
      <g transform={`translate(${r + btnR + 2},${r + btnR + 2})`}>
        {/* Background circle */}
        <circle cx={0} cy={0} r={r} fill="none" stroke="#334155" strokeWidth={1} />
        {/* Cardinal lines */}
        {[0, 45, 90, 135].map(a => {
          const ra = (a * Math.PI) / 180
          return <line key={a} x1={Math.sin(ra)*8} y1={-Math.cos(ra)*8} x2={Math.sin(ra)*r} y2={-Math.cos(ra)*r} stroke="#1e293b" strokeWidth={1} />
        })}
        {/* Direction buttons */}
        {DIRS.map(dir => {
          const deg = DIR_ANGLES[dir]
          const rad = (deg * Math.PI) / 180
          const x = Math.sin(rad) * r
          const y = -Math.cos(rad) * r
          const active = value === dir
          return (
            <g key={dir} onClick={() => onChange(dir)} style={{ cursor: 'pointer' }}>
              <circle cx={x} cy={y} r={btnR} fill={active ? '#3b82f6' : '#1e293b'} stroke={active ? '#60a5fa' : '#475569'} strokeWidth={1.5} />
              <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
                fill={active ? '#fff' : '#94a3b8'} fontSize={dir.length > 1 ? 8 : 10} fontWeight={active ? 700 : 400}
                style={{ pointerEvents: 'none' }}>
                {dir}
              </text>
            </g>
          )
        })}
        {/* Center dot */}
        <circle cx={0} cy={0} r={4} fill={value === 'UNKNOWN' ? '#ef4444' : '#3b82f6'} />
        {/* Arrow pointing toward selected direction */}
        {value && value !== 'UNKNOWN' && (() => {
          const deg = DIR_ANGLES[value]
          const rad = (deg * Math.PI) / 180
          const tipX = Math.sin(rad) * (r - btnR - 4)
          const tipY = -Math.cos(rad) * (r - btnR - 4)
          return <line x1={0} y1={0} x2={tipX} y2={tipY} stroke="#60a5fa" strokeWidth={2} strokeLinecap="round" />
        })()}
      </g>
    </svg>
  )
}

// Helper: re-center map when terrace changes
function MapRecenter({ lat, lon }) {
  const map = useMap()
  useEffect(() => { map.setView([lat, lon], 18) }, [lat, lon])
  return null
}

const AMENITY_TYPES = ['restaurant', 'cafe', 'bar', 'pub']

function EditPanel({ terrace, onSave, onCancel }) {
  const [orientation, setOrientation] = useState(terrace.street_orientation || 'UNKNOWN')
  const [confidence, setConfidence] = useState(terrace.orientation_confidence ?? 0.3)
  const [amenityType, setAmenityType] = useState(terrace.amenity_type || 'restaurant')
  const [active, setActive] = useState(terrace.active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Auto-bump confidence when a real direction is chosen
  function handleOrientationChange(o) {
    setOrientation(o)
    if (o !== 'UNKNOWN') setConfidence(0.9)
    else setConfidence(0.3)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await fetch(`/api/sun-terraces/${terrace.id}/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orientation,
          orientation_confidence: parseFloat(confidence),
          amenity_type: amenityType,
          active,
        }),
      }).then(r => { if (!r.ok) throw new Error(r.statusText) })
      onSave()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr>
      <td colSpan={8} className="px-4 py-4 bg-slate-800/60 border-t border-b border-slate-600">
        <div className="flex gap-6 flex-wrap items-start">

          {/* Map */}
          <div className="rounded-xl overflow-hidden border border-slate-600 flex-shrink-0" style={{ width: 280, height: 220 }}>
            <MapContainer
              center={[terrace.lat, terrace.lon]}
              zoom={18}
              style={{ width: '100%', height: '100%' }}
              zoomControl={true}
              attributionControl={false}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Marker position={[terrace.lat, terrace.lon]} />
              <MapRecenter lat={terrace.lat} lon={terrace.lon} />
            </MapContainer>
          </div>

          {/* Compass + controls */}
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-slate-400 text-xs mb-2">Välj orientering (vilket väderstreck terrassen vetter mot)</p>
              <CompassPicker value={orientation} onChange={handleOrientationChange} />
            </div>

            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">Valt: <span className="text-white font-mono">{orientation}</span></label>
                <label className="text-slate-400 text-xs">Säkerhet</label>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={confidence}
                  onChange={e => setConfidence(e.target.value)}
                  className="w-28 accent-blue-500"
                />
                <span className="text-slate-400 text-xs">{(confidence * 100).toFixed(0)}%</span>
              </div>
            </div>

            <div className="flex gap-4 flex-wrap">
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">Typ</label>
                <select
                  value={amenityType}
                  onChange={e => setAmenityType(e.target.value)}
                  className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600"
                >
                  {AMENITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">Status</label>
                <select
                  value={active ? 'active' : 'inactive'}
                  onChange={e => setActive(e.target.value === 'active')}
                  className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600"
                >
                  <option value="active">Aktiv</option>
                  <option value="inactive">Inaktiv</option>
                </select>
              </div>
            </div>

            <div className="flex gap-2 items-center">
              <button
                onClick={handleSave}
                disabled={saving}
                className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
              >
                {saving ? 'Sparar…' : 'Spara'}
              </button>
              <button
                onClick={onCancel}
                className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-4 py-2 rounded-lg transition-colors"
              >
                Avbryt
              </button>
              {error && <span className="text-red-400 text-xs">{error}</span>}
            </div>
          </div>
        </div>
      </td>
    </tr>
  )
}

export default function SunTerraceAdmin({ data, onOverride, onReload }) {
  const [editingId, setEditingId] = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [activeFilter, setActiveFilter] = useState('active')
  const [oriFilter, setOriFilter] = useState('all')

  if (!data) {
    return <div className="text-slate-400 text-sm text-center py-8">Hämtar uteserveringar…</div>
  }

  const active = data.filter(t => t.active)
  const inactive = data.filter(t => !t.active)

  let filtered = data
  if (typeFilter !== 'all') filtered = filtered.filter(t => t.amenity_type === typeFilter)
  if (activeFilter === 'active') filtered = filtered.filter(t => t.active)
  if (activeFilter === 'inactive') filtered = filtered.filter(t => !t.active)
  if (oriFilter === 'unknown') filtered = filtered.filter(t => !t.street_orientation || t.street_orientation === 'UNKNOWN')
  if (oriFilter === 'set') filtered = filtered.filter(t => t.street_orientation && t.street_orientation !== 'UNKNOWN')

  function handleSaved() {
    setEditingId(null)
    onReload?.()
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="bg-slate-700 rounded-lg px-4 py-2 text-center">
          <div className="text-white font-semibold text-lg">{active.length}</div>
          <div className="text-slate-400 text-xs">Aktiva</div>
        </div>
        <div className="bg-slate-700 rounded-lg px-4 py-2 text-center">
          <div className="text-white font-semibold text-lg">{inactive.length}</div>
          <div className="text-slate-400 text-xs">Inaktiva</div>
        </div>
        <div className="bg-slate-700 rounded-lg px-4 py-2 text-center">
          <div className="text-white font-semibold text-lg">{data.filter(t => t.street_orientation && t.street_orientation !== 'UNKNOWN').length}</div>
          <div className="text-slate-400 text-xs">Med orientering</div>
        </div>
        <button
          onClick={onReload}
          className="ml-auto bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-3 py-2 rounded-lg border border-slate-600 transition-colors"
        >
          Ladda om
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {[['all', 'Alla typer'], ['cafe', 'Café'], ['bar', 'Bar'], ['restaurant', 'Restaurang'], ['pub', 'Pub']].map(([v, l]) => (
          <button key={v} onClick={() => setTypeFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              typeFilter === v ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'
            }`}>{l}</button>
        ))}
        <div className="w-px bg-slate-600 self-stretch" />
        {[['active', 'Aktiva'], ['inactive', 'Inaktiva'], ['all_status', 'Alla']].map(([v, l]) => (
          <button key={v} onClick={() => setActiveFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              activeFilter === v ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'
            }`}>{l}</button>
        ))}
        <div className="w-px bg-slate-600 self-stretch" />
        {[['all', 'Alla orienteringar'], ['unknown', 'Saknar orientering'], ['set', 'Har orientering']].map(([v, l]) => (
          <button key={v} onClick={() => setOriFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              oriFilter === v ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'
            }`}>{l}</button>
        ))}
      </div>

      <p className="text-slate-500 text-xs">{filtered.length} uteserveringar</p>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-slate-400 text-xs">
              <th className="text-left px-4 py-3">Namn</th>
              <th className="text-left px-4 py-3">Typ</th>
              <th className="text-left px-4 py-3">Orientering</th>
              <th className="text-left px-4 py-3">Säkerhet</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Senast sedd</th>
              <th className="text-left px-4 py-3">Adress</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <>
                <tr key={t.id} className={`border-t border-slate-700 ${t.active ? '' : 'opacity-50'} hover:bg-slate-700/30 transition-colors`}>
                  <td className="px-4 py-3 text-white font-medium max-w-[200px] truncate">{t.name}</td>
                  <td className="px-4 py-3 text-slate-400">{t.amenity_type}</td>
                  <td className="px-4 py-3">
                    <span className={`font-mono text-xs ${
                      !t.street_orientation || t.street_orientation === 'UNKNOWN' ? 'text-slate-500' : 'text-green-400'
                    }`}>{t.street_orientation || 'UNKNOWN'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs ${
                      t.orientation_confidence > 0.6 ? 'text-green-400'
                      : t.orientation_confidence > 0.4 ? 'text-yellow-400'
                      : 'text-slate-500'
                    }`}>{(t.orientation_confidence * 100).toFixed(0)}%</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      t.active ? 'bg-green-500/20 text-green-400' : 'bg-slate-600 text-slate-400'
                    }`}>{t.active ? 'Aktiv' : 'Inaktiv'}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {t.last_seen_at ? new Date(t.last_seen_at).toLocaleDateString('sv-SE') : '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs max-w-[150px] truncate">{t.address || '—'}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setEditingId(editingId === t.id ? null : t.id)}
                      className={`text-xs transition-colors ${editingId === t.id ? 'text-slate-400 hover:text-slate-300' : 'text-blue-400 hover:text-blue-300'}`}
                    >
                      {editingId === t.id ? 'Stäng' : 'Redigera'}
                    </button>
                  </td>
                </tr>
                {editingId === t.id && (
                  <EditPanel
                    key={`edit-${t.id}`}
                    terrace={t}
                    onSave={handleSaved}
                    onCancel={() => setEditingId(null)}
                  />
                )}
              </>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-slate-500 text-sm text-center py-8">Inga uteserveringar.</div>
        )}
      </div>
    </div>
  )
}
