import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchSunTerraces, fetchHashtags, addHashtag, removeHashtag, reportTerrace, createTerrace, fetchUV } from '../api'
import { TerraceListSkeleton } from './Skeleton'
import { sunTimesUTC } from '../weatherSymbol'
import { Moon, Sun, Parasol, MessageCircleWarning, Cloud, CloudRain, TriangleRight, Spline, Hash, Martini, Beer, Coffee, Utensils, AlarmClock } from 'lucide-react'

const GLASS = 'bg-black/20 backdrop-blur-sm border border-white/10'

const _HT_KEY = 'sol_hashtags_v1'
const _HT_TTL = 3600 * 1000  // 1 hour
function _loadCachedHashtags() {
  try { const { ts, d } = JSON.parse(localStorage.getItem(_HT_KEY) || '{}'); if (d && Date.now() - ts < _HT_TTL) return d } catch {}
  return null
}
function _saveHashtagsCache(data) {
  try { localStorage.setItem(_HT_KEY, JSON.stringify({ ts: Date.now(), d: data })) } catch {}
}

function UVChip({ uv }) {
  const val = Math.round(uv)
  const [color, label] =
    val >= 11 ? ['#a855f7', 'Extrem'] :
    val >= 8  ? ['#ef4444', 'Mycket hög'] :
    val >= 6  ? ['#f97316', 'Hög'] :
    val >= 3  ? ['#eab308', 'Måttlig'] :
               ['#22c55e', 'Låg']
  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0">
      <Sun size={20} strokeWidth={2} style={{ color }} />
      <span className="text-xs font-bold leading-none" style={{ color }}>UV {val}</span>
      <span className="text-[10px] leading-none" style={{ color, opacity: 0.8 }}>{label}</span>
    </div>
  )
}

const ALL_TYPES = ['cafe', 'bar', 'pub', 'restaurant']
const TYPE_LABELS = { cafe: 'Kafé', bar: 'Bar', pub: 'Pub', restaurant: 'Restaurang' }

// ── Sun dots ──────────────────────────────────────────────────────────────────
function SunDots({ score }) {
  const filled = score >= 70 ? 4 : score >= 45 ? 3 : score >= 20 ? 2 : score > 0 ? 1 : 0
  const color  = score >= 70 ? '#fde047' : score >= 45 ? '#eab308' : score >= 20 ? '#334155' : '#1e293b'
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
  if (s >= 75) return '#fde047'
  if (s >= 50) return '#eab308'
  if (s >= 25) return '#ca8a04'
  if (s > 0)   return '#334155'
  return '#1e293b'
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

const VENUE_ICONS = { bar: Martini, pub: Beer, cafe: Coffee, restaurant: Utensils }

function VenueTypeIcon({ type }) {
  const Icon = VENUE_ICONS[type]
  if (!Icon) return null
  return <Icon size={13} className="text-slate-400 shrink-0" strokeWidth={1.5}/>
}

function scoreToColor(score) {
  if (score <= 0)  return '#1e293b'   // ingen sol — mörk slate
  if (score < 25)  return '#334155'   // svag sol — slate-blå
  if (score < 50)  return '#ca8a04'   // måttlig sol — mörk guld
  if (score < 75)  return '#eab308'   // bra sol — gul-guld
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

  // Use gradient from backend — sampled every 30 min from now to sunset.
  // Falls back to 3-point estimation if not present.
  const pts = scores?.gradient
  const gradient = (() => {
    if (pts && pts.length > 0) {
      const stops = pts.map(p => `${scoreToColor(p.score)} ${(p.frac * 100).toFixed(1)}%`)
      return stops.join(', ')
    }
    // Legacy fallback
    const s0 = scores?.now?.orientation_score ?? 0
    const s1 = scores?.['1h']?.orientation_score ?? 0
    const s2 = scores?.['2h']?.orientation_score ?? 0
    const p1 = Math.min(100, (1 / hoursToSunset) * 100)
    const p2 = Math.min(100, (2 / hoursToSunset) * 100)
    return [
      `${scoreToColor(s0)} 0%`,
      `${scoreToColor(s1)} ${p1.toFixed(1)}%`,
      `${scoreToColor(s2)} ${p2.toFixed(1)}%`,
      `#1e293b 100%`,
    ].join(', ')
  })()

  // Dynamic time markers
  const step = markerStep(hoursToSunset)
  const markers = []
  const pct = h => Math.min(100, (h / hoursToSunset) * 100)
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
        <span className="absolute left-0 leading-none" style={{ top: -1 }}>
          {scores?.gradient_is_upcoming
            ? <Sun size={10} className="text-slate-500"/>
            : <span className="text-[9px] text-slate-500">Nu</span>}
        </span>
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

// ── Feedback dialog (thumbs-down) ────────────────────────────────────────────

const ISSUES = [
  { id: 'no_outdoor',    label: 'Har ingen uteplats' },
  { id: 'has_outdoor',   label: 'Har uteplats (felaktigt utan)' },
  { id: 'wrong_sun',     label: 'Felaktigt solläge' },
  { id: 'wrong_forecast',label: 'Felaktig solprognos' },
  { id: 'wrong_name',    label: 'Felaktigt namn' },
  { id: 'wrong_address', label: 'Fel adress' },
  { id: 'wrong_location',label: 'Fel position på kartan' },
  { id: 'wrong_type',    label: 'Fel typ (café/bar/restaurang)' },
  { id: 'closed',        label: 'Stängt / finns inte längre' },
]

function FeedbackDialog({ venueName, onSubmit, onDismiss, onClose }) {
  const [selected, setSelected] = useState(new Set())
  const [comment,  setComment]  = useState('')

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleSubmit() {
    onSubmit({ issues: [...selected], comment: comment.trim() })
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end"
         style={{ background: 'rgba(0,0,0,0.6)' }}
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full bg-slate-800 rounded-t-2xl flex flex-col"
           style={{ maxHeight: '85vh' }}>
        {/* Header — always visible */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2 flex-shrink-0">
          <div>
            <p className="text-white font-semibold text-sm">Vad stämmer inte?</p>
            <p className="text-slate-400 text-xs mt-0.5 truncate max-w-[260px]">{venueName}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none pl-4">✕</button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 pb-3 space-y-3">
          {/* 2-column checkbox grid */}
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            {ISSUES.map(issue => (
              <label key={issue.id}
                className="flex items-center gap-2 py-1.5 px-2 rounded-lg active:bg-white/5 cursor-pointer">
                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                  selected.has(issue.id) ? 'bg-red-500 border-red-500' : 'border-slate-600'
                }`}>
                  {selected.has(issue.id) && (
                    <span className="text-white font-bold leading-none" style={{fontSize:9}}>✓</span>
                  )}
                </div>
                <input type="checkbox" className="sr-only"
                  checked={selected.has(issue.id)} onChange={() => toggle(issue.id)}/>
                <span className="text-slate-300 text-xs leading-tight">{issue.label}</span>
              </label>
            ))}
          </div>

          <textarea
            value={comment} onChange={e => setComment(e.target.value)}
            rows={2} placeholder="Övrig kommentar (valfritt)..."
            className="w-full bg-black/30 text-white text-sm rounded-xl px-3 py-2 border border-white/10 placeholder-slate-600 focus:outline-none focus:border-white/30 resize-none"
          />
        </div>

        {/* Buttons — always visible at bottom */}
        <div className="flex gap-2 px-5 py-4 flex-shrink-0 border-t border-slate-700/50">
          <button onClick={handleSubmit}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors">
            Skicka feedback
          </button>
          <button onClick={onDismiss}
            className="px-5 py-2.5 rounded-xl text-sm bg-slate-700 text-slate-300">
            Hoppa över
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Report button ─────────────────────────────────────────────────────────────
function ReportButton({ active, onReport, terraceName }) {
  const [burst, setBurst] = useState(false)
  const [showDialog, setShowDialog] = useState(false)

  function handleClick() {
    setBurst(true)
    setTimeout(() => setBurst(false), 600)
    setTimeout(() => setShowDialog(true), 650)
  }

  function handleFeedback(feedback) {
    setShowDialog(false)
    onReport(feedback)        // submit with details → icon lights up
  }

  function handleDismiss() {
    setShowDialog(false)
    onReport(null)            // "Hoppa över": submit minimal report → icon lights up
  }

  function handleClose() {
    setShowDialog(false)      // ✕: close without reporting → icon stays dark
  }

  return (
    <>
      <button
        onClick={handleClick}
        className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-all select-none
          ${active ? 'bg-orange-400/15 text-orange-400' : 'text-slate-600 hover:text-slate-400'}
          ${burst ? 'scale-125' : active ? 'scale-110' : 'scale-100'}`}
        style={{ transition: burst ? 'transform 0.1s ease-out' : 'transform 0.3s ease' }}
      >
        <MessageCircleWarning size={14} strokeWidth={active ? 2.5 : 1.5}/>
        {burst && (
          <span className="absolute inset-0 rounded-lg border-2 border-orange-400 animate-ping opacity-60"/>
        )}
      </button>
      {showDialog && (
        <FeedbackDialog
          venueName={terraceName}
          onSubmit={handleFeedback}
          onDismiss={handleDismiss}
          onClose={handleClose}
        />
      )}
    </>
  )
}

// ── Hashtag localStorage ──────────────────────────────────────────────────────
const HASHTAGS_KEY = 'sol_hashtags'
function loadUserHashtags() {
  try { return JSON.parse(localStorage.getItem(HASHTAGS_KEY) || '{}') } catch { return {} }
}
function saveUserHashtags(obj) { localStorage.setItem(HASHTAGS_KEY, JSON.stringify(obj)) }

// ── Hashtag popup ─────────────────────────────────────────────────────────────
function HashtagPopup({ terrace, allHashtags, onClose, onHashtagsChange }) {
  const terraceId = terrace.id
  const [localHashtags, setLocalHashtags] = useState(terrace.hashtags || [])
  const userAdded = loadUserHashtags()[terraceId] || []

  const existingIds = new Set(localHashtags.map(h => h.id))
  const available = allHashtags.filter(h => !existingIds.has(h.id))

  async function handleAdd(hashtagId) {
    try {
      await addHashtag(terraceId, hashtagId)
      // Track in localStorage
      const ua = loadUserHashtags()
      ua[terraceId] = [...(ua[terraceId] || []), hashtagId]
      saveUserHashtags(ua)
      // Update local state
      const tag = allHashtags.find(h => h.id === hashtagId)
      if (tag) {
        const updated = [...localHashtags, { id: tag.id, name: tag.name, count: 1 }]
          .sort((a, b) => b.count - a.count)
        setLocalHashtags(updated)
        onHashtagsChange(terraceId, updated)
      }
    } catch (e) {
      console.error(e)
    }
  }

  async function handleRemove(hashtagId) {
    const ua = loadUserHashtags()
    const userAddedThis = (ua[terraceId] || []).includes(hashtagId)
    if (!userAddedThis) return  // Can only remove own additions
    try {
      await removeHashtag(terraceId, hashtagId)
      // Update localStorage
      ua[terraceId] = (ua[terraceId] || []).filter(id => id !== hashtagId)
      saveUserHashtags(ua)
      // Update local state
      const updated = localHashtags
        .map(h => h.id === hashtagId ? { ...h, count: h.count - 1 } : h)
        .filter(h => h.count > 0)
        .sort((a, b) => b.count - a.count)
      setLocalHashtags(updated)
      onHashtagsChange(terraceId, updated)
    } catch (e) {
      console.error(e)
    }
  }

  const currentUserAdded = loadUserHashtags()[terraceId] || []

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end"
         style={{ background: 'rgba(0,0,0,0.6)' }}
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full bg-slate-800 rounded-t-2xl flex flex-col"
           style={{ maxHeight: '85vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2 flex-shrink-0">
          <div>
            <p className="text-white font-semibold text-sm">Taggar</p>
            <p className="text-slate-400 text-xs mt-0.5 truncate max-w-[260px]">{terrace.name}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none pl-4">✕</button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-4">
          {localHashtags.length > 0 && (
            <div>
              <p className="text-slate-500 text-xs mb-2 font-medium">Valda</p>
              <div className="flex flex-wrap gap-2">
                {localHashtags.map(h => {
                  const canRemove = currentUserAdded.includes(h.id)
                  return (
                    <button key={h.id}
                      onClick={() => canRemove && handleRemove(h.id)}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium transition-colors
                        bg-amber-500/20 text-amber-300 border border-amber-500/40
                        ${canRemove ? 'active:bg-amber-500/30 cursor-pointer' : 'cursor-default opacity-80'}`}>
                      <Hash size={10}/>
                      <span>{h.name}</span>
                      <span className="ml-0.5 text-amber-400/70">{h.count}</span>
                      {canRemove && <span className="ml-0.5 text-amber-400/50 text-[10px]">✕</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {available.length > 0 && (
            <div>
              <p className="text-slate-500 text-xs mb-2 font-medium">Lägg till</p>
              <div className="flex flex-wrap gap-2">
                {available.map(h => (
                  <button key={h.id}
                    onClick={() => handleAdd(h.id)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium transition-colors
                      bg-black/20 text-slate-400 border border-slate-700 active:bg-white/10 hover:border-slate-500">
                    <Hash size={10}/>
                    <span>{h.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {localHashtags.length === 0 && available.length === 0 && (
            <p className="text-slate-500 text-sm text-center py-4">Inga taggar tillgängliga</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Hashtag button ────────────────────────────────────────────────────────────
function HashtagButton({ terrace, allHashtags, onHashtagsChange }) {
  const [showPopup, setShowPopup] = useState(false)
  const userAdded = (loadUserHashtags()[terrace.id] || []).length > 0

  return (
    <>
      <button
        onClick={() => setShowPopup(true)}
        className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-all select-none
          ${userAdded ? 'bg-amber-500/15 text-amber-400' : 'text-slate-600 hover:text-slate-400'}`}
      >
        <Hash size={14} strokeWidth={2.5}/>
      </button>
      {showPopup && (
        <HashtagPopup
          terrace={terrace}
          allHashtags={allHashtags}
          onClose={() => setShowPopup(false)}
          onHashtagsChange={onHashtagsChange}
        />
      )}
    </>
  )
}

// ── Terrace card ──────────────────────────────────────────────────────────────
function TerraceCard({ terrace, isFav, onToggleFav, userVote, onVote, coords, allHashtags, onHashtagsChange }) {
  const { id, name, address, amenity_type, street_orientation, scores, outdoor_type } = terrace
  const best = scores?.best_time ?? 'now'
  const altitude = scores?.[best]?.sun_altitude
  const isRooftop = outdoor_type === 'rooftop'
  const dayScore = scores?.day_score ?? null
  const isOpen = terrace.is_open_now  // true/false/null

  return (
    <div className={`${GLASS} rounded-2xl p-4 space-y-3`}>
      <div className="flex items-start gap-2">
        {/* Day score badge */}
        <DayScoreBadge score={dayScore}/>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-white font-medium leading-tight truncate">{name}</span>
            <VenueTypeIcon type={amenity_type}/>
            {isRooftop && (
              <span className="text-amber-400 text-[10px] font-medium tracking-wide shrink-0">ROOFTOP</span>
            )}
            {isOpen === false && (
              <span className="text-slate-500 text-[10px] font-medium tracking-wide shrink-0 bg-slate-700/60 px-1 py-0.5 rounded">
                STÄNGT
                {terrace.opening_hours_today ? ` · ${terrace.opening_hours_today}` : ''}
              </span>
            )}
          </div>
          {address && <div className="text-slate-400 text-xs mt-0.5 truncate">{address}</div>}
        </div>
        {/* Star + report + hashtag buttons */}
        <div className="flex flex-col items-center gap-1.5 shrink-0">
          <button onClick={() => onToggleFav(id)}
            className={`text-lg leading-none transition-all ${
              isFav ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'
            }`}>
            ☆
          </button>
          <ReportButton
            active={userVote === -1}
            onReport={fb => onVote(id, fb)}
            terraceName={name}
          />
          <HashtagButton
            terrace={terrace}
            allHashtags={allHashtags}
            onHashtagsChange={onHashtagsChange}
          />
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-500">
        {false && altitude != null && altitude > 0 && (
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

// ── Radius + time-pref localStorage ──────────────────────────────────────────
const RADIUS_KEY     = 'sol_radius'
const TAG_FILTER_KEY = 'sol_tag_filter_v1'
function loadSavedRadius()   { try { return parseFloat(localStorage.getItem(RADIUS_KEY)) || 2.0 } catch { return 2.0 } }
function loadSavedTimePref() { try { return new Set(JSON.parse(localStorage.getItem(TAG_FILTER_KEY) || '[]')) } catch { return new Set() } }

// ── Votes localStorage ────────────────────────────────────────────────────────
const VOTES_KEY = 'sol_votes'
function loadVotes() { try { return JSON.parse(localStorage.getItem(VOTES_KEY) || '{}') } catch { return {} } }
function saveVotes(obj) { localStorage.setItem(VOTES_KEY, JSON.stringify(obj)) }

// ── Favourites ────────────────────────────────────────────────────────────────
const FAVS_KEY      = 'sol_favourites'
const FAV_DATA_KEY  = 'sol_favourites_data'
function loadFavs()     { try { return new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]')) } catch { return new Set() } }
function saveFavs(set)  { localStorage.setItem(FAVS_KEY, JSON.stringify([...set])) }
function loadFavData()  { try { return JSON.parse(localStorage.getItem(FAV_DATA_KEY) || '{}') } catch { return {} } }
function saveFavData(id, terrace) {
  const d = loadFavData(); d[id] = { id, name: terrace.name, amenity_type: terrace.amenity_type }
  localStorage.setItem(FAV_DATA_KEY, JSON.stringify(d))
}
function removeFavData(id) {
  const d = loadFavData(); delete d[id]
  localStorage.setItem(FAV_DATA_KEY, JSON.stringify(d))
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function SolView({ coords, initialData }) {
  const [data, setData]           = useState(initialData ?? null)
  const [loading, setLoading]     = useState(false)
  const skipFirstFetch            = useRef(false)
  const [error, setError]         = useState(null)
  const [selectedTypes, setSelectedTypes] = useState(new Set(ALL_TYPES))
  const [radius, setRadius]       = useState(loadSavedRadius)
  const [debouncedRadius, setDebouncedRadius] = useState(loadSavedRadius)
  const [favs, setFavs]           = useState(loadFavs)
  const [votes, setVotes]         = useState(loadVotes)
  const [showAdd, setShowAdd]     = useState(false)
  const [mode, setMode]           = useState('sol')
  const [search, setSearch]       = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [allHashtags, setAllHashtags] = useState([])
  const [tagFilter, setTagFilter] = useState(loadSavedTimePref)
  const [uvIndex, setUvIndex]     = useState(null)
  const [favOnly, setFavOnly]       = useState(false)

  // Sunrise / sunset for header
  const _now = new Date()
  const _lat = coords?.lat ?? 57.706
  const _lon = coords?.lon ?? 11.967
  const { sunrise: _srUTC, sunset: _ssUTC } = sunTimesUTC(_now, _lat, _lon)
  const _tz  = -_now.getTimezoneOffset() / 60
  const _fmtSun = (h) => { const hh = Math.floor(((h % 24) + 24) % 24); const mm = Math.round((h % 1) * 60); return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}` }
  const srStr = _fmtSun(_srUTC + _tz)
  const ssStr = _fmtSun(_ssUTC + _tz)
  const [showClosed, setShowClosed] = useState(false)
  const [rooftopOnly, setRooftopOnly] = useState(false)
  useEffect(() => { if (favs.size === 0) setFavOnly(false) }, [favs.size])
  const debounceRef = useRef(null)
  const radiusRef   = useRef(null)

  const toggleFav = useCallback((id, terrace) => {
    setFavs(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id); removeFavData(id) }
      else              { next.add(id);    saveFavData(id, terrace) }
      saveFavs(next)
      return next
    })
  }, [])

  const handleVote = useCallback((id, feedback = null) => {
    setVotes(prev => {
      // Toggle: clicking again removes the report indicator
      const next = { ...prev, [id]: prev[id] === -1 ? 0 : -1 }
      saveVotes(next)
      return next
    })
    const lat = coords?.lat ?? null
    const lon = coords?.lon ?? null
    reportTerrace(id, lat, lon, feedback).catch(() => {})
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

  function toggleTagFilter(tagName) {
    setTagFilter(prev => {
      const next = new Set(prev)
      next.has(tagName) ? next.delete(tagName) : next.add(tagName)
      return next
    })
  }

  // Fetch all hashtags once on mount (localStorage-cached for 1 hour)
  useEffect(() => {
    const cached = _loadCachedHashtags()
    if (cached) { setAllHashtags(cached); return }
    fetchHashtags().then(data => { setAllHashtags(data); _saveHashtagsCache(data) }).catch(() => {})
  }, [])

  useEffect(() => {
    fetchUV({ lat: coords?.lat, lon: coords?.lon })
      .then(d => setUvIndex(d.current))
      .catch(() => {})
  }, [coords?.lat, coords?.lon])

  // Update hashtags for a specific terrace in local data (after add/remove)
  const handleHashtagsChange = useCallback((terraceId, updatedHashtags) => {
    setData(prev => prev
      ? prev.map(t => t.id === terraceId ? { ...t, hashtags: updatedHashtags } : t)
      : prev
    )
  }, [])

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

  const tagsParam = tagFilter.size > 0 ? [...tagFilter].join(',') : ''

  useEffect(() => {
    if (skipFirstFetch.current) { skipFirstFetch.current = false; return }
    if (!data) setLoading(true)
    setError(null)
    const lat = coords?.lat ?? 57.7089
    const lon = coords?.lon ?? 11.9746
    console.log('[SolView] fetch', { lat, lon, radius: debouncedRadius, type: typeParam })
    fetchSunTerraces({
      lat,
      lon,
      radius:    debouncedRadius,
      type:      typeParam,
      name:      debouncedSearch,
      tags:      tagsParam,
      min_score: debouncedSearch ? 0 : 25,
    })
      .then(d => { console.log('[SolView] got', d?.length, 'venues'); setData(d) })
      .catch(e => { console.log('[SolView] error', e.message); setError(e.message) })
      .finally(() => setLoading(false))
  }, [coords, typeParam, debouncedRadius, debouncedSearch, tagsParam])

  const sortedData = data ? [...data]
    .filter(t => !favOnly || favs.has(t.id))
    .filter(t => showClosed || t.is_open_now !== false)
    .filter(t => !rooftopOnly || t.outdoor_type === 'rooftop')
    .sort((a, b) => mode === 'skugga'
      ? (a.day_score ?? 0) - (b.day_score ?? 0)
      : (b.day_score ?? 0) - (a.day_score ?? 0)
    ) : []

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="px-1 flex items-start justify-between">
        <div>
          <h1 className="text-white font-semibold text-lg">Solsökaren</h1>
          <p className="text-slate-400 text-xs mt-0.5">
            {mode === 'sol' ? 'Uteserveringar med bäst solläge just nu' : 'Uteserveringar i skugga just nu'}
          </p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {uvIndex != null && <UVChip uv={uvIndex} />}
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1">
              <Sun size={11} className="text-amber-300 shrink-0" />
              <span className="text-amber-300 text-xs">{srStr}</span>
            </div>
            <div className="flex items-center gap-1">
              <Moon size={11} className="text-slate-400 shrink-0" />
              <span className="text-slate-400 text-xs">{ssStr}</span>
            </div>
          </div>
        </div>
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

      {/* Filter row 1: läge/villkor */}
      <div className="flex items-center gap-1.5">
        {[{m:'sol', Icon:Sun}, {m:'skugga', Icon:Parasol}].map(({m, Icon}) => (
          <button key={m} onClick={() => setMode(m)}
            className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
              mode === m ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-400'
            }`}>
            <Icon size={16}/>
          </button>
        ))}
        <div className="w-px h-5 bg-slate-700 shrink-0"/>
        <button onClick={() => setShowClosed(v => !v)}
          title={showClosed ? 'Visar stängda venues — klicka för att dölja' : 'Döljer stängda venues — klicka för att visa'}
          className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
            showClosed ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-400'
          }`}>
          <AlarmClock size={16} strokeWidth={1.5}/>
        </button>
        <div className="w-px h-5 bg-slate-700 shrink-0"/>
        <button onPointerUp={() => { if (favs.size > 0) setFavOnly(v => !v) }}
          className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-colors touch-manipulation select-none ${
            favOnly ? 'bg-amber-500/20 text-amber-400' : favs.size > 0 ? 'bg-black/20 text-slate-400' : 'bg-black/20 text-slate-700'
          }`}
        >★</button>
        <button onClick={() => setRooftopOnly(v => !v)}
          className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-colors leading-none ${
            rooftopOnly ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-400'
          }`}>
          <span className="text-[8px] font-semibold text-center leading-tight">ROOF<br/>TOP</span>
        </button>
      </div>

      {/* Filter row 2: typ */}
      <div className="flex items-center gap-1.5">
        {ALL_TYPES.map(t => {
          const Icon = VENUE_ICONS[t]
          return (
            <button key={t} onClick={() => toggleType(t)}
              className={`shrink-0 flex items-center gap-1.5 h-9 px-3 rounded-xl transition-colors ${
                selectedTypes.has(t)
                  ? 'bg-white/20 text-white ring-1 ring-white/30'
                  : 'bg-black/20 text-slate-500'
              }`}>
              {Icon && <Icon size={14} strokeWidth={1.5}/>}
              <span className="text-xs">{TYPE_LABELS[t]}</span>
            </button>
          )
        })}
      </div>

      {/* Tag filter bar */}
      {allHashtags.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          <Hash size={13} className="text-slate-600 shrink-0"/>
          {allHashtags.map(h => (
            <button key={h.id} onClick={() => toggleTagFilter(h.name)}
              className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                tagFilter.has(h.name)
                  ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40'
                  : 'bg-black/20 text-slate-500'
              }`}>
              {h.name}
            </button>
          ))}
        </div>
      )}

      {/* Distance slider */}
      <div className="flex items-center gap-3 px-0.5">
        <span className="text-slate-500 text-xs shrink-0">Avstånd</span>
        <input type="range" min="0.5" max="10" step="0.5" value={radius}
          onChange={e => { const v = parseFloat(e.target.value); setRadius(v); localStorage.setItem(RADIUS_KEY, String(v)) }}
          className="sol-slider flex-1"
          style={{'--fill': `${(radius - 0.5) / 9.5 * 100}%`}}
        />
        <span className="text-slate-400 text-xs shrink-0 w-12 text-right">{radius} km</span>
      </div>

      {/* Loading — only shown when no data yet */}
      {loading && !data && <TerraceListSkeleton count={4} />}

      {/* Error */}
      {error && !data && (
        <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm space-y-3`}>
          <p>Kunde inte hämta uteserveringar.</p>
          <p className="text-xs text-slate-600 break-all">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchSunTerraces({ lat: coords?.lat ?? 57.7089, lon: coords?.lon ?? 11.9746, radius: debouncedRadius, type: typeParam, name: debouncedSearch, tags: tagsParam, min_score: 0 }).then(d => setData(d)).catch(e => setError(e.message)).finally(() => setLoading(false)) }}
            className="px-4 py-1.5 rounded-xl bg-white/10 text-white text-xs"
          >Försök igen</button>
        </div>
      )}

      {/* No coords */}
      {!coords && !data && !debouncedSearch && (
        <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm`}>
          Aktivera platstjänster för att hitta uteserveringar nära dig.
        </div>
      )}

      {/* Results */}
      {data && data.length === 0 && (
        <div className={`${GLASS} rounded-2xl p-8 flex flex-col items-center gap-3 text-center`}>
          <span className="text-3xl">☀️</span>
          <p className="text-white font-medium">Inga träffar inom {debouncedRadius} km</p>
          <p className="text-slate-500 text-sm">Prova ett större avstånd.</p>
          <div className="flex gap-2 flex-wrap justify-center">
            {[5, 10, 20].filter(r => r > debouncedRadius).map(r => (
              <button key={r} onClick={() => { setRadius(r); localStorage.setItem(RADIUS_KEY, String(r)) }}
                className="px-4 py-1.5 rounded-xl bg-white/10 text-white text-sm font-medium active:bg-white/20">
                {r} km
              </button>
            ))}
          </div>
        </div>
      )}

      {data && data.length > 0 && (
        <>
          <p className="text-slate-500 text-xs px-1">
            {data.length} uteserveringar{debouncedSearch ? '' : ` inom ${debouncedRadius} km`}
          </p>
          {sortedData.length === 0 && !showClosed && (
            <div className={`${GLASS} rounded-2xl p-5 text-center space-y-2`}>
              <p className="text-slate-400 text-sm">Alla uteserveringar är stängda just nu.</p>
              <button onClick={() => setShowClosed(true)}
                className="px-4 py-1.5 rounded-xl bg-white/10 text-white text-xs">
                Visa stängda
              </button>
            </div>
          )}
          {sortedData.map(t => (
            <TerraceCard key={t.id} terrace={t}
              isFav={favs.has(t.id)} onToggleFav={(id) => toggleFav(id, t)}
              userVote={votes[t.id] ?? 0} onVote={(id, fb) => handleVote(id, fb)}
              coords={coords}
              allHashtags={allHashtags}
              onHashtagsChange={handleHashtagsChange}/>
          ))}
          <p className="text-white/30 text-xs px-1 pt-1">
            Data från OpenStreetMap · Solberäkning uppdateras löpande
          </p>
        </>
      )}
    </div>
  )
}
