import { useState, useEffect, useCallback } from 'react'
import { fetchSunTerraces } from '../api'
import { sunTimesUTC } from '../weatherSymbol'
import { Moon } from 'lucide-react'

const GLASS = 'bg-black/20 backdrop-blur-sm border border-white/10'

// 4-dot symbolic rating: ●●●● = full sun, ○○○○ = no sun
function SunDots({ score }) {
  const filled = score >= 70 ? 4 : score >= 45 ? 3 : score >= 20 ? 2 : score > 0 ? 1 : 0
  const color   = score >= 70 ? '#f59e0b' : score >= 45 ? '#fb923c' : score >= 20 ? '#94a3b8' : '#374151'
  return (
    <span className="flex gap-0.5">
      {[0,1,2,3].map(i => (
        <span key={i} style={{
          width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
          background: i < filled ? color : '#1e293b',
          border: `1px solid ${i < filled ? color : '#334155'}`,
        }} />
      ))}
    </span>
  )
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
  if (score <= 0)  return '#0f172a'
  if (score < 25)  return '#1e3a5f'
  if (score < 45)  return '#7c3500'
  if (score < 65)  return '#c2410c'
  return '#f59e0b'
}

function SunTimeline({ scores, coords }) {
  const now = new Date()
  const lat = coords?.lat ?? 57.706
  const lon = coords?.lon ?? 11.967
  const { sunset } = sunTimesUTC(now, lat, lon)
  const tz = -now.getTimezoneOffset() / 60
  const ssLocal = (sunset + tz + 24) % 24
  const nowH = now.getHours() + now.getMinutes() / 60
  const hoursToSunset = Math.max(0.1, ssLocal - nowH)

  const s0 = scores?.now?.total_score ?? 0
  const s1 = scores?.['1h']?.total_score ?? 0
  const s2 = scores?.['2h']?.total_score ?? 0

  // Position each score as % of now→sunset span
  const pct = h => Math.min(98, Math.round((h / hoursToSunset) * 100))
  const p1 = pct(1), p2 = pct(2)

  const gradient = [
    `${scoreToColor(s0)} 0%`,
    `${scoreToColor(s1)} ${p1}%`,
    `${scoreToColor(s2)} ${p2}%`,
    `#1e293b 100%`,
  ].join(', ')

  // Sunset label
  const ssH = Math.floor(ssLocal)
  const ssM = String(Math.round((ssLocal % 1) * 60)).padStart(2, '0')

  return (
    <div className="space-y-1">
      <div className="h-2.5 rounded-full w-full" style={{ background: `linear-gradient(to right, ${gradient})` }} />
      <div className="flex justify-between items-center text-[10px] text-slate-600">
        <span>Nu</span>
        <Moon size={11} />
      </div>
    </div>
  )
}

function TerraceCard({ terrace, isFav, onToggleFav, coords }) {
  const { id, name, address, amenity_type, street_orientation, scores, explanation } = terrace

  const best = scores?.best_time ?? 'now'
  const altitude = scores?.[best]?.sun_altitude

  return (
    <div className={`${GLASS} rounded-2xl p-4 space-y-3`}>
      {/* Header: name + star */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-white font-medium leading-tight truncate">{name}</div>
          {address && <div className="text-slate-400 text-xs mt-0.5 truncate">{address}</div>}
          <div className="text-slate-500 text-xs mt-0.5">{amenityLabel(amenity_type)}</div>
        </div>
        <button
          onClick={() => onToggleFav(id)}
          className="shrink-0 text-lg leading-none transition-opacity"
          style={{ opacity: isFav ? 1 : 0.3 }}
        >
          {isFav ? '★' : '☆'}
        </button>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 text-xs text-slate-500">
        {altitude != null && altitude > 0 && <span>Sol {Math.round(altitude)}°</span>}
        {street_orientation && street_orientation !== 'UNKNOWN' && <span>{street_orientation}</span>}
        <ConfidenceChip confidence={scores?.confidence ?? 0.3} />
      </div>

      {/* Continuous sun timeline: now → sunset */}
      <SunTimeline scores={scores} coords={coords} />

    </div>
  )
}

const FAVS_KEY = 'sol_favourites'
function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]')) } catch { return new Set() } }
function saveFavs(set) { localStorage.setItem(FAVS_KEY, JSON.stringify([...set])) }

export default function SolView({ coords }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState({ type: 'all', minScore: 0 })
  const [favs, setFavs] = useState(loadFavs)
  const [mode, setMode] = useState('sol')   // 'sol' | 'skugga'

  const toggleFav = useCallback((id) => {
    setFavs(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      saveFavs(next)
      return next
    })
  }, [])

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

  // Sort/filter based on mode
  const sortedData = data ? [...data].sort((a, b) => {
    const favDiff = (favs.has(b.id) ? 1 : 0) - (favs.has(a.id) ? 1 : 0)
    if (favDiff !== 0) return favDiff
    return mode === 'skugga'
      ? (a.best_score ?? 0) - (b.best_score ?? 0)   // low score first
      : (b.best_score ?? 0) - (a.best_score ?? 0)    // high score first
  }) : []

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="px-1">
        <h1 className="text-white font-semibold text-lg">Solsökaren</h1>
        <p className="text-slate-400 text-xs mt-0.5">
          {mode === 'sol' ? 'Uteserveringar med bäst solläge just nu' : 'Uteserveringar i skugga just nu'}
        </p>
      </div>

      {/* Sol / Skugga toggle — own row */}
      <div className="flex gap-1.5">
        {['sol','skugga'].map(m => (
          <button key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
              mode === m ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-400'
            }`}
          >
            {m === 'sol' ? '☀️ Sol' : '🌿 Skugga'}
          </button>
        ))}
      </div>

      {/* Type filter */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {TYPE_FILTERS.map(f => (
          <button key={f.value}
            onClick={() => setFilter(prev => ({ ...prev, type: f.value }))}
            className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              filter.type === f.value ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-400'
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
          {sortedData.map(t => (
            <TerraceCard key={t.id} terrace={t} isFav={favs.has(t.id)} onToggleFav={toggleFav} coords={coords} />
          ))}
          <p className="text-white/30 text-xs px-1 pt-1">
            Data från OpenStreetMap · Solberäkning uppdateras löpande
          </p>
        </>
      )}
    </div>
  )
}
