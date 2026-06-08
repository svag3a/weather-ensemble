import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchSunTerraces, voteTerrrace, createTerrace } from '../api'
import { sunTimesUTC } from '../weatherSymbol'
import { Moon, Sun, Parasol, ThumbsUp, ThumbsDown, Cloud, CloudRain, TriangleRight, Spline } from 'lucide-react'

const GLASS = 'bg-black/20 backdrop-blur-sm border border-white/10'

const ALL_TYPES = ['cafe', 'bar', 'pub', 'restaurant']
const TYPE_LABELS = { cafe: 'Café', bar: 'Bar', pub: 'Pub', restaurant: 'Restaurang' }

// ── Sun dots ──────────────────────────────────────────────────────────────────
function SunDots({ score }) {
  const filled = score >= 70 ? 4 : score >= 45 ? 3 : score >= 20 ? 2 : score > 0 ? 1 : 0
  const color  = score >= 70 ? '#f59e0b' : score >= 45 ? '#fb923c' : score >= 20 ? '#94a3b8' : '#374151'
  return (
    <span className="flex gap-0.5">
      {[0,1,2,3].map(i => (
        <span key={i} style={{
          width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
          background: i < filled ? color : '#1e293b',
          border: `1px solid ${i < filled ? color : '#334155'}`,
        }}/>
      ))}
    </span>
  )
}

// Solar arc or orientation indicator in card meta row
function ArcChip({ arcFrom, arcTo, orientation }) {
  if (arcFrom != null && arcTo != null) {
    const span = Math.round((arcTo - arcFrom + 360) % 360 || 360)
    return (
      <span className="flex items-center gap-0.5">
        <Spline size={10}/>
        <span>{Math.round(arcFrom)}°–{Math.round(arcTo)}° ({span}°)</span>
      </span>
    )
  }
  if (orientation && orientation !== 'UNKNOWN') {
    return (
      <span className="flex items-center gap-0.5">
        <Spline size={10}/>
        <span>{orientation}</span>
      </span>
    )
  }
  return null
}

// Day score badge — colored 0-100 number
function dayScoreColor(s) {
  if (s >= 80) return '#fde047'
  if (s >= 60) return '#f59e0b'
  if (s >= 40) return '#ea580c'
  if (s >= 20) return '#7c2d12'
  return '#374151'
}

function DayScoreBadge({ score }) {
  if (score == null) return null
  const color = dayScoreColor(score)
  return (
    <div className="flex flex-col items-center justify-center w-9 shrink-0">
      <span style={{ color, fontSize: 18, fontWeight: 700, lineHeight: 1 }}>{score}</span>
      <span className="text-slate-600" style={{ fontSize: 8 }}>/ 100</span>
    </div>
  )
}

// Small weather indicator shown only when conditions are noteworthy
function WeatherChip({ weatherScore }) {
  if (weatherScore == null || weatherScore >= 60) return null
  if (weatherScore < 30) return (
    <span className="flex items-center gap-0.5 text-blue-400">
      <CloudRain size={11}/><span className="text-[10px]">Regn</span>
    </span>
  )
  return (
    <span className="flex items-center gap-0.5 text-slate-400">
      <Cloud size={11}/><span className="text-[10px]">Molnigt</span>
    </span>
  )
}

function ConfidenceChip({ confidence }) {
  const label = confidence > 0.6 ? 'Hög säkerhet' : confidence > 0.4 ? 'Medel' : 'Osäker'
  const color = confidence > 0.6 ? 'text-green-400' : confidence > 0.4 ? 'text-yellow-400' : 'text-slate-400'
  return <span className={`text-[10px] font-medium ${color}`}>{label}</span>
}

function amenityLabel(type) {
  return { restaurant: 'Restaurang', cafe: 'Café', bar: 'Bar', pub: 'Pub' }[type] ?? type
}

function scoreToColor(score) {
  if (score <= 0)  return '#0f172a'   // ingen sol — nästan svart
  if (score < 25)  return '#7c2d12'   // svag sol — mörk brun-orange
  if (score < 50)  return '#ea580c'   // måttlig sol — orange
  if (score < 75)  return '#f59e0b'   // bra sol — amber
  return '#fde047'                    // full sol — gul
}

// Format hours as "+1h", "+0:30h", "+1:30h"
function fmtH(h) {
  const hrs = Math.floor(h)
  const mins = Math.round((h % 1) * 60)
  if (mins === 0) return `+${hrs}h`
  if (hrs === 0)  return `+0:${String(mins).padStart(2,'0')}`
  return `+${hrs}:${String(mins).padStart(2,'0')}`
}

// Pick a step size that gives 3–5 markers
function markerStep(hoursToSunset) {
  if (hoursToSunset > 8)  return 2
  if (hoursToSunset > 4)  return 1
  if (hoursToSunset > 2)  return 0.5
  return 0.25
}

// ── Sun timeline ─────────────────────────────────────────────────────────────
function SunTimeline({ scores, coords }) {
  const now = new Date()
  const lat = coords?.lat ?? 57.706
  const lon = coords?.lon ?? 11.967
  const { sunset } = sunTimesUTC(now, lat, lon)
  const tz = -now.getTimezoneOffset() / 60
  const ssLocal = (sunset + tz + 24) % 24
  const nowH = now.getHours() + now.getMinutes() / 60
  const hoursToSunset = Math.max(0.25, ssLocal - nowH)

  // Use orientation_score (0–100): how directly the sun faces this terrace.
  // sun_score was (alt/90)×orientation which gives max ~60 at Göteborg latitudes,
  // making all thresholds look dark. orientation_score uses the full 0–100 range.
  const s0 = scores?.now?.orientation_score ?? 0
  const s1 = scores?.['1h']?.orientation_score ?? 0
  const s2 = scores?.['2h']?.orientation_score ?? 0

  const pct = h => Math.min(100, (h / hoursToSunset) * 100)
  const p1 = pct(1), p2 = pct(2)

  // Gradient: known scores from now→+2h, then fade to dark
  const gradient = [
    `${scoreToColor(s0)} 0%`,
    `${scoreToColor(s1)} ${p1.toFixed(1)}%`,
    `${scoreToColor(s2)} ${p2.toFixed(1)}%`,
    `${scoreToColor(s2)} ${Math.min(p2 + 8, 100).toFixed(1)}%`,
    `#1e293b 100%`,
  ].join(', ')

  // Dynamic time markers
  const step = markerStep(hoursToSunset)
  const markers = []
  for (let h = step; h < hoursToSunset - step * 0.4; h += step) {
    markers.push({ pct: pct(h), label: fmtH(h) })
  }

  return (
    <div className="space-y-0.5">
      {/* Bar with tick marks */}
      <div className="relative h-2.5">
        <div className="absolute inset-0 rounded-full"
          style={{ background: `linear-gradient(to right, ${gradient})` }}/>
        {markers.map((m, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-px bg-black/30"
            style={{ left: `${m.pct}%` }}/>
        ))}
      </div>
      {/* Labels */}
      <div className="relative h-3.5">
        <span className="absolute left-0 text-[9px] text-slate-500 leading-none">Nu</span>
        {markers.map((m, i) => (
          <span key={i} className="absolute text-[9px] text-slate-500 leading-none"
            style={{ left: `${m.pct}%`, transform: 'translateX(-50%)' }}>
            {m.label}
          </span>
        ))}
        <span className="absolute right-0 flex items-center" style={{ top: -1 }}>
          <Moon size={10} className="text-slate-600"/>
        </span>
      </div>
    </div>
  )
}

// ── Vote button ───────────────────────────────────────────────────────────────
function VoteButton({ dir, active, onClick }) {
  const [burst, setBurst] = useState(false)

  function handleClick() {
    setBurst(true)
    setTimeout(() => setBurst(false), 600)
    onClick()
  }

  const isUp = dir === 1
  const Icon = isUp ? ThumbsUp : ThumbsDown
  const activeColor = isUp ? 'text-green-400' : 'text-red-400'
  const activeBg    = isUp ? 'bg-green-400/15' : 'bg-red-400/15'
  const ringColor   = isUp ? 'border-green-400' : 'border-red-400'

  return (
    <button
      onClick={handleClick}
      className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-all select-none
        ${active ? `${activeBg} ${activeColor}` : 'text-slate-600 hover:text-slate-400'}
        ${burst ? 'scale-125' : active ? 'scale-110' : 'scale-100'}`}
      style={{ transition: burst ? 'transform 0.1s ease-out' : 'transform 0.3s ease' }}
    >
      <Icon size={14} strokeWidth={active ? 2.5 : 1.5}/>
      {burst && (
        <span className={`absolute inset-0 rounded-lg border-2 ${ringColor} animate-ping opacity-60`}/>
      )}
    </button>
  )
}

// ── Terrace card ──────────────────────────────────────────────────────────────
function TerraceCard({ terrace, isFav, onToggleFav, userVote, onVote, coords }) {
  const { id, name, address, amenity_type, street_orientation, scores, outdoor_type } = terrace
  const best = scores?.best_time ?? 'now'
  const altitude = scores?.[best]?.sun_altitude
  const isRooftop = outdoor_type === 'rooftop'
  const dayScore = scores?.day_score ?? null

  return (
    <div className={`${GLASS} rounded-2xl p-4 space-y-3`}>
      <div className="flex items-start gap-2">
        {/* Day score badge */}
        <DayScoreBadge score={dayScore}/>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-white font-medium leading-tight truncate">{name}</span>
            {isRooftop && (
              <span className="text-amber-400 text-[10px] font-medium tracking-wide shrink-0">ROOFTOP</span>
            )}
          </div>
          {address && <div className="text-slate-400 text-xs mt-0.5 truncate">{address}</div>}
          <div className="text-slate-500 text-xs mt-0.5">{amenityLabel(amenity_type)}</div>
        </div>
        {/* Star + vote buttons stacked */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <button onClick={() => onToggleFav(id)}
            className="text-lg leading-none transition-opacity"
            style={{ opacity: isFav ? 1 : 0.3 }}>
            {isFav ? '★' : '☆'}
          </button>
          <VoteButton dir={1}  active={userVote === 1}  onClick={() => onVote(id, 1)}  />
          <VoteButton dir={-1} active={userVote === -1} onClick={() => onVote(id, -1)} />
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-500">
        {altitude != null && altitude > 0 && (
          <span className="flex items-center gap-0.5">
            <TriangleRight size={10}/>
            <span>{Math.round(altitude)}°</span>
          </span>
        )}
        <ArcChip arcFrom={terrace.sun_arc_from} arcTo={terrace.sun_arc_to} orientation={street_orientation}/>
        <WeatherChip weatherScore={scores?.now?.weather_score} />
      </div>
      <SunTimeline scores={scores} coords={coords}/>
    </div>
  )
}

// ── Add venue form ────────────────────────────────────────────────────────────
const TYPE_OPTIONS = [
  { value: 'cafe',       label: 'Café' },
  { value: 'bar',        label: 'Bar' },
  { value: 'pub',        label: 'Pub' },
  { value: 'restaurant', label: 'Restaurang' },
]

function AddVenueForm({ coords, onSaved, onCancel }) {
  const [name, setName]     = useState('')
  const [type, setType]     = useState('restaurant')
  const [saving, setSaving] = useState(false)
  const [done, setDone]     = useState(false)
  const [error, setError]   = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true); setError(null)
    try {
      await createTerrace({
        name: name.trim(),
        lat: coords?.lat ?? 57.7089,
        lon: coords?.lon ?? 11.9746,
        amenity_type: type,
      })
      setDone(true)
      setTimeout(onSaved, 1800)
    } catch (err) {
      setError('Kunde inte spara – försök igen')
    } finally {
      setSaving(false)
    }
  }

  if (done) return (
    <div className={`${GLASS} rounded-2xl p-5 text-center space-y-2`}>
      <div className="text-2xl">🙌</div>
      <p className="text-white font-medium text-sm">Tack! Stället är tillagt.</p>
      <p className="text-slate-400 text-xs">Det dyker upp i listan efter ett ögonblick.</p>
    </div>
  )

  return (
    <div className={`${GLASS} rounded-2xl p-4 space-y-3`}>
      <div className="flex items-center justify-between">
        <p className="text-white text-sm font-medium">Lägg till ställe</p>
        <button onClick={onCancel} className="text-slate-500 text-xs hover:text-slate-300">✕</button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          required
          value={name} onChange={e => setName(e.target.value)}
          placeholder="Ställets namn…"
          className="w-full bg-black/30 text-white text-sm rounded-xl px-3 py-2 border border-white/10 placeholder-slate-500 focus:outline-none focus:border-white/30"
        />
        <div className="flex gap-1.5 flex-wrap">
          {TYPE_OPTIONS.map(o => (
            <button type="button" key={o.value} onClick={() => setType(o.value)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                type === o.value ? 'bg-white/20 text-white ring-1 ring-white/30' : 'bg-black/20 text-slate-500'
              }`}>
              {o.label}
            </button>
          ))}
        </div>
        {coords && (
          <p className="text-slate-500 text-xs">
            📍 Position sätts från din nuvarande plats ({coords.lat.toFixed(4)}, {coords.lon.toFixed(4)})
          </p>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button type="submit" disabled={saving || !name.trim()}
          className="w-full py-2 rounded-xl text-sm font-medium bg-white/15 text-white disabled:opacity-40 transition-colors active:bg-white/25">
          {saving ? 'Sparar…' : 'Skicka in'}
        </button>
      </form>
    </div>
  )
}

// ── Votes localStorage ────────────────────────────────────────────────────────
const VOTES_KEY = 'sol_votes'
function loadVotes() { try { return JSON.parse(localStorage.getItem(VOTES_KEY) || '{}') } catch { return {} } }
function saveVotes(obj) { localStorage.setItem(VOTES_KEY, JSON.stringify(obj)) }

// ── Favourites ────────────────────────────────────────────────────────────────
const FAVS_KEY = 'sol_favourites'
function loadFavs() { try { return new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]')) } catch { return new Set() } }
function saveFavs(set) { localStorage.setItem(FAVS_KEY, JSON.stringify([...set])) }

// ── Main view ─────────────────────────────────────────────────────────────────
export default function SolView({ coords }) {
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [selectedTypes, setSelectedTypes] = useState(new Set(ALL_TYPES))
  const [radius, setRadius]       = useState(2.0)
  const [debouncedRadius, setDebouncedRadius] = useState(2.0)
  const [favs, setFavs]           = useState(loadFavs)
  const [votes, setVotes]         = useState(loadVotes)
  const [showAdd, setShowAdd]     = useState(false)
  const [mode, setMode]           = useState('sol')
  const [search, setSearch]       = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceRef = useRef(null)
  const radiusRef   = useRef(null)

  const toggleFav = useCallback((id) => {
    setFavs(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      saveFavs(next)
      return next
    })
  }, [])

  const handleVote = useCallback((id, dir) => {
    setVotes(prev => {
      // Toggle: clicking same direction again removes the vote
      const next = { ...prev, [id]: prev[id] === dir ? 0 : dir }
      saveVotes(next)
      return next
    })
    // Fire-and-forget to backend (include user location if available)
    const lat = coords?.lat ?? null
    const lon = coords?.lon ?? null
    voteTerrrace(id, dir, lat, lon).catch(() => {})
  }, [coords])

  function toggleType(t) {
    setSelectedTypes(prev => {
      const next = new Set(prev)
      if (next.has(t)) {
        if (next.size === 1) return prev   // keep at least one
        next.delete(t)
      } else {
        next.add(t)
      }
      return next
    })
  }

  // Debounce search
  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(debounceRef.current)
  }, [search])

  // Debounce radius
  useEffect(() => {
    clearTimeout(radiusRef.current)
    radiusRef.current = setTimeout(() => setDebouncedRadius(radius), 500)
    return () => clearTimeout(radiusRef.current)
  }, [radius])

  const typeParam = selectedTypes.size === ALL_TYPES.length
    ? 'all'
    : [...selectedTypes].join(',')

  useEffect(() => {
    if (!coords && !debouncedSearch) return
    setLoading(true)
    setError(null)
    fetchSunTerraces({
      lat:    coords?.lat ?? 57.7089,
      lon:    coords?.lon ?? 11.9746,
      radius: debouncedRadius,
      type:   typeParam,
      name:   debouncedSearch,
    })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [coords, typeParam, debouncedRadius, debouncedSearch])

  const sortedData = data ? [...data].sort((a, b) => {
    const favDiff = (favs.has(b.id) ? 1 : 0) - (favs.has(a.id) ? 1 : 0)
    if (favDiff !== 0) return favDiff
    return mode === 'skugga'
      ? (a.best_score ?? 0) - (b.best_score ?? 0)
      : (b.best_score ?? 0) - (a.best_score ?? 0)
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

      {/* Search */}
      <input type="search" placeholder="Sök ställe…" value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full bg-black/20 text-white text-sm rounded-xl px-3 py-2 border border-white/10 placeholder-slate-500 focus:outline-none focus:border-white/30"
      />

      {/* Add venue */}
      {showAdd
        ? <AddVenueForm coords={coords} onSaved={() => setShowAdd(false)} onCancel={() => setShowAdd(false)} />
        : <button onClick={() => setShowAdd(true)}
            className="w-full py-1.5 rounded-xl text-xs text-slate-500 hover:text-slate-300 bg-black/10 border border-white/5 transition-colors">
            + Saknas ett ställe?
          </button>
      }

      {/* Filter bar: Sol/Skugga | type toggles */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {[{m:'sol', Icon:Sun}, {m:'skugga', Icon:Parasol}].map(({m, Icon}) => (
          <button key={m} onClick={() => setMode(m)}
            className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${
              mode === m ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-400'
            }`}>
            <Icon size={15}/>
          </button>
        ))}
        <div className="w-px h-5 bg-slate-700 shrink-0"/>
        {ALL_TYPES.map(t => (
          <button key={t} onClick={() => toggleType(t)}
            className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              selectedTypes.has(t)
                ? 'bg-white/20 text-white ring-1 ring-white/30'
                : 'bg-black/20 text-slate-500'
            }`}>
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Distance slider */}
      <div className="flex items-center gap-3 px-0.5">
        <span className="text-slate-500 text-xs shrink-0">Avstånd</span>
        <input type="range" min="0.5" max="10" step="0.5" value={radius}
          onChange={e => setRadius(parseFloat(e.target.value))}
          className="flex-1 accent-white/50 h-1"
        />
        <span className="text-slate-400 text-xs shrink-0 w-12 text-right">{radius} km</span>
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
      {!coords && !loading && !debouncedSearch && (
        <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm`}>
          Aktivera platstjänster för att hitta uteserveringar nära dig.
        </div>
      )}

      {/* Results */}
      {!loading && data && data.length === 0 && (
        <div className={`${GLASS} rounded-2xl p-8 flex flex-col items-center gap-3 text-center`}>
          <span className="text-3xl">☀️</span>
          <p className="text-white font-medium">Inga träffar</p>
          <p className="text-slate-500 text-sm">Prova ett annat filter eller öka avståndet.</p>
        </div>
      )}

      {!loading && data && data.length > 0 && (
        <>
          <p className="text-slate-500 text-xs px-1">
            {data.length} uteserveringar{debouncedSearch ? '' : ` inom ${debouncedRadius} km`}
          </p>
          {sortedData.map(t => (
            <TerraceCard key={t.id} terrace={t}
              isFav={favs.has(t.id)} onToggleFav={toggleFav}
              userVote={votes[t.id] ?? 0} onVote={handleVote}
              coords={coords}/>
          ))}
          <p className="text-white/30 text-xs px-1 pt-1">
            Data från OpenStreetMap · Solberäkning uppdateras löpande
          </p>
        </>
      )}
    </div>
  )
}
