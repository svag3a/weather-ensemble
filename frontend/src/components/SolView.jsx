import { useState, useEffect } from 'react'
import { fetchSunTerraces } from '../api'

const GLASS = 'bg-black/20 backdrop-blur-sm border border-white/10'

function scoreColor(score) {
  if (score >= 70) return '#4ade80'
  if (score >= 40) return '#facc15'
  return '#94a3b8'
}

function scoreBg(score) {
  if (score >= 70) return 'rgba(74,222,128,0.15)'
  if (score >= 40) return 'rgba(250,204,21,0.15)'
  return 'rgba(148,163,184,0.10)'
}

function ConfidenceChip({ confidence }) {
  const label = confidence > 0.6 ? 'Hög säkerhet' : confidence > 0.4 ? 'Medel' : 'Osäker'
  const color = confidence > 0.6 ? 'text-green-400' : confidence > 0.4 ? 'text-yellow-400' : 'text-slate-400'
  return (
    <span className={`text-[10px] font-medium ${color}`}>{label}</span>
  )
}

function bestTimeLabel(key) {
  if (key === 'now') return 'Nu'
  if (key === '1h')  return '+1h'
  if (key === '2h')  return '+2h'
  return key
}

function amenityLabel(type) {
  const map = { restaurant: 'Restaurang', cafe: 'Café', bar: 'Bar', pub: 'Pub' }
  return map[type] ?? type
}

function scoreToColor(score) {
  // Maps 0-100 sun score to a sky/sun colour
  if (score <= 0)  return '#0f172a'   // dark night
  if (score < 25)  return '#1e3a5f'   // dark blue
  if (score < 45)  return '#7c3500'   // warm brown
  if (score < 65)  return '#c2410c'   // orange
  return '#f59e0b'                    // golden
}

function cardGradient(scores) {
  // Left→right timeline: now → +1h → +2h
  const c0 = scoreToColor(scores?.now?.total_score ?? 0)
  const c1 = scoreToColor(scores?.['1h']?.total_score ?? 0)
  const c2 = scoreToColor(scores?.['2h']?.total_score ?? 0)
  return `linear-gradient(to right, ${c0} 0%, ${c1} 50%, ${c2} 100%)`
}

function TerraceCard({ terrace }) {
  const { name, address, amenity_type, street_orientation, scores, best_score, explanation } = terrace
  const now_score = scores?.now?.total_score ?? 0
  const best = scores?.best_time ?? 'now'
  const altitude = scores?.[best]?.sun_altitude
  const weather_score = scores?.[best]?.weather_score

  return (
    <div
      className="rounded-2xl p-4 space-y-3 backdrop-blur-sm border border-white/10"
      style={{ background: cardGradient(scores) }}
    >
      {/* Header: score badge + name */}
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg"
          style={{ background: scoreBg(best_score), color: scoreColor(best_score) }}
        >
          {best_score}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-white font-medium leading-tight truncate">{name}</div>
          {address && <div className="text-slate-400 text-xs mt-0.5 truncate">{address}</div>}
          <div className="text-slate-500 text-xs mt-0.5">{amenityLabel(amenity_type)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div
            className="text-xs font-semibold px-2 py-0.5 rounded-full"
            style={{ background: scoreBg(best_score), color: scoreColor(best_score) }}
          >
            {bestTimeLabel(best)}
          </div>
        </div>
      </div>

      {/* Sub-scores row */}
      <div className="flex items-center gap-4 text-xs text-slate-400">
        {altitude != null && altitude > 0 && (
          <span>Sol {Math.round(altitude)}°</span>
        )}
        {weather_score != null && (
          <span>Väder {weather_score}%</span>
        )}
        {street_orientation && street_orientation !== 'UNKNOWN' && (
          <span>Läge {street_orientation}</span>
        )}
        <ConfidenceChip confidence={scores?.confidence ?? 0.3} />
      </div>

      {/* Score timeline: now / +1h / +2h */}
      <div className="flex gap-2">
        {['now', '1h', '2h'].map(key => {
          const s = scores?.[key]?.total_score ?? 0
          return (
            <div key={key} className="flex-1 text-center">
              <div className="text-[10px] text-slate-500 mb-0.5">{bestTimeLabel(key)}</div>
              <div
                className="rounded-lg py-1 text-xs font-semibold"
                style={{ background: scoreBg(s), color: scoreColor(s) }}
              >
                {s}
              </div>
            </div>
          )
        })}
      </div>

      {/* Explanation */}
      <p className="text-slate-400 text-xs leading-relaxed">{explanation}</p>
    </div>
  )
}

export default function SolView({ coords }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState({ type: 'all', minScore: 0 })

  useEffect(() => {
    if (!coords) return
    setLoading(true)
    setError(null)
    fetchSunTerraces({ lat: coords.lat, lon: coords.lon, ...filter })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [coords, filter.type, filter.minScore])

  const TYPE_FILTERS = [
    { value: 'all',        label: 'Alla' },
    { value: 'cafe',       label: 'Café' },
    { value: 'bar',        label: 'Bar' },
    { value: 'restaurant', label: 'Restaurang' },
  ]
  const SCORE_FILTERS = [
    { value: 0,  label: 'Alla' },
    { value: 50, label: '50+' },
    { value: 70, label: '70+' },
  ]

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="px-1">
        <h1 className="text-white font-semibold text-lg">Solsökaren</h1>
        <p className="text-slate-400 text-xs mt-0.5">Uteserveringar med bäst solläge just nu</p>
      </div>

      {/* Filter bar — type */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {TYPE_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(prev => ({ ...prev, type: f.value }))}
            className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              filter.type === f.value
                ? 'bg-white/20 text-white'
                : 'bg-black/20 text-slate-400'
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="w-px mx-1 bg-slate-700 self-stretch" />
        {SCORE_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(prev => ({ ...prev, minScore: f.value }))}
            className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              filter.minScore === f.value
                ? 'bg-white/20 text-white'
                : 'bg-black/20 text-slate-400'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className={`${GLASS} rounded-2xl p-8 text-slate-500 text-center text-sm`}>
          Beräknar sollägen…
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm`}>
          Kunde inte hämta uteserveringar.
        </div>
      )}

      {/* No coords */}
      {!coords && !loading && (
        <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm`}>
          Aktivera platstjänster för att hitta uteserveringar nära dig.
        </div>
      )}

      {/* Results */}
      {!loading && data && data.length === 0 && (
        <div className={`${GLASS} rounded-2xl p-8 flex flex-col items-center gap-3 text-center`}>
          <span className="text-3xl">☀️</span>
          <p className="text-white font-medium">Inga träffar</p>
          <p className="text-slate-500 text-sm">
            Prova ett lägre minpoäng eller ett annat typ-filter.
          </p>
        </div>
      )}

      {!loading && data && data.length > 0 && (
        <>
          <p className="text-slate-500 text-xs px-1">
            {data.length} uteserveringar inom 2 km
          </p>
          {data.map(t => <TerraceCard key={t.id} terrace={t} />)}
          <p className="text-white/30 text-xs px-1 pt-1">
            Data från OpenStreetMap · Solberäkning uppdateras löpande
          </p>
        </>
      )}
    </div>
  )
}
