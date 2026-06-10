import { useState, useEffect, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, ZoomControl } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Sun, MapPin, Search, ChevronDown } from 'lucide-react'
import { fetchSunTerraces, fetchLocalForecast, fetchEnsemble, fetchPlanner, askPlanner } from './api'
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

// ── PlannerAskView ────────────────────────────────────────────────────────────

function cellColor(score) {
  if (score >= 70) return '#fde047'   // yellow-300  — soligt
  if (score >= 45) return '#f97316'   // orange-500  — halvsoligt
  if (score >= 20) return '#475569'   // slate-600   — lite sol
  return '#1e293b'                    // slate-800   — skugga
}

const EXAMPLES = [
  'Öl mellan 16 och 20 idag',
  'Italienskt på fredag kväll',
  'Bästa dag den här veckan för afterwork',
]

function SunTimeline({ results, hours, selectedId, onSelect }) {
  if (!results?.length) return <p className="text-slate-600 text-sm text-center py-10">Inga träffar</p>
  return (
    <div className="p-3">
      <div className="flex items-center mb-1" style={{ paddingLeft: 136 }}>
        {hours.map(h => (
          <div key={h} className="text-center text-[10px] text-slate-600 font-mono shrink-0" style={{ width: 26 }}>
            {String(h).padStart(2, '0')}
          </div>
        ))}
      </div>
      {results.slice(0, 20).map(t => (
        <button key={t.id} onClick={() => onSelect(t)}
          className={`w-full flex items-center py-0.5 rounded transition-colors ${selectedId === t.id ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'}`}>
          <div className="shrink-0 text-left pr-2" style={{ width: 136 }}>
            <p className="text-slate-300 text-xs truncate leading-tight">{t.name}</p>
            {t.avg_score > 0 && (
              <p className="font-mono tabular-nums text-[10px]" style={{ color: scoreColor(t.avg_score) }}>⌀{t.avg_score}</p>
            )}
          </div>
          {hours.map(h => {
            const s = t.hour_scores?.[h] ?? 0
            return <div key={h} className="rounded-sm shrink-0 mx-px" style={{ width: 24, height: 20, background: cellColor(s), opacity: s >= 20 ? 1 : 0.35 }} />
          })}
        </button>
      ))}
      <div className="flex items-center gap-3 mt-4 px-1">
        {[['#fde047', 'Soligt'], ['#f97316', 'Halvsoligt'], ['#475569', 'Lite sol']].map(([c, l]) => (
          <div key={l} className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: c }} />
            <span className="text-[10px] text-slate-500">{l}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PlannerAskView({ coords, selectedId, onSelectTerrace, onResultsChange }) {
  const [query, setQuery]   = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState(null)

  async function submit(q = query) {
    const text = (q || '').trim()
    if (!text) return
    setLoading(true)
    setError(null)
    try {
      const r = await askPlanner({ q: text, lat: coords.lat, lon: coords.lon })
      setResult(r)
      onResultsChange(r.results)
    } catch (e) {
      setError(`Fel: ${e?.message || e}`)
    } finally {
      setLoading(false)
    }
  }

  async function switchToDate(date) {
    if (!result?.interpreted) return
    setLoading(true)
    try {
      const p = result.interpreted
      const r = await fetchPlanner({
        lat: coords.lat, lon: coords.lon, radius: 5.0,
        date, fromHour: p.from_hour, toHour: p.to_hour,
        type: p.type || 'all', tags: (p.tags || []).join(','),
      })
      setResult(prev => ({ ...prev, query_type: 'specific', results: r, best_date: date }))
      onResultsChange(r)
    } catch {} finally { setLoading(false) }
  }

  const intp = result?.interpreted
  const hours = intp
    ? Array.from({ length: intp.to_hour - intp.from_hour + 1 }, (_, i) => intp.from_hour + i)
    : []

  function intpLabel() {
    if (!intp) return ''
    const date = intp.date
      ? new Date(intp.date + 'T12:00:00').toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' })
      : 'idag'
    const time = `kl ${String(intp.from_hour).padStart(2,'0')}–${String(intp.to_hour).padStart(2,'0')}`
    const type = intp.type && intp.type !== 'all' ? ` · ${intp.type}` : ''
    const tags = intp.tags?.length ? ' · ' + intp.tags.map(t => '#' + t).join(' ') : ''
    const area = intp.area_label ? ` · ${intp.area_label}` : ''
    return date + ', ' + time + type + tags + area
  }

  return (
    <aside className="w-80 xl:w-96 shrink-0 border-r border-slate-800/80 flex flex-col bg-slate-900">

      {/* ── Input ── */}
      <div className="px-4 pt-4 pb-3 border-b border-slate-800/80 space-y-3">
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="Beskriv din utekväll…"
            className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/50 pr-10 transition-colors"
          />
          <button onClick={() => submit()}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-amber-400 transition-colors text-base leading-none">
            {loading ? <span className="animate-pulse text-amber-400">…</span> : '↵'}
          </button>
        </div>

        {/* Example chips — only before first search */}
        {!result && !loading && (
          <div className="space-y-1">
            {EXAMPLES.map(ex => (
              <button key={ex} onClick={() => { setQuery(ex); submit(ex) }}
                className="w-full text-left text-xs text-slate-500 hover:text-slate-300 px-2 py-1 rounded-lg hover:bg-slate-800/60 transition-colors">
                "{ex}"
              </button>
            ))}
          </div>
        )}

        {/* Interpreted label + reset */}
        {result && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-slate-600 text-xs truncate">{intpLabel()}</p>
            <button onClick={() => { setResult(null); onResultsChange([]) }}
              className="shrink-0 text-slate-700 hover:text-slate-400 text-xs transition-colors">✕</button>
          </div>
        )}
      </div>

      {/* ── Results ── */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="text-red-400 text-sm text-center py-8 px-4">{error}</p>}

        {result?.query_type === 'best_in_window' && (
          <div className="p-4 space-y-3">
            {/* Recommendation card */}
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
              <p className="text-amber-300 text-sm leading-relaxed">{result.recommendation}</p>
            </div>

            {/* Top results */}
            {result.results.slice(0, 12).map(t => (
              <button key={t.id} onClick={() => onSelectTerrace(t)}
                className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
                  selectedId === t.id ? 'bg-slate-800 border-slate-600' : 'border-transparent hover:bg-slate-800/40'
                }`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-sm font-medium truncate">{t.name}</p>
                    {t.address && <p className="text-slate-500 text-xs truncate mt-0.5">{t.address}</p>}
                    {t.hashtags?.slice(0,3).length > 0 && (
                      <p className="text-slate-600 text-xs mt-1">{t.hashtags.slice(0,3).map(h => `#${h.name}`).join(' ')}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-bold tabular-nums text-sm" style={{ color: scoreColor(t.avg_score) }}>{t.avg_score}</p>
                    <p className="text-slate-600 text-[10px]">⌀/tim</p>
                  </div>
                </div>
              </button>
            ))}

            {/* Alt days */}
            {result.alt_days?.length > 0 && (
              <div className="pt-2 border-t border-slate-800">
                <p className="text-slate-600 text-xs mb-2 px-1">Alternativa dagar:</p>
                <div className="flex gap-2">
                  {result.alt_days.map(d => (
                    <button key={d.date} onClick={() => switchToDate(d.date)}
                      className="flex-1 text-center py-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-800 transition-colors">
                      <p className="text-slate-400 text-xs capitalize">{d.label}</p>
                      <p className="font-mono text-xs mt-0.5" style={{ color: scoreColor(d.top_score) }}>{d.top_score}p</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {result?.query_type === 'specific' && (
          <SunTimeline
            results={result.results}
            hours={hours}
            selectedId={selectedId}
            onSelect={onSelectTerrace}
          />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-slate-800/80">
        <p className="text-slate-700 text-xs">Tolkad av AI · Haiku 4.5 · upp till 7 dagars prognos</p>
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
          <PlannerAskView
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
