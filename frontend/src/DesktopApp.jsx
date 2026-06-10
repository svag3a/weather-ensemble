import { useState, useEffect, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, ZoomControl } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Sun, MapPin, Search, ChevronDown } from 'lucide-react'
import { fetchSunTerraces, fetchLocalForecast, fetchEnsemble, fetchPlanner, fetchHashtags } from './api'
import { getWeatherInfo, feelsLike } from './weatherSymbol'
import WeatherSymbol from './components/WeatherSymbol'

const GBG = { lat: 57.7089, lon: 11.9746 }

const TYPE_LABELS   = { cafe: 'Café', bar: 'Bar', pub: 'Pub', restaurant: 'Restaurang' }
const TYPE_ICONS    = { cafe: '☕', bar: '🍸', pub: '🍺', restaurant: '🍽️' }
const ALL_TYPES     = ['restaurant', 'cafe', 'bar', 'pub']

// ── Score helpers ─────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score == null || score <= 0) return '#334155'
  if (score >= 70) return '#f59e0b'
  if (score >= 45) return '#fb923c'
  if (score >= 20) return '#64748b'
  return '#334155'
}

function scoreLabel(score) {
  if (score == null) return null
  if (score >= 70) return 'Soligt'
  if (score >= 45) return 'Halvsoligt'
  if (score >= 20) return 'Lite sol'
  return 'I skugga'
}

// ── Map helpers ───────────────────────────────────────────────────────────────

function MapController({ flyTarget }) {
  const map = useMap()
  const prev = useRef(null)
  useEffect(() => {
    if (!flyTarget || flyTarget === prev.current) return
    prev.current = flyTarget
    map.flyTo([flyTarget.lat, flyTarget.lon], 16, { duration: 0.8 })
  }, [flyTarget, map])
  return null
}

// ── Components ────────────────────────────────────────────────────────────────

function ScorePill({ score }) {
  const color = scoreColor(score)
  if (score == null) return <span className="text-slate-600 text-xs w-8 text-right shrink-0">—</span>
  return (
    <span className="text-xs font-bold w-8 text-right shrink-0 tabular-nums" style={{ color }}>
      {score}
    </span>
  )
}

function SunDots({ score }) {
  const filled = score >= 70 ? 4 : score >= 45 ? 3 : score >= 20 ? 2 : score > 0 ? 1 : 0
  const color  = scoreColor(score)
  return (
    <span className="flex gap-0.5 shrink-0">
      {[0, 1, 2, 3].map(i => (
        <span key={i} style={{
          width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
          background: i < filled ? color : '#1e293b',
          border: `1px solid ${i < filled ? color : '#334155'}`,
        }} />
      ))}
    </span>
  )
}

function WeatherBar({ forecast }) {
  if (!forecast) return null
  const { symbol, label } = getWeatherInfo(
    forecast.temperature,
    forecast.precip_probability,
    forecast.wind_speed,
    forecast.cloud_cover,
    forecast.valid_for,
    0,
    forecast.fog_probability ?? 0,
    forecast.precip_mm ?? 0,
  )
  const fl = feelsLike(forecast.temperature, forecast.wind_speed)
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-xl leading-none"><WeatherSymbol symbol={symbol} /></span>
      <span className="text-white font-semibold tabular-nums">
        {forecast.temperature != null ? `${Math.round(forecast.temperature)}°` : '—'}
      </span>
      {fl != null && (
        <span className="text-slate-500 text-xs">Känns {fl}°</span>
      )}
      <span className="text-slate-400 text-xs">{label}</span>
      {forecast.wind_speed >= 3 && (
        <span className="text-slate-500 text-xs ml-auto">{Math.round(forecast.wind_speed)} m/s</span>
      )}
    </div>
  )
}

function TerraceCard({ terrace, selected, onClick }) {
  const t = terrace
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-slate-800/70 transition-colors group ${
        selected
          ? 'bg-slate-800/80 border-l-2 border-l-amber-500 pl-3.5'
          : 'hover:bg-slate-800/40'
      }`}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <p className="text-white text-sm font-medium truncate leading-snug">{t.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-slate-500 text-xs">
              {TYPE_ICONS[t.amenity_type]} {TYPE_LABELS[t.amenity_type] ?? t.amenity_type}
            </span>
            {t.address && (
              <span className="text-slate-600 text-xs truncate">· {t.address}</span>
            )}
          </div>
          {t.hashtags?.length > 0 && (
            <p className="text-slate-600 text-xs mt-1 truncate">
              {t.hashtags.slice(0, 3).map(h => `#${h.name}`).join(' ')}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <ScorePill score={t.day_score} />
          <SunDots score={t.day_score ?? 0} />
        </div>
      </div>
    </button>
  )
}

// ── PlannerView ───────────────────────────────────────────────────────────────

function cellColor(score) {
  if (score >= 70) return '#f59e0b'
  if (score >= 45) return '#fb923c'
  if (score >= 20) return '#334155'
  return '#1e293b'
}

function PlannerView({ coords, selectedId, onSelectTerrace, onResultsChange }) {
  const [date, setDate]           = useState(null)
  const [fromHour, setFromHour]   = useState(16)
  const [toHour, setToHour]       = useState(20)
  const [typeFilter, setTypeFilter] = useState(new Set(ALL_TYPES))
  const [activeTags, setActiveTags] = useState(new Set())
  const [hashtags, setHashtags]   = useState([])
  const [results, setResults]     = useState([])
  const [loading, setLoading]     = useState(false)

  useEffect(() => {
    fetchHashtags().then(setHashtags).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    const typeStr = [...typeFilter].join(',') || 'all'
    const tagsStr = [...activeTags].join(',')
    fetchPlanner({
      lat: coords.lat, lon: coords.lon, radius: 5.0,
      date, fromHour, toHour: Math.max(fromHour, toHour),
      type: typeStr, tags: tagsStr,
    })
      .then(r => { setResults(r); onResultsChange(r) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [coords, date, fromHour, toHour, typeFilter, activeTags])

  const dateOptions = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() + i)
    return {
      value: i === 0 ? null : d.toISOString().slice(0, 10),
      label: i === 0 ? 'Idag'
           : i === 1 ? 'Imorgon'
           : d.toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric' }),
    }
  })

  const hours = Array.from({ length: Math.max(toHour, fromHour) - fromHour + 1 }, (_, i) => fromHour + i)
  const top = results.slice(0, 20)

  function toggleType(t) {
    setTypeFilter(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n })
  }
  function toggleTag(name) {
    setActiveTags(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n })
  }

  return (
    <aside className="w-80 xl:w-96 shrink-0 border-r border-slate-800/80 flex flex-col bg-slate-900">

      {/* ── Filters ── */}
      <div className="px-4 py-3 border-b border-slate-800/80 space-y-2.5">

        {/* Date chips */}
        <div className="flex flex-wrap gap-1">
          {dateOptions.map(opt => (
            <button key={opt.value ?? 'today'} onClick={() => setDate(opt.value)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                date === opt.value
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-slate-800 text-slate-500 border-slate-700 hover:text-slate-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Time range */}
        <div className="flex items-center gap-2">
          <span className="text-slate-500 text-xs shrink-0">Tid:</span>
          <select value={fromHour} onChange={e => setFromHour(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded text-xs text-white px-1.5 py-1 focus:outline-none">
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
            ))}
          </select>
          <span className="text-slate-600 text-xs">–</span>
          <select value={toHour} onChange={e => setToHour(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded text-xs text-white px-1.5 py-1 focus:outline-none">
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i} disabled={i < fromHour}>{String(i).padStart(2, '0')}:00</option>
            ))}
          </select>
        </div>

        {/* Type chips */}
        <div className="flex flex-wrap gap-1">
          {ALL_TYPES.map(type => (
            <button key={type} onClick={() => toggleType(type)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                typeFilter.has(type)
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-slate-800 text-slate-500 border-slate-700 hover:text-slate-400'
              }`}
            >
              {TYPE_ICONS[type]} {TYPE_LABELS[type]}
            </button>
          ))}
        </div>

        {/* Hashtag chips */}
        {hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1 max-h-16 overflow-hidden">
            {hashtags.slice(0, 16).map(h => (
              <button key={h.id} onClick={() => toggleTag(h.name)}
                className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                  activeTags.has(h.name)
                    ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                    : 'bg-slate-800 text-slate-600 border-slate-700 hover:text-slate-400'
                }`}
              >
                #{h.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Count */}
      <div className="px-4 py-2 border-b border-slate-800/80 flex items-center justify-between">
        <span className="text-xs text-slate-500">{top.length} ställen</span>
        {loading && <span className="text-xs text-amber-400 animate-pulse">Hämtar…</span>}
      </div>

      {/* ── Timeline grid ── */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {!loading && top.length === 0 && (
          <p className="text-slate-600 text-sm text-center py-10">Inga träffar</p>
        )}
        {top.length > 0 && (
          <div className="p-3">
            {/* Hour header */}
            <div className="flex items-center mb-1" style={{ paddingLeft: 136 }}>
              {hours.map(h => (
                <div key={h} className="text-center text-[10px] text-slate-600 font-mono shrink-0" style={{ width: 26 }}>
                  {String(h).padStart(2, '0')}
                </div>
              ))}
            </div>

            {/* Rows */}
            {top.map(t => (
              <button
                key={t.id}
                onClick={() => onSelectTerrace(t)}
                className={`w-full flex items-center py-0.5 rounded transition-colors ${
                  selectedId === t.id ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
                }`}
              >
                {/* Name */}
                <div className="shrink-0 text-left pr-2" style={{ width: 136 }}>
                  <p className="text-slate-300 text-xs truncate leading-tight">{t.name}</p>
                  {t.avg_score > 0 && (
                    <p className="font-mono tabular-nums text-[10px]" style={{ color: scoreColor(t.avg_score) }}>
                      ⌀{t.avg_score}
                    </p>
                  )}
                </div>

                {/* Hour cells */}
                {hours.map(h => {
                  const s = t.hour_scores?.[h] ?? 0
                  return (
                    <div key={h} className="rounded-sm shrink-0 mx-px"
                      style={{ width: 24, height: 20, background: cellColor(s), opacity: s >= 20 ? 1 : 0.35 }}
                    />
                  )
                })}
              </button>
            ))}

            {/* Legend */}
            <div className="flex items-center gap-3 mt-4 px-1">
              {[['#f59e0b', 'Soligt'], ['#fb923c', 'Halvsoligt'], ['#334155', 'Lite sol'], ['#1e293b', 'Skugga']].map(([c, l]) => (
                <div key={l} className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: c }} />
                  <span className="text-[10px] text-slate-500">{l}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-slate-800/80">
        <p className="text-slate-700 text-xs">Solpoäng per timme · upp till 7 dagars prognos</p>
      </div>
    </aside>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function DesktopApp() {
  const [coords, setCoords]     = useState(GBG)
  const [terraces, setTerraces] = useState([])
  const [forecast, setForecast] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [selectedId, setSelectedId]   = useState(null)
  const [flyTarget, setFlyTarget]     = useState(null)
  const [typeFilter, setTypeFilter]   = useState(new Set(ALL_TYPES))
  const [minScore, setMinScore]       = useState(0)
  const [nameFilter, setNameFilter]   = useState('')
  const [mode, setMode]               = useState('now')   // 'now' | 'plan'
  const [plannerResults, setPlannerResults] = useState([])

  // Geolocation
  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      pos => setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {},
      { timeout: 5000 },
    )
  }, [])

  // Load terraces when coords settle
  const loadTerraces = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchSunTerraces({ lat: coords.lat, lon: coords.lon, radius: 5.0 })
      setTerraces(data ?? [])
    } catch { setTerraces([]) }
    finally { setLoading(false) }
  }, [coords])

  useEffect(() => { loadTerraces() }, [loadTerraces])

  // Load current weather
  useEffect(() => {
    fetchLocalForecast(coords.lat, coords.lon, 2)
      .then(fcs => { if (fcs?.length) setForecast(fcs[0]) })
      .catch(() => {})
  }, [coords])

  // Derived list
  const filtered = terraces
    .filter(t => typeFilter.has(t.amenity_type))
    .filter(t => (t.day_score ?? 0) >= minScore)
    .filter(t => !nameFilter || t.name?.toLowerCase().includes(nameFilter.toLowerCase()))
    .sort((a, b) => (b.day_score ?? 0) - (a.day_score ?? 0))

  function toggleType(type) {
    setTypeFilter(prev => {
      const n = new Set(prev)
      n.has(type) ? n.delete(type) : n.add(type)
      return n
    })
  }

  function selectTerrace(t) {
    setSelectedId(t.id)
    setFlyTarget(t)
  }

  const selected = (mode === 'now' ? terraces : plannerResults).find(t => t.id === selectedId) ?? null

  return (
    <div className="h-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="h-14 shrink-0 border-b border-slate-800/80 flex items-center gap-5 px-5">
        {/* Brand */}
        <div className="flex items-center gap-2 shrink-0">
          <Sun size={20} className="text-amber-400" />
          <span className="font-semibold text-base tracking-tight">gbgsol</span>
          <span className="text-slate-600 text-xs font-normal hidden lg:inline">· Göteborg</span>
        </div>

        {/* Weather */}
        <div className="border-l border-slate-800 pl-5 flex-1">
          <WeatherBar forecast={forecast} />
        </div>

        {/* Mode toggle */}
        <div className="flex bg-slate-800 rounded-lg p-0.5 shrink-0">
          {[['now', 'Nu'], ['plan', 'Planera']].map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                mode === m ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Name search — only in 'now' mode */}
        {mode === 'now' && (
          <div className="relative shrink-0">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              placeholder="Sök ställe…"
              value={nameFilter}
              onChange={e => setNameFilter(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-sm placeholder-slate-500 focus:outline-none focus:border-slate-600 w-44 transition-colors"
            />
          </div>
        )}
      </header>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Planner sidebar ──────────────────────────────────────── */}
        {mode === 'plan' && (
          <PlannerView
            coords={coords}
            selectedId={selectedId}
            onSelectTerrace={t => { setSelectedId(t.id); setFlyTarget(t) }}
            onResultsChange={setPlannerResults}
          />
        )}

        {/* ── Now sidebar ───────────────────────────────────────────── */}
        {mode === 'now' && <aside className="w-72 xl:w-80 shrink-0 border-r border-slate-800/80 flex flex-col bg-slate-900">

          {/* Filters */}
          <div className="px-4 py-3 border-b border-slate-800/80 space-y-2.5">
            {/* Type chips */}
            <div className="flex flex-wrap gap-1.5">
              {ALL_TYPES.map(type => (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    typeFilter.has(type)
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      : 'bg-slate-800 text-slate-500 border-slate-700 hover:text-slate-400'
                  }`}
                >
                  {TYPE_ICONS[type]} {TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            {/* Min score */}
            <div className="flex items-center gap-2">
              <span className="text-slate-500 text-xs">Min solpoäng:</span>
              <div className="flex gap-1">
                {[0, 20, 40, 60].map(v => (
                  <button
                    key={v}
                    onClick={() => setMinScore(v)}
                    className={`px-2 py-0.5 rounded text-xs transition-colors ${
                      minScore === v
                        ? 'bg-slate-600 text-white'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {v === 0 ? 'Alla' : `${v}+`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Count bar */}
          <div className="px-4 py-2 border-b border-slate-800/80 flex items-center justify-between">
            <span className="text-xs text-slate-500">{filtered.length} ställen</span>
            {loading && <span className="text-xs text-amber-400 animate-pulse">Laddar…</span>}
          </div>

          {/* Terrace list */}
          <div className="overflow-y-auto flex-1 overscroll-contain">
            {!loading && filtered.length === 0 && (
              <p className="text-slate-600 text-sm text-center py-10">Inga träffar</p>
            )}
            {filtered.map(t => (
              <TerraceCard
                key={t.id}
                terrace={t}
                selected={selectedId === t.id}
                onClick={() => selectTerrace(t)}
              />
            ))}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-slate-800/80">
            <p className="text-slate-700 text-xs">
              Källa: OSM + Google Places · Solpoäng uppdateras varje timme
            </p>
          </div>
        </aside>}

        {/* ── Map ──────────────────────────────────────────────────── */}
        <div className="flex-1 relative">
          <MapContainer
            center={[coords.lat, coords.lon]}
            zoom={13}
            style={{ width: '100%', height: '100%' }}
            zoomControl={false}
          >
            <ZoomControl position="bottomright" />
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
              maxZoom={19}
            />
            <MapController flyTarget={flyTarget} />

            {(mode === 'now' ? filtered : plannerResults).map(t => {
              const score  = mode === 'now' ? t.day_score : t.avg_score
              const isSel  = t.id === selectedId
              return (
                <CircleMarker
                  key={t.id}
                  center={[t.lat, t.lon]}
                  radius={isSel ? 9 : 6}
                  pathOptions={{
                    fillColor:    scoreColor(score),
                    fillOpacity:  isSel ? 1.0 : 0.80,
                    color:        isSel ? '#fff' : scoreColor(score),
                    weight:       isSel ? 2 : 1,
                    opacity:      isSel ? 1.0 : 0.60,
                  }}
                  eventHandlers={{ click: () => selectTerrace(t) }}
                >
                  <Popup>
                    <div className="text-slate-900 min-w-[160px]">
                      <p className="font-semibold text-sm">{t.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {TYPE_ICONS[t.amenity_type]} {TYPE_LABELS[t.amenity_type]}
                        {t.address && ` · ${t.address}`}
                      </p>
                      {score != null && (
                        <div className="flex items-center gap-1 mt-1.5">
                          <span className="text-sm font-bold" style={{ color: scoreColor(score) }}>
                            {score}
                          </span>
                          <span className="text-xs text-slate-400">/ 100 · {scoreLabel(score)}</span>
                        </div>
                      )}
                      {t.hashtags?.length > 0 && (
                        <p className="text-xs text-slate-400 mt-1">
                          {t.hashtags.map(h => `#${h.name}`).join(' ')}
                        </p>
                      )}
                    </div>
                  </Popup>
                </CircleMarker>
              )
            })}
          </MapContainer>

          {/* Selected terrace details overlay */}
          {selected && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/95 backdrop-blur-sm border border-slate-700 rounded-2xl px-5 py-4 shadow-xl min-w-[280px] max-w-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white font-semibold">{selected.name}</p>
                  <p className="text-slate-400 text-xs mt-0.5">
                    {TYPE_ICONS[selected.amenity_type]} {TYPE_LABELS[selected.amenity_type]}
                    {selected.address && ` · ${selected.address}`}
                  </p>
                </div>
                {(() => {
                  const s = mode === 'now' ? selected.day_score : selected.avg_score
                  return s != null ? (
                    <div className="shrink-0 text-right">
                      <p className="font-bold text-xl tabular-nums" style={{ color: scoreColor(s) }}>{s}</p>
                      <p className="text-slate-500 text-xs">/ 100</p>
                    </div>
                  ) : null
                })()}
              </div>
              {selected.hashtags?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {selected.hashtags.map(h => (
                    <span key={h.id} className="bg-slate-800 text-slate-300 text-xs px-2 py-0.5 rounded-full">
                      #{h.name}
                    </span>
                  ))}
                </div>
              )}
              <button
                onClick={() => setSelectedId(null)}
                className="absolute top-3 right-3 text-slate-600 hover:text-slate-300 text-xs transition-colors"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
