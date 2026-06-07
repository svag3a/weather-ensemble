import { useState, useEffect, useRef } from 'react'
import { overrideTerrace, createTerrace, deriveArcFromPolygon, fixTerraceAddresses, triggerGeocodeTerraces, fetchGeocodeStatus,
         triggerEnrichOsm, fetchEnrichOsmStatus,
         triggerEnrichAi, fetchEnrichAiStatus } from '../api'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const redIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
  iconRetinaUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41],
})

const smallDotIcon = (color = '#3b82f6') => L.divIcon({
  className: '',
  html: `<div style="width:10px;height:10px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div>`,
  iconSize: [10, 10], iconAnchor: [5, 5],
})

// ── Bearing helpers ──────────────────────────────────────────────────────────

function calcBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180
  const lat1r = lat1 * Math.PI / 180, lat2r = lat2 * Math.PI / 180
  const y = Math.sin(dLon) * Math.cos(lat2r)
  const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function bearingToDir(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]
}

// Compute dominant outward-facing direction from a polygon [[lat,lon],...]
function orientationFromPolygon(verts) {
  if (verts.length < 3) return null
  const centLat = verts.reduce((s, v) => s + v[0], 0) / verts.length
  const centLon = verts.reduce((s, v) => s + v[1], 0) / verts.length
  let ex = 0, ey = 0
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length]
    const dlat = b[0] - a[0], dlon = b[1] - a[1]
    const len = Math.sqrt(dlat * dlat + dlon * dlon)
    if (len < 1e-10) continue
    const midLat = (a[0] + b[0]) / 2, midLon = (a[1] + b[1]) / 2
    // Outward normal: pick the one pointing away from centroid
    const n1lat = -dlon / len, n1lon = dlat / len
    const dot = n1lat * (centLat - midLat) + n1lon * (centLon - midLon)
    const outLat = dot < 0 ? n1lat : -n1lat
    const outLon = dot < 0 ? n1lon : -n1lon
    ey += outLon * len   // east (lon) component
    ex += outLat * len   // north (lat) component
  }
  const bearing = (Math.atan2(ey, ex) * 180 / Math.PI + 360) % 360
  return bearingToDir(bearing)
}

// ── Compass rose ─────────────────────────────────────────────────────────────

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const DIR_ANGLES = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 }

function CompassPicker({ value, onChange }) {
  const r = 52, btnR = 13
  return (
    <svg width={r*2+btnR*2+4} height={r*2+btnR*2+4} className="select-none">
      <g transform={`translate(${r+btnR+2},${r+btnR+2})`}>
        <circle cx={0} cy={0} r={r} fill="none" stroke="#334155" strokeWidth={1} />
        {[0,45,90,135].map(a => {
          const ra = a*Math.PI/180
          return <line key={a} x1={Math.sin(ra)*7} y1={-Math.cos(ra)*7} x2={Math.sin(ra)*r} y2={-Math.cos(ra)*r} stroke="#1e293b" strokeWidth={1}/>
        })}
        {DIRS.map(dir => {
          const rad = DIR_ANGLES[dir]*Math.PI/180
          const x = Math.sin(rad)*r, y = -Math.cos(rad)*r
          const active = value === dir
          return (
            <g key={dir} onClick={() => onChange(dir)} style={{cursor:'pointer'}}>
              <circle cx={x} cy={y} r={btnR} fill={active?'#3b82f6':'#1e293b'} stroke={active?'#60a5fa':'#475569'} strokeWidth={1.5}/>
              <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
                fill={active?'#fff':'#94a3b8'} fontSize={dir.length>1?7:9} fontWeight={active?700:400}
                style={{pointerEvents:'none'}}>{dir}</text>
            </g>
          )
        })}
        <circle cx={0} cy={0} r={4} fill={value==='UNKNOWN'?'#ef4444':'#3b82f6'}/>
        {value && value !== 'UNKNOWN' && (() => {
          const rad = DIR_ANGLES[value]*Math.PI/180
          return <line x1={0} y1={0} x2={Math.sin(rad)*(r-btnR-4)} y2={-Math.cos(rad)*(r-btnR-4)} stroke="#60a5fa" strokeWidth={2} strokeLinecap="round"/>
        })()}
      </g>
    </svg>
  )
}

// ── Arc compass picker ────────────────────────────────────────────────────────
function ArcPicker({ arcFrom, arcTo, onChange, onClear }) {
  const R = 65        // radius
  const PAD = 18      // padding for labels
  const SIZE = (R + PAD) * 2
  const [step, setStep] = useState(arcFrom == null ? 0 : 2)  // 0=click-from, 1=click-to, 2=done

  function svgToBearing(e) {
    const svg = e.currentTarget.ownerSVGElement || e.currentTarget
    const rect = svg.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    const dx = e.clientX - rect.left - cx
    const dy = e.clientY - rect.top - cy
    return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
  }

  function handleClick(e) {
    const b = svgToBearing(e)
    if (step === 0 || step === 2) {
      onChange(Math.round(b), arcTo)
      setStep(1)
    } else {
      onChange(arcFrom, Math.round(b))
      setStep(2)
    }
  }

  function handleClear() {
    onChange(null, null)
    setStep(0)
    onClear?.()
  }

  // SVG arc path: filled sector from arcFrom to arcTo clockwise
  function sectorPath(from, to) {
    const toRad = d => (d - 90) * Math.PI / 180
    const span = (to - from + 360) % 360 || 360
    if (span >= 359) {
      return `M 0 0 m -${R} 0 a ${R} ${R} 0 1 1 ${2*R} 0 a ${R} ${R} 0 1 1 ${-2*R} 0`
    }
    const x1 = R * Math.cos(toRad(from))
    const y1 = R * Math.sin(toRad(from))
    const x2 = R * Math.cos(toRad(to))
    const y2 = R * Math.sin(toRad(to))
    const large = span > 180 ? 1 : 0
    return `M 0 0 L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`
  }

  function dot(bearing, color) {
    const rad = (bearing - 90) * Math.PI / 180
    return { x: R * Math.cos(rad), y: R * Math.sin(rad), color }
  }

  const CARDINAL = [
    { label: 'N',  deg: 0   },
    { label: 'NÖ', deg: 45  },
    { label: 'Ö',  deg: 90  },
    { label: 'SÖ', deg: 135 },
    { label: 'S',  deg: 180 },
    { label: 'SV', deg: 225 },
    { label: 'V',  deg: 270 },
    { label: 'NV', deg: 315 },
  ]

  const hasArc = arcFrom != null && arcTo != null
  const span   = hasArc ? (arcTo - arcFrom + 360) % 360 || 360 : 0

  return (
    <div className="flex flex-col gap-1">
      <p className="text-slate-400 text-xs">
        {step === 0 ? 'Klicka för att sätta startpunkt (grönt)' :
         step === 1 ? 'Klicka för att sätta slutpunkt (rött)' :
         `Båge: ${Math.round(span)}° — klicka igen för att ändra`}
      </p>
      <svg
        width={SIZE} height={SIZE}
        onClick={handleClick}
        style={{ cursor: 'crosshair', userSelect: 'none' }}
      >
        <g transform={`translate(${SIZE/2},${SIZE/2})`}>
          {/* Sector */}
          {hasArc && (
            <path d={sectorPath(arcFrom, arcTo)}
              fill="#f59e0b" fillOpacity={0.25} stroke="#f59e0b" strokeWidth={1.5} strokeOpacity={0.6}/>
          )}
          {/* Ring */}
          <circle r={R} fill="none" stroke="#334155" strokeWidth={1}/>
          {/* Cardinal spokes + labels */}
          {CARDINAL.map(({ label, deg }) => {
            const rad = (deg - 90) * Math.PI / 180
            const x = R * Math.cos(rad), y = R * Math.sin(rad)
            const lx = (R + 12) * Math.cos(rad), ly = (R + 12) * Math.sin(rad)
            return (
              <g key={label}>
                <line x1={x*0.15} y1={y*0.15} x2={x} y2={y} stroke="#1e293b" strokeWidth={0.5}/>
                <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
                  fill="#475569" fontSize={8} style={{ pointerEvents: 'none' }}>{label}</text>
              </g>
            )
          })}
          {/* Handle dots */}
          {hasArc && (() => {
            const f = dot(arcFrom, '#22c55e')
            const t = dot(arcTo,   '#ef4444')
            return <>
              <circle cx={f.x} cy={f.y} r={5} fill={f.color} stroke="white" strokeWidth={1.5}/>
              <circle cx={t.x} cy={t.y} r={5} fill={t.color} stroke="white" strokeWidth={1.5}/>
            </>
          })()}
          {/* Center */}
          <circle r={3} fill="#475569"/>
        </g>
      </svg>
      <div className="flex gap-2 items-center">
        {hasArc && (
          <span className="text-amber-400 text-xs">{Math.round(arcFrom)}° → {Math.round(arcTo)}° ({Math.round(span)}°)</span>
        )}
        {hasArc && (
          <button onClick={handleClear} className="text-slate-500 hover:text-slate-300 text-xs">Rensa</button>
        )}
      </div>
    </div>
  )
}

// ── Map helpers ───────────────────────────────────────────────────────────────

function MapRecenter({ lat, lon }) {
  const map = useMap()
  useEffect(() => { map.setView([lat, lon], 18) }, [lat, lon])
  return null
}

function MapClickHandler({ onClick }) {
  useMapEvents({ click: e => onClick(e.latlng) })
  return null
}

const TILES = {
  sat: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  osm: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
}

// Build a sector polygon [[lat,lon],...] for the Leaflet map
function createSectorPolygon(lat, lon, fromBearing, toBearing, radiusM = 80) {
  const cosLat = Math.cos(lat * Math.PI / 180)
  const span = (toBearing - fromBearing + 360) % 360 || 360
  const steps = Math.max(12, Math.ceil(span / 8))
  const pts = [[lat, lon]]
  for (let i = 0; i <= steps; i++) {
    const b = (fromBearing + span * i / steps) % 360
    const rad = b * Math.PI / 180
    pts.push([
      lat  + (radiusM / 111000) * Math.cos(rad),
      lon  + (radiusM / (111000 * cosLat)) * Math.sin(rad),
    ])
  }
  pts.push([lat, lon])
  return pts
}

const OUTDOOR_TYPES = [
  { value: 'unknown',  label: 'Okänd',     desc: 'Vet ej om det finns uteservering' },
  { value: 'terrace',  label: 'Uteservering', desc: 'Vanlig uteservering' },
  { value: 'rooftop',  label: '🏙 Rooftop',  desc: 'Takbar — alltid solläge när solen är uppe' },
  { value: 'none',     label: '✗ Ingen',    desc: 'Har ingen uteservering (döljs i appen)' },
]

const AMENITY_TYPES = ['restaurant', 'cafe', 'bar', 'pub']

// ── Edit panel ────────────────────────────────────────────────────────────────

function EditPanel({ terrace, onSave, onCancel }) {
  const [name, setName]                 = useState(terrace.name || '')
  const [address, setAddress]           = useState(terrace.address || '')
  const [amenityType, setAmenityType]   = useState(terrace.amenity_type || 'restaurant')
  const [active, setActive]             = useState(terrace.active ?? true)
  const [outdoorType, setOutdoorType]   = useState(terrace.outdoor_type || 'unknown')
  const [tileLayer, setTileLayer]       = useState('sat')
  const [arcClickStep, setArcClickStep] = useState(0)  // 0=first point, 1=second point
  const [arcFrom, setArcFrom]           = useState(terrace.sun_arc_from ?? null)
  const [arcTo,   setArcTo]             = useState(terrace.sun_arc_to   ?? null)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState(null)

  function handleMapClick(latlng) {
    const b = Math.round(calcBearing(terrace.lat, terrace.lon, latlng.lat, latlng.lng))
    if (arcClickStep === 0) {
      setArcFrom(b); setArcTo(null); setArcClickStep(1)
    } else {
      setArcTo(b); setArcClickStep(0)
    }
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await overrideTerrace(terrace.id, {
        name,
        address,
        orientation: 'UNKNOWN',
        orientation_confidence: arcFrom != null && arcTo != null ? 1.0 : 0.3,
        amenity_type: amenityType,
        active,
        outdoor_type: outdoorType,
        polygon_coords: '',
        sun_arc_from: arcFrom,
        sun_arc_to:   arcTo,
      })
      onSave()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr>
      <td colSpan={7} className="px-4 py-4 bg-slate-800/60 border-t border-b border-slate-600">
        <div className="flex gap-6 flex-wrap items-start">

          {/* Map */}
          <div className="flex flex-col gap-1.5 flex-shrink-0">
            {/* Tile toggle + arc mode indicator */}
            <div className="flex items-center gap-2 flex-wrap">
              {[['sat','Satellit'],['osm','Karta']].map(([k,l]) => (
                <button key={k} onClick={() => setTileLayer(k)}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${tileLayer===k ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-400'}`}>{l}</button>
              ))}
              <div className="w-px bg-slate-600 self-stretch mx-0.5"/>
              <span className="text-xs px-2 py-0.5 rounded border bg-amber-700 border-amber-500 text-white">
                ☀ Rita solbåge
              </span>
            </div>
            {/* Instruction */}
            <p className="text-slate-500 text-xs">
              {arcClickStep === 0
                ? 'Klick 1: bågstart — var solen börjar nå terrassen'
                : 'Klick 2: bågslut — var solen slutar nå terrassen'}
            </p>
            <div className="rounded-xl overflow-hidden border border-slate-600" style={{width:360, height:280}}>
              <MapContainer center={[terrace.lat, terrace.lon]} zoom={18} maxZoom={21}
                style={{width:'100%',height:'100%'}} zoomControl={true} attributionControl={false}>
                <TileLayer key={tileLayer} url={TILES[tileLayer]} maxZoom={21}/>
                <Marker position={[terrace.lat, terrace.lon]}/>
                {arcFrom != null && arcTo != null && (
                  <Polygon
                    positions={createSectorPolygon(terrace.lat, terrace.lon, arcFrom, arcTo)}
                    pathOptions={{color:'#f59e0b', fillColor:'#f59e0b', fillOpacity:0.2, weight:2}}
                  />
                )}
                <MapRecenter lat={terrace.lat} lon={terrace.lon}/>
                <MapClickHandler onClick={handleMapClick}/>
              </MapContainer>
            </div>
            {/* Arc status */}
            <div className="flex items-center gap-2 flex-wrap min-h-[20px]">
              {arcFrom != null && arcTo != null ? (
                <>
                  <span className="text-amber-400 text-xs font-medium">
                    ☀ {Math.round(arcFrom)}°→{Math.round(arcTo)}°
                    &nbsp;({Math.round((arcTo - arcFrom + 360) % 360 || 360)}° spann)
                  </span>
                  <button onClick={() => { setArcFrom(null); setArcTo(null); setArcClickStep(0) }}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors">Rensa</button>
                </>
              ) : arcFrom != null ? (
                <span className="text-slate-400 text-xs">Start: {Math.round(arcFrom)}° — klicka för slutpunkt</span>
              ) : (
                <span className="text-slate-600 text-xs">Ingen solbåge satt</span>
              )}
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-4">

            {/* Outdoor type */}
            <div className="flex flex-col gap-1">
              <label className="text-slate-400 text-xs">Uteserveringstyp</label>
              <div className="flex flex-col gap-1">
                {OUTDOOR_TYPES.map(ot => (
                  <label key={ot.value} className="flex items-center gap-2 cursor-pointer group">
                    <input type="radio" name="outdoor_type" value={ot.value}
                      checked={outdoorType === ot.value}
                      onChange={() => setOutdoorType(ot.value)}
                      className="accent-blue-500"/>
                    <span className={`text-xs ${outdoorType===ot.value?'text-white':'text-slate-400'}`}>{ot.label}</span>
                    <span className="text-slate-600 text-xs">{ot.desc}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Name + address */}
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">Namn</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 w-52 focus:outline-none focus:border-blue-500"/>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">Adress</label>
                <input value={address} onChange={e => setAddress(e.target.value)}
                  placeholder="(tom = rensa)"
                  className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600 w-52 focus:outline-none focus:border-blue-500 placeholder-slate-600"/>
              </div>
            </div>

            {/* Type + status */}
            <div className="flex gap-4 flex-wrap">
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">Typ</label>
                <select value={amenityType} onChange={e => setAmenityType(e.target.value)}
                  className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600">
                  {AMENITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-slate-400 text-xs">Status</label>
                <select value={active?'active':'inactive'} onChange={e => setActive(e.target.value==='active')}
                  className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600">
                  <option value="active">Aktiv</option>
                  <option value="inactive">Inaktiv</option>
                </select>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 items-center">
              <button onClick={handleSave} disabled={saving}
                className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors">
                {saving ? 'Sparar…' : 'Spara'}
              </button>
              <button onClick={onCancel}
                className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-4 py-2 rounded-lg transition-colors">
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

// ── Main admin component ──────────────────────────────────────────────────────

// Generic job-widget: trigger + progress bar
function JobWidget({ label, triggerFn, statusFn, color = 'blue' }) {
  const [status, setStatus] = useState(null)
  const [triggering, setTriggering] = useState(false)
  const pollRef = useRef(null)

  async function start() {
    setTriggering(true)
    try {
      const s = await triggerFn()
      setStatus(s)
      if (s.running || s.status === 'started') startPolling()
    } catch (e) {
      setStatus({ error: e.message })
    } finally {
      setTriggering(false)
    }
  }

  function startPolling() {
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const s = await statusFn()
        setStatus(s)
        if (!s.running) clearInterval(pollRef.current)
      } catch { clearInterval(pollRef.current) }
    }, 2000)
  }

  useEffect(() => () => clearInterval(pollRef.current), [])

  const pct = status?.total > 0 ? Math.round((status.done / status.total) * 100) : 0
  const btnClass = color === 'emerald'
    ? 'bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-600'
    : 'bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600'
  const barClass = color === 'emerald' ? 'bg-emerald-500' : 'bg-blue-500'

  return (
    <div className="bg-slate-700 rounded-lg px-4 py-2 flex flex-col gap-1 min-w-[200px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400 text-xs">{label}</span>
        <button onClick={start} disabled={triggering || status?.running}
          className={`text-xs ${btnClass} text-white px-2 py-0.5 rounded transition-colors`}>
          {status?.running ? 'Kör…' : 'Starta'}
        </button>
      </div>
      {status?.running && (
        <>
          <div className="w-full bg-slate-600 rounded-full h-1.5">
            <div className={`${barClass} h-1.5 rounded-full transition-all`} style={{width:`${pct}%`}}/>
          </div>
          <span className="text-slate-400 text-[10px]">{status.done}/{status.total} · {status.updated} uppdaterade</span>
        </>
      )}
      {!status?.running && status?.finished_at && (
        <span className="text-green-400 text-[10px]">✓ {status.updated} uppdaterade</span>
      )}
      {status?.error && <span className="text-red-400 text-[10px]">{status.error}</span>}
    </div>
  )
}

// ── Add terrace panel ─────────────────────────────────────────────────────────

function AddTerracePanel({ onSaved, onCancel }) {
  const [name, setName]           = useState('')
  const [amenityType, setAmenityType] = useState('restaurant')
  const [address, setAddress]     = useState('')
  const [outdoorType, setOutdoorType] = useState('terrace')
  const [location, setLocation]   = useState(null)   // {lat, lng}
  const [tileLayer, setTileLayer] = useState('sat')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)

  // Start centred on Göteborg
  const center = location ? [location.lat, location.lng] : [57.7089, 11.9746]

  async function handleSave() {
    if (!name.trim()) { setError('Namn krävs'); return }
    if (!location)    { setError('Klicka på kartan för att ange position'); return }
    setSaving(true); setError(null)
    try {
      await createTerrace({
        name: name.trim(),
        lat: location.lat,
        lon: location.lng,
        amenity_type: amenityType,
        address: address.trim() || null,
        outdoor_type: outdoorType,
      })
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-slate-800/80 border border-slate-600 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-white text-sm font-semibold">Lägg till ställe</h3>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-300 text-xs">✕ Avbryt</button>
      </div>

      {/* Map */}
      <div className="flex flex-col gap-1">
        <div className="flex gap-1 mb-1">
          {[['sat','Satellit'],['osm','Karta']].map(([k,l]) => (
            <button key={k} onClick={() => setTileLayer(k)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${tileLayer===k ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-400'}`}>{l}</button>
          ))}
          <span className="text-slate-500 text-xs ml-2 self-center">Klicka på kartan för att ange position</span>
        </div>
        <div className="rounded-xl overflow-hidden border border-slate-600" style={{width:'100%', height:240}}>
          <MapContainer center={center} zoom={13} maxZoom={21}
            style={{width:'100%',height:'100%'}} zoomControl={true} attributionControl={false}>
            <TileLayer key={tileLayer} url={TILES[tileLayer]} maxZoom={21}/>
            {location && <Marker position={[location.lat, location.lng]}/>}
            <MapClickHandler onClick={latlng => setLocation(latlng)}/>
          </MapContainer>
        </div>
        {location && (
          <p className="text-slate-500 text-xs">{location.lat.toFixed(5)}, {location.lng.toFixed(5)}</p>
        )}
      </div>

      {/* Fields */}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex flex-col gap-1">
          <label className="text-slate-400 text-xs">Namn *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="t.ex. Kaffeverket"
            className="bg-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 border border-slate-600 focus:outline-none focus:border-blue-500"/>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-slate-400 text-xs">Typ</label>
          <select value={amenityType} onChange={e => setAmenityType(e.target.value)}
            className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600">
            {['restaurant','cafe','bar','pub'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-slate-400 text-xs">Uteserveringstyp</label>
          <select value={outdoorType} onChange={e => setOutdoorType(e.target.value)}
            className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-600">
            {[['terrace','Uteservering'],['rooftop','Rooftop'],['none','Ingen'],['unknown','Okänd']].map(([v,l]) =>
              <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <label className="text-slate-400 text-xs">Adress (valfritt)</label>
          <input value={address} onChange={e => setAddress(e.target.value)} placeholder="t.ex. Avenyn 1"
            className="bg-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 border border-slate-600 focus:outline-none focus:border-blue-500"/>
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <button onClick={handleSave} disabled={saving}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors">
          {saving ? 'Sparar…' : 'Spara ställe'}
        </button>
        {error && <span className="text-red-400 text-xs">{error}</span>}
      </div>
    </div>
  )
}

// ── Fix addresses button ──────────────────────────────────────────────────────

function FixAddressesButton() {
  const [state, setState] = useState(null)
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    try {
      const r = await fixTerraceAddresses()
      setState(r)
    } catch (e) {
      setState({ error: e.message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="bg-slate-700 rounded-lg px-4 py-2 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400 text-xs">Adressordning</span>
        <button onClick={run} disabled={running}
          className="text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white px-2 py-0.5 rounded transition-colors">
          {running ? 'Fixar…' : 'Rätta'}
        </button>
      </div>
      {state?.fixed != null && (
        <span className="text-green-400 text-[10px]">✓ {state.fixed} adresser rättade</span>
      )}
      {state?.error && <span className="text-red-400 text-[10px]">{state.error}</span>}
    </div>
  )
}

// ── Geocode widget ────────────────────────────────────────────────────────────

function GeocodeWidget() {
  const [status, setStatus] = useState(null)
  const [triggering, setTriggering] = useState(false)
  const pollRef = useRef(null)

  async function startGeocode() {
    setTriggering(true)
    try {
      const s = await triggerGeocodeTerraces()
      setStatus(s)
      startPolling()
    } catch (e) {
      setStatus({ error: e.message })
    } finally {
      setTriggering(false)
    }
  }

  function startPolling() {
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchGeocodeStatus()
        setStatus(s)
        if (!s.running) clearInterval(pollRef.current)
      } catch { clearInterval(pollRef.current) }
    }, 2000)
  }

  useEffect(() => () => clearInterval(pollRef.current), [])

  const pct = status?.total > 0 ? Math.round((status.done / status.total) * 100) : 0
  const noAddr = status?.total ?? null

  return (
    <div className="bg-slate-700 rounded-lg px-4 py-2 flex flex-col gap-1 min-w-[220px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-400 text-xs">Saknar adress</span>
        <button
          onClick={startGeocode}
          disabled={triggering || status?.running}
          className="text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white px-2 py-0.5 rounded transition-colors"
        >
          {status?.running ? 'Kör…' : 'Geokoda'}
        </button>
      </div>
      {status?.running && (
        <>
          <div className="w-full bg-slate-600 rounded-full h-1.5">
            <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{width: `${pct}%`}}/>
          </div>
          <span className="text-slate-400 text-[10px]">{status.done}/{status.total} · {status.updated} uppdaterade</span>
        </>
      )}
      {!status?.running && status?.finished_at && (
        <span className="text-green-400 text-[10px]">✓ {status.updated} adresser hittade</span>
      )}
      {status?.error && <span className="text-red-400 text-[10px]">{status.error}</span>}
    </div>
  )
}

export default function SunTerraceAdmin({ data, onOverride, onReload }) {
  const [editingId, setEditingId]     = useState(null)
  const [showAdd, setShowAdd]         = useState(false)
  const [typeFilter, setTypeFilter]   = useState('all')
  const [activeFilter, setActiveFilter] = useState('active')
  const [oriFilter, setOriFilter]     = useState('all')
  const [search, setSearch]           = useState('')

  if (!data) return <div className="text-slate-400 text-sm text-center py-8">Hämtar uteserveringar…</div>

  const activeCount   = data.filter(t => t.active).length
  const inactiveCount = data.filter(t => !t.active).length
  const withOri       = data.filter(t => t.street_orientation && t.street_orientation !== 'UNKNOWN').length

  let filtered = data
  if (typeFilter !== 'all') filtered = filtered.filter(t => t.amenity_type === typeFilter)
  if (activeFilter === 'active')   filtered = filtered.filter(t => t.active)
  if (activeFilter === 'inactive') filtered = filtered.filter(t => !t.active)
  if (oriFilter === 'unknown') filtered = filtered.filter(t => t.sun_arc_from == null && (!t.street_orientation || t.street_orientation === 'UNKNOWN'))
  if (oriFilter === 'set')     filtered = filtered.filter(t => t.sun_arc_from != null || (t.street_orientation && t.street_orientation !== 'UNKNOWN'))
  if (search.trim()) {
    const q = search.trim().toLowerCase()
    filtered = filtered.filter(t =>
      t.name?.toLowerCase().includes(q) || t.address?.toLowerCase().includes(q)
    )
  }

  function handleSaved() { setEditingId(null); onReload?.() }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 flex-wrap">
        {[
          [activeCount, 'Aktiva'],
          [inactiveCount, 'Inaktiva'],
          [withOri, 'Med orientering'],
          [data.filter(t => t.polygon_coords).length, 'Med polygon'],
          [data.filter(t => t.outdoor_type === 'rooftop').length, 'Rooftop'],
        ].map(([n, l]) => (
          <div key={l} className="bg-slate-700 rounded-lg px-4 py-2 text-center">
            <div className="text-white font-semibold text-lg">{n}</div>
            <div className="text-slate-400 text-xs">{l}</div>
          </div>
        ))}
        <FixAddressesButton />
        <JobWidget label="Orientering OSM" triggerFn={triggerEnrichOsm} statusFn={fetchEnrichOsmStatus} color="emerald"/>
        <JobWidget label="AI-berikning" triggerFn={triggerEnrichAi} statusFn={fetchEnrichAiStatus} color="blue"/>
        <GeocodeWidget />
        <button onClick={() => setShowAdd(v => !v)}
          className={`ml-auto text-xs px-3 py-2 rounded-lg border transition-colors ${showAdd ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-200 hover:bg-slate-600'}`}>
          {showAdd ? '✕ Avbryt' : '+ Lägg till ställe'}
        </button>
        <button onClick={onReload}
          className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-3 py-2 rounded-lg border border-slate-600 transition-colors">
          Ladda om
        </button>
      </div>

      {showAdd && (
        <AddTerracePanel
          onSaved={() => { setShowAdd(false); onReload?.() }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Search */}
      <input
        type="search" placeholder="Sök namn eller adress…" value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full max-w-sm bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600 placeholder-slate-500 focus:outline-none focus:border-blue-500"
      />

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {[['all','Alla typer'],['cafe','Café'],['bar','Bar'],['restaurant','Restaurang'],['pub','Pub']].map(([v,l]) => (
          <button key={v} onClick={() => setTypeFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${typeFilter===v?'bg-blue-600 border-blue-500 text-white':'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'}`}>{l}</button>
        ))}
        <div className="w-px bg-slate-600 self-stretch"/>
        {[['active','Aktiva'],['inactive','Inaktiva'],['all_status','Alla']].map(([v,l]) => (
          <button key={v} onClick={() => setActiveFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${activeFilter===v?'bg-blue-600 border-blue-500 text-white':'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'}`}>{l}</button>
        ))}
        <div className="w-px bg-slate-600 self-stretch"/>
        {[['all','Alla orienteringar'],['unknown','Saknar orientering'],['set','Har orientering']].map(([v,l]) => (
          <button key={v} onClick={() => setOriFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${oriFilter===v?'bg-blue-600 border-blue-500 text-white':'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'}`}>{l}</button>
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
              <th className="text-left px-4 py-3">Ute</th>
              <th className="text-left px-4 py-3">Solbåge</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Adress</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <>
                <tr key={t.id} className={`border-t border-slate-700 ${t.active?'':'opacity-50'} hover:bg-slate-700/30 transition-colors`}>
                  <td className="px-4 py-3 text-white font-medium max-w-[180px] truncate">{t.name}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{t.amenity_type}</td>
                  <td className="px-4 py-3 text-xs">
                    {t.outdoor_type === 'rooftop' && <span className="text-amber-400">Rooftop</span>}
                    {t.outdoor_type === 'none'    && <span className="text-slate-500">Ingen</span>}
                    {t.outdoor_type === 'terrace' && <span className="text-green-400">Terrass</span>}
                    {(!t.outdoor_type || t.outdoor_type === 'unknown') && <span className="text-slate-600">—</span>}
                    {t.polygon_coords && <span className="ml-1 text-emerald-500 text-[10px]">▣</span>}
                  </td>
                  <td className="px-4 py-3">
                    {t.sun_arc_from != null && t.sun_arc_to != null ? (
                      <span className="text-amber-400 text-xs font-mono">
                        {Math.round(t.sun_arc_from)}°–{Math.round(t.sun_arc_to)}°
                      </span>
                    ) : t.street_orientation && t.street_orientation !== 'UNKNOWN' ? (
                      <span className="text-slate-400 text-xs">{t.street_orientation}</span>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${t.active?'bg-green-500/20 text-green-400':'bg-slate-600 text-slate-400'}`}>
                      {t.active?'Aktiv':'Inaktiv'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs max-w-[140px] truncate">{t.address||'—'}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => setEditingId(editingId===t.id?null:t.id)}
                      className={`text-xs transition-colors ${editingId===t.id?'text-slate-400 hover:text-slate-300':'text-blue-400 hover:text-blue-300'}`}>
                      {editingId===t.id?'Stäng':'Redigera'}
                    </button>
                  </td>
                </tr>
                {editingId === t.id && (
                  <EditPanel key={`edit-${t.id}`} terrace={t} onSave={handleSaved} onCancel={() => setEditingId(null)}/>
                )}
              </>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-slate-500 text-sm text-center py-8">Inga uteserveringar.</div>}
      </div>
    </div>
  )
}
