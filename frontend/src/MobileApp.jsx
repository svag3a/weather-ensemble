import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Thermometer, CalendarDays, Layers, TriangleAlert, Sparkles, Zap, Clock, TrendingUp, Lightbulb, ShieldCheck } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { fetchLocalForecast, fetchEnsemble, fetchRadarNow, fetchSources, fetchWeights, fetchWarnings, triggerCollect, fetchSummary, fetchCityImages } from './api'
import { getWeatherInfo, feelsLike, sunTimesUTC } from './weatherSymbol'
import WeatherSymbol from './components/WeatherSymbol'
import { generateSummary, summariseConfidence } from './summary'

// ── Hooks ────────────────────────────────────────────────────────────────────

function useReverseGeocode(coords) {
  const [location, setLocation] = useState(null)
  const lastCoords = useRef(null)

  useEffect(() => {
    if (!coords) return
    // Skip if coords haven't moved more than ~100 m
    if (lastCoords.current) {
      const dlat = Math.abs(coords.lat - lastCoords.current.lat)
      const dlon = Math.abs(coords.lon - lastCoords.current.lon)
      if (dlat < 0.001 && dlon < 0.001) return
    }
    lastCoords.current = coords

    fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lon}&format=json&accept-language=sv`,
      { headers: { 'Accept-Language': 'sv' } }
    )
      .then(r => r.json())
      .then(data => {
        const a = data.address ?? {}
        // city_district = official Göteborg stadsdel (Centrum, Majorna-Linné, …)
        // suburb        = more specific area within it (Otterhällan, Haga, …)
        const suburb = a.city_district || a.suburb || a.neighbourhood || a.quarter || null
        const place  = a.amenity || a.tourism || a.leisure
                     || (a.suburb !== suburb ? a.suburb : null)
                     || a.building || a.road || null
        if (suburb || place) setLocation({ suburb, place })
      })
      .catch(() => {})
  }, [coords])

  return location
}

function useRadarLocation() {
  const [radar, setRadar] = useState(null)
  const [coords, setCoords] = useState(null)
  const timerRef = useRef(null)

  const poll = useCallback(async (lat, lon) => {
    try { setRadar(await fetchRadarNow(lat, lon)) } catch {}
  }, [])

  useEffect(() => {
    const start = (lat, lon) => {
      setCoords({ lat, lon })
      poll(lat, lon)
      timerRef.current = setInterval(() => poll(lat, lon), 5 * 60 * 1000)
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => start(pos.coords.latitude, pos.coords.longitude),
        () => start(57.7089, 11.9746),
      )
    } else {
      start(57.7089, 11.9746)
    }
    return () => clearInterval(timerRef.current)
  }, [poll])

  return { radar, coords }
}

function currentTimeSlot() {
  const h = new Date().getHours()
  if (h < 6)  return 'night'
  if (h < 12) return 'morning'
  if (h < 18) return 'day'
  return 'evening'
}

function useCityBackground(coords) {
  const [images, setImages] = useState([])

  useEffect(() => {
    fetchCityImages().then(setImages).catch(() => {})
  }, [])

  if (!coords || !images.length) return null

  // Group images by label and find nearest location
  const groups = {}
  for (const img of images) {
    if (!groups[img.label]) groups[img.label] = { lat: img.lat, lon: img.lon, slots: {} }
    groups[img.label].slots[img.time_slot] = img
  }

  let nearestGroup = null
  let minDist = Infinity
  for (const g of Object.values(groups)) {
    const d = (g.lat - coords.lat) ** 2 + (g.lon - coords.lon) ** 2
    if (d < minDist) { minDist = d; nearestGroup = g }
  }
  if (!nearestGroup) return null

  // Pick image for current time slot, fall back to closest available slot
  const slot = currentTimeSlot()
  const FALLBACK_ORDER = ['day', 'morning', 'evening', 'night']
  const image = nearestGroup.slots[slot]
    ?? FALLBACK_ORDER.map(s => nearestGroup.slots[s]).find(Boolean)
    ?? null
  if (!image) return null
  // Return both image and the slot it actually came from (for filter compensation)
  return { ...image, actualSlot: image.time_slot ?? slot }
}

function useCityMotif(coords) {
  const [images, setImages] = useState([])
  useEffect(() => {
    fetchCityImages().then(imgs => setImages(imgs.filter(i => i.image_type === 'motif'))).catch(() => {})
  }, [])
  if (!coords || !images.length) return null
  let nearest = null, minDist = Infinity
  for (const img of images) {
    const d = (img.lat - coords.lat) ** 2 + (img.lon - coords.lon) ** 2
    if (d < minDist) { minDist = d; nearest = img }
  }
  return nearest
}

// How bright each slot's photo is relative to a neutral day photo.
// Used to compensate when a fallback slot is shown instead of the ideal one.
const SLOT_BASE_BRIGHTNESS = { night: 0.32, morning: 0.85, day: 1.00, evening: 0.72 }

// Build filter anchor points using today's actual sunrise/sunset so
// the curve shifts with the seasons (June midnight sun vs December darkness).
function buildFilterAnchors(now, lat = 57.706, lon = 11.967) {
  const { sunrise, sunset } = sunTimesUTC(now, lat, lon)
  const tz = -now.getTimezoneOffset() / 60          // local UTC offset in hours
  const sr   = (sunrise + tz + 24) % 24             // sunrise local
  const ss   = (sunset  + tz + 24) % 24             // sunset local
  const noon = (sr + ss) / 2                        // solar noon local
  // Midpoint of the night (between today's sunset and tomorrow's sunrise)
  const nightMid = ((ss + sr + 24) / 2 + 12) % 24  // guaranteed between ss and sr

  // [localHour, brightness, saturation, hueRotate, overlay]
  return [
    [ 0,        0.30, 0.50,  20, 'rgba(10,20,60,0.35)'   ],
    [ nightMid, 0.25, 0.45,  22, 'rgba(10,20,60,0.38)'   ],
    [ sr - 1,   0.42, 0.58,  10, 'rgba(20,30,80,0.22)'   ],
    [ sr,       0.70, 1.00, -20, 'rgba(180,100,30,0.15)' ],
    [ sr + 2,   0.90, 1.05,  -8, 'rgba(200,130,40,0.07)' ],
    [ noon - 1, 1.00, 1.10,   0, null                    ],
    [ noon,     1.05, 1.15,   0, null                    ],
    [ ss - 2,   0.95, 1.10,  -5, 'rgba(200,120,30,0.06)' ],
    [ ss - 1,   0.80, 1.00, -15, 'rgba(180,100,20,0.14)' ],
    [ ss,       0.65, 0.90,  -8, 'rgba(150,80,20,0.18)'  ],
    [ ss + 1,   0.52, 0.75,   5, 'rgba(30,20,60,0.20)'   ],
    [ ss + 2,   0.42, 0.65,  12, 'rgba(15,20,60,0.25)'   ],
    [ 24,       0.30, 0.50,  20, 'rgba(10,20,60,0.35)'   ],
  ]
    .filter(([h]) => h >= 0 && h <= 24)
    .sort((a, b) => a[0] - b[0])
    // Remove duplicates (can happen when sr/ss anchors overlap at extreme latitudes)
    .filter((a, i, arr) => i === 0 || Math.abs(a[0] - arr[i - 1][0]) > 0.1)
}

function getImageStyle(fc, imageSlot = 'day', coords = null) {
  const now  = new Date()
  const hour = now.getHours() + now.getMinutes() / 60
  const lat  = coords?.lat ?? 57.706
  const lon  = coords?.lon ?? 11.967
  const A    = buildFilterAnchors(now, lat, lon)

  // Interpolate between surrounding anchors
  let i = A.length - 2
  for (let j = 0; j < A.length - 1; j++) {
    if (hour >= A[j][0] && hour < A[j + 1][0]) { i = j; break }
  }
  const [h0, b0, s0, hr0, ov0] = A[i]
  const [h1, b1, s1, hr1, ov1] = A[i + 1]
  const t    = (hour - h0) / (h1 - h0)
  const lerp = (a, b) => a + (b - a) * t

  let brightness = lerp(b0, b1)
  let saturation = lerp(s0, s1)
  let hueRotate  = lerp(hr0, hr1)
  let overlay    = t < 0.5 ? ov0 : ov1

  // ── Fallback compensation ────────────────────────────────────────────────
  // If the displayed photo is from a different slot (e.g. day photo shown at
  // night), the filter must work harder to bridge the gap.
  // We scale brightness by the ratio of what is needed vs what the photo
  // naturally provides, capped to avoid blowing out or crushing the image.
  const photoBase = SLOT_BASE_BRIGHTNESS[imageSlot] ?? 1.0
  if (photoBase !== 1.0) {
    // Only compensate when the mismatch is significant (> 20 %)
    const ratio = brightness / photoBase
    if (Math.abs(ratio - 1) > 0.20) {
      brightness = Math.max(0.25, Math.min(1.5, brightness * (1 / photoBase)))
    }
  }

  // ── Weather adjustments ─────────────────────────────────────────────────
  const cloud  = fc?.cloud_cover        ?? 0
  const precip = fc?.precip_probability ?? 0
  const temp   = fc?.temperature        ?? 10
  const { sunrise, sunset } = sunTimesUTC(now, lat, lon)
  const tz = -now.getTimezoneOffset() / 60
  const srLocal = (sunrise + tz + 24) % 24
  const ssLocal = (sunset  + tz + 24) % 24
  const isDaytime = hour >= srLocal && hour < ssLocal

  if (isDaytime) {
    brightness = Math.max(0.55, brightness - (cloud / 100) * 0.12)
    saturation = Math.max(0.70, saturation - (cloud / 100) * 0.18)
    if (precip > 60)      { brightness -= 0.12; overlay = 'rgba(50,70,120,0.25)' }
    else if (precip > 30) { overlay = overlay ?? 'rgba(80,100,140,0.12)' }
    else if (cloud > 70)  { overlay = overlay ?? 'rgba(80,90,100,0.12)'  }
  }
  if (temp < 0) hueRotate += 8

  const filter = [
    `brightness(${Math.max(0.25, brightness).toFixed(2)})`,
    `saturate(${Math.max(0.30, saturation).toFixed(2)})`,
    Math.round(hueRotate) !== 0 ? `hue-rotate(${Math.round(hueRotate)}deg)` : null,
  ].filter(Boolean).join(' ')

  return { filter, overlay }
}

function getSkyCss(fc, coords) {
  const now = new Date()
  const hour = now.getHours() + now.getMinutes() / 60
  const lat = coords?.lat ?? 57.706
  const lon = coords?.lon ?? 11.967
  const { sunrise, sunset } = sunTimesUTC(now, lat, lon)
  const tz = -now.getTimezoneOffset() / 60
  const sr = (sunrise + tz + 24) % 24
  const ss = (sunset + tz + 24) % 24

  // [hour, topColor, bottomColor]
  const anchors = [
    [0,              '#0a0f1e', '#1a2744'],
    [sr - 1,         '#1a1040', '#2d1b69'],
    [sr,             '#7c2d12', '#f97316'],
    [sr + 1,         '#1d4ed8', '#fed7aa'],
    [sr + 3,         '#1e40af', '#bfdbfe'],
    [(sr + ss) / 2,  '#1d4ed8', '#93c5fd'],
    [ss - 2,         '#1e40af', '#bfdbfe'],
    [ss - 1,         '#b45309', '#fbbf24'],
    [ss,             '#7f1d1d', '#c2410c'],
    [ss + 1,         '#312e81', '#4c1d95'],
    [ss + 2,         '#1e1b4b', '#0f172a'],
    [24,             '#0a0f1e', '#1a2744'],
  ].filter(([h]) => h >= 0 && h <= 24).sort((a, b) => a[0] - b[0])

  // Find surrounding anchors and lerp colors
  let i = anchors.length - 2
  for (let j = 0; j < anchors.length - 1; j++) {
    if (hour >= anchors[j][0] && hour < anchors[j + 1][0]) { i = j; break }
  }
  const t = (hour - anchors[i][0]) / (anchors[i + 1][0] - anchors[i][0])

  // Simple lerp for hex colors
  const lerpHex = (c1, c2, t) => {
    const r1 = parseInt(c1.slice(1, 3), 16), g1 = parseInt(c1.slice(3, 5), 16), b1 = parseInt(c1.slice(5, 7), 16)
    const r2 = parseInt(c2.slice(1, 3), 16), g2 = parseInt(c2.slice(3, 5), 16), b2 = parseInt(c2.slice(5, 7), 16)
    const r = Math.round(r1 + (r2 - r1) * t), g = Math.round(g1 + (g2 - g1) * t), b = Math.round(b1 + (b2 - b1) * t)
    return `rgb(${r},${g},${b})`
  }

  const top = lerpHex(anchors[i][1], anchors[i + 1][1], t)
  const bot = lerpHex(anchors[i][2], anchors[i + 1][2], t)

  // Weather modifier — cloud/rain desaturates and darkens
  const cloud = fc?.cloud_cover ?? 0
  const precip = fc?.precip_probability ?? 0
  const filter = cloud > 70 || precip > 40
    ? `grayscale(${Math.min(60, cloud * 0.5)}%) brightness(${1 - cloud * 0.003})`
    : ''

  return { gradient: `linear-gradient(to bottom, ${top}, ${bot})`, filter }
}

// ── Weather particles ─────────────────────────────────────────────────────────

function WeatherParticles({ precip = 0, temperature = 10 }) {
  const isSnow = temperature < 1
  const count  = precip >= 80 ? 55 : precip >= 60 ? 35 : precip >= 30 ? 15 : 0

  const particles = useMemo(() =>
    Array.from({ length: count }, (_, i) => ({
      id:       i,
      left:     Math.random() * 110 - 5,          // -5 % … 105 %
      delay:    Math.random() * 3,                 // s
      duration: isSnow ? 3 + Math.random() * 2    // snow: 3–5 s
                       : 0.5 + Math.random() * 0.5, // rain: 0.5–1 s
      opacity:  0.35 + Math.random() * 0.45,
      width:    isSnow ? 2 + Math.random() * 3 : 1,  // px
      height:   isSnow ? null : 10 + Math.random() * 10, // px
      drift:    isSnow ? (Math.random() - 0.5) * 40 : 0,  // px horizontal
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [count, isSnow],
  )

  if (!count) return null

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map(p => (
        <div
          key={p.id}
          className={isSnow ? 'absolute rounded-full bg-white' : 'absolute rounded-full bg-blue-100/70'}
          style={{
            left:            `${p.left}%`,
            top:             '-2%',
            width:           p.width,
            height:          isSnow ? p.width : p.height,
            opacity:         p.opacity,
            animationName:   isSnow ? 'snow-fall' : 'rain-fall',
            animationDuration: `${p.duration}s`,
            animationDelay:  `${p.delay}s`,
            animationTimingFunction: 'linear',
            animationIterationCount: 'infinite',
            '--snow-drift':  `${p.drift}px`,
          }}
        />
      ))}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// API returns naive UTC strings ("2026-05-26T13:00:00") without a timezone
// suffix. Browsers treat those as *local* time, which breaks grouping and
// display for users outside UTC. Appending 'Z' forces correct UTC parsing.
function parseTS(iso) {
  if (!iso) return new Date(NaN)
  return new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z')
}

function isSameDay(a, b) {
  const da = parseTS(a), db = parseTS(b)
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate()
}

function formatHour(iso) {
  return `${parseTS(iso).getHours().toString().padStart(2, '0')}:00`
}

function dayLabel(isoString) {
  const d = parseTS(isoString)
  const today = new Date()
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1)
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (sameDay(d, today))    return 'Idag'
  if (sameDay(d, tomorrow)) return 'Imorgon'
  return d.toLocaleDateString('sv-SE', { weekday: 'long' })
    .replace(/^\w/, c => c.toUpperCase())
}

function dateLabel(isoString) {
  return parseTS(isoString).toLocaleDateString('sv-SE', {
    day: 'numeric', month: 'short',
  })
}

function windDirArrow(deg) {
  if (deg == null || isNaN(deg)) return ''
  return ['↓','↙','←','↖','↑','↗','→','↘'][Math.round(deg / 45) % 8]
}

function rainDrops(mm) {
  if (mm == null || mm < 0.5) return null   // 0.5mm min matches rain symbol threshold
  if (mm < 2.0)  return '💧'
  if (mm < 5.0)  return '💧💧'
  if (mm < 10.0) return '💧💧💧'
  return '💧💧💧💧'
}

function groupByDay(forecasts) {
  const days = []
  for (const fc of forecasts) {
    const last = days[days.length - 1]
    if (!last || !isSameDay(last[0].valid_for, fc.valid_for)) days.push([fc])
    else last.push(fc)
  }
  return days
}

function median(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function percentile75(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.75)]
}

function getDaySummary(hours) {
  const temps = hours.map(h => h.temperature).filter(t => t != null)
  const minTemp = temps.length ? Math.round(Math.min(...temps)) : null
  const maxTemp = temps.length ? Math.round(Math.max(...temps)) : null

  // Representative condition over daytime hours (07–20 UTC).
  // Cloud cover: median — reflects the typical condition, not the worst.
  // Precip probability: 75th percentile — catches a rain window without
  //   letting one bad hour represent the whole day.
  const daytime = hours.filter(h => {
    const utcH = parseTS(h.valid_for).getUTCHours()
    return utcH >= 7 && utcH < 20
  })
  const pool = daytime.length ? daytime : hours
  const repCloud  = median(pool.map(h => h.cloud_cover ?? 0))
  const repPrecip = percentile75(pool.map(h => h.precip_probability ?? 0))
  const repTemp   = median(pool.map(h => h.temperature ?? 10))
  const repWind   = median(pool.map(h => h.wind_speed ?? 0))
  const repFog    = median(pool.map(h => h.fog_probability ?? 0))
  // Pass null for validFor — day summaries always use daytime symbols
  const { symbol } = getWeatherInfo(repTemp, repPrecip, repWind, repCloud, null, 0, repFog, 0)

  const maxPrecipMm = Math.max(...hours.map(h => h.precip_mm ?? 0))
  const drops = rainDrops(maxPrecipMm)
  const totalPrecipMm = hours.reduce((s, h) => s + (h.precip_mm ?? 0), 0)
  const maxWind = Math.max(...hours.map(h => h.wind_speed ?? 0))

  return { minTemp, maxTemp, symbol, drops, totalPrecipMm, maxWind }
}

// ── Warnings ─────────────────────────────────────────────────────────────────

const WARNING_TRIANGLE_COLOR = {
  Red:    'text-red-500',
  Orange: 'text-orange-400',
  Yellow: 'text-yellow-400',
}

// Returns the highest-severity active warning that overlaps with the given day,
// or null if none (Meddelande is informational only — no triangle shown).
function warningForDay(hours, warnings) {
  if (!warnings?.length || !hours?.length) return null
  const dayStart = parseTS(hours[0].valid_for)
  const dayEnd   = parseTS(hours[hours.length - 1].valid_for)

  for (const w of warnings) {          // already sorted highest severity first
    if (!WARNING_TRIANGLE_COLOR[w.level_code]) continue  // skip Meddelande
    const wStart = w.start ? new Date(w.start) : null
    const wEnd   = w.end   ? new Date(w.end)   : null
    const overlaps = (!wStart || wStart <= dayEnd) && (!wEnd || wEnd >= dayStart)
    if (overlaps) return w
  }
  return null
}

function WarningTriangle({ warning }) {
  if (!warning) return null
  const color = WARNING_TRIANGLE_COLOR[warning.level_code]
  if (!color) return null
  return <span className={`text-xs ${color}`} title={`${warning.level_label}: ${warning.event}`}>▲</span>
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ConfidenceBadge({ conf }) {
  if (!conf) return null
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${conf.bg} ${conf.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        conf.level === 'hög' ? 'bg-green-400' :
        conf.level === 'medel' ? 'bg-yellow-400' : 'bg-red-400'
      }`} />
      Säkerhet: {conf.level}
    </span>
  )
}

function SixHourTable({ forecasts }) {
  const [expanded, setExpanded] = useState(false)
  const now = new Date()
  const future = forecasts?.filter(fc => parseTS(fc.valid_for) > now) ?? []

  // All remaining hours of today (local calendar day)
  const todayHours = future.filter(fc => isSameDay(fc.valid_for, now.toISOString()))
  const rows = expanded ? todayHours : todayHours.slice(0, 6)

  if (!rows.length) return null

  return (
    <div className="mt-4 border-t border-slate-700 pt-4 space-y-1">
      {rows.map((fc, i) => {
        const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for, 0, fc.fog_probability ?? 0, fc.precip_mm ?? 0)
        const drops = fc.precip_probability >= 20 ? rainDrops(fc.precip_mm) : null
        const fl = feelsLike(fc.temperature, fc.wind_speed)
        return (
          <div key={i} className="flex items-center gap-3 py-0.5">
            <span className="text-slate-400 font-mono text-xs w-12 shrink-0">{formatHour(fc.valid_for)}</span>
            <span className="text-lg w-6 text-center leading-none"><WeatherSymbol symbol={symbol} /></span>
            <span className="flex items-baseline gap-1 w-20 shrink-0">
              <span className="text-white text-sm font-medium">
                {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
              </span>
              {fl != null && <span className="text-slate-400 text-xs">({fl}°)</span>}
            </span>
            <span className={`text-xs w-10 ${fc.precip_probability >= 40 ? 'text-blue-300' : 'text-slate-500'}`}>
              {Math.round(fc.precip_probability)}%
            </span>
            <span className="text-slate-400 text-xs flex-1">
              {fc.wind_speed != null && fc.wind_speed >= 3
                ? `${Math.round(fc.wind_speed)} m/s ${windDirArrow(fc.wind_direction)}`
                : ''}
            </span>
            <span className="text-xs w-8 text-right">{drops ?? ''}</span>
          </div>
        )
      })}
      {todayHours.length > 6 && (
        <button
          onClick={() => setExpanded(o => !o)}
          className="w-full text-center text-xs text-slate-600 pt-2 pb-1 active:text-slate-400 transition-colors"
        >
          {expanded ? '↑ Visa färre' : `↓ Visa hela dagen`}
        </button>
      )}
    </div>
  )
}

const GLASS = 'bg-black/20 backdrop-blur-sm border border-white/10'

// ── Beaufort scale ────────────────────────────────────────────────────────────

const BEAUFORT_SCALE = [
  { max: 0.2,     bft: 0,  label: 'Stiltje' },
  { max: 1.5,     bft: 1,  label: 'Svag vind' },
  { max: 3.3,     bft: 2,  label: 'Svag vind' },
  { max: 5.4,     bft: 3,  label: 'Lätt bris' },
  { max: 7.9,     bft: 4,  label: 'Måttlig bris' },
  { max: 10.7,    bft: 5,  label: 'Frisk bris' },
  { max: 13.8,    bft: 6,  label: 'Hård bris' },
  { max: 17.1,    bft: 7,  label: 'Styv bris' },
  { max: 20.7,    bft: 8,  label: 'Kuling' },
  { max: 24.4,    bft: 9,  label: 'Hård kuling' },
  { max: 28.4,    bft: 10, label: 'Storm' },
  { max: 32.6,    bft: 11, label: 'Hård storm' },
  { max: Infinity, bft: 12, label: 'Orkan' },
]

function getBeaufort(ms) {
  if (ms == null || isNaN(ms)) return null
  return BEAUFORT_SCALE.find(b => ms <= b.max) ?? BEAUFORT_SCALE[12]
}

function BeaufortGauge({ windSpeed, windDirection }) {
  const bf = getBeaufort(windSpeed)
  if (!bf) return null
  const color = bf.bft <= 4 ? '#2dd4bf'
              : bf.bft <= 7 ? '#facc15'
              : bf.bft <= 9 ? '#fb923c'
              : '#ef4444'
  return (
    <div className="mt-2 flex flex-col gap-1">
      {/* Stacked bars — 20% smaller */}
      <div className="flex items-end gap-0.5">
        {Array.from({ length: 13 }, (_, i) => (
          <div key={i} style={{
            width: 3,
            height: 4 + Math.round(i * 1.6),
            backgroundColor: i <= bf.bft ? color : 'rgba(148,163,184,0.2)',
            borderRadius: 1,
          }} />
        ))}
      </div>
      <div className="text-[10px] font-medium text-center" style={{ color }}>
        {windDirArrow(windDirection)} {bf.label}
      </div>
    </div>
  )
}

function PressureTrend({ forecasts }) {
  if (!forecasts?.length) return null

  const now6h = forecasts.find(fc => {
    const h = (parseTS(fc.valid_for) - new Date()) / 3_600_000
    return h >= 5.5 && h <= 7
  }) ?? forecasts[Math.min(6, forecasts.length - 1)]
  const now0h = forecasts[0]

  if (!now0h?.pressure || !now6h?.pressure) return null

  const deltaPressure = now6h.pressure - now0h.pressure
  if (deltaPressure > -4) return null  // only show on significant fall

  const deltaPrec = (now6h.precip_probability ?? 0) - (now0h.precip_probability ?? 0)
  const confirmed = deltaPrec > 20
  const color = confirmed ? '#ef4444' : '#fb923c'

  const sym0 = getWeatherInfo(now0h.temperature, now0h.precip_probability, now0h.wind_speed, now0h.cloud_cover, now0h.valid_for, 0, now0h.fog_probability ?? 0, now0h.precip_mm ?? 0).symbol
  const sym6 = getWeatherInfo(now6h.temperature, now6h.precip_probability, now6h.wind_speed, now6h.cloud_cover, now6h.valid_for, 0, now6h.fog_probability ?? 0, now6h.precip_mm ?? 0).symbol

  return (
    <div className="mt-2 flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-1">
        <span className="text-lg leading-none"><WeatherSymbol symbol={sym0} /></span>
        <span className="text-xs font-bold" style={{ color }}>→</span>
        <span className="text-lg leading-none"><WeatherSymbol symbol={sym6} /></span>
      </div>
      <div className="text-[10px] font-medium text-center" style={{ color }}>
        {confirmed ? 'Försämras' : 'Kan försämras'}
      </div>
    </div>
  )
}

function CurrentCard({ fc, radar, allForecasts, motifImage }) {
  if (!fc) return (
    <div className={`${GLASS} rounded-2xl p-6 text-slate-500 text-center`}>
      Hämtar prognos…
    </div>
  )

  const { symbol, label } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for, radar?.cape ?? 0, fc.fog_probability ?? 0, fc.precip_mm ?? 0)
  const feels = feelsLike(fc.temperature, fc.wind_speed)

  return (
    <div className={`${GLASS} rounded-2xl p-6 relative overflow-hidden`} style={{ minHeight: 280 }}>
      {/* Temp + symbol + side indicators */}
      <div className="flex items-start justify-between">
        {/* Left column: symbol + label + Beaufort gauge */}
        <div className="flex flex-col gap-1 items-center">
          <span className="text-6xl leading-none" style={{ display: 'block', lineHeight: 1 }}><WeatherSymbol symbol={symbol} /></span>
          <span className="text-slate-400 text-sm" style={{ marginTop: -6 }}>{label}</span>
          <BeaufortGauge windSpeed={fc.wind_speed} windDirection={fc.wind_direction} />
          <PressureTrend forecasts={allForecasts} />
        </div>
        {/* Right column: temperature + feels like */}
        <div className="text-right">
          <div className="text-7xl font-thin text-white leading-none">
            {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
          </div>
          {feels != null && (
            <div className="text-slate-400 text-sm mt-1">Känns som {feels}°</div>
          )}
        </div>
      </div>

      {/* CAPE */}
      {radar?.cape != null && radar.cape >= 300 && (
        <div className="mt-2 flex items-center gap-2 text-xs text-yellow-300/80">
          <span>⚡</span>
          <span>
            {radar.cape >= 2500 ? 'Extremt instabil luft — hagel/åska sannolikt'
             : radar.cape >= 1000 ? 'Instabil luft — åska möjlig'
             : 'Viss instabilitet'}
          </span>
        </div>
      )}

      {/* Motif — covers entire card as transparent overlay, weather info shows through */}
      {motifImage && (
        <img
          src={motifImage.url}
          alt={motifImage.label}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            objectPosition: 'center bottom',
            pointerEvents: 'none',
          }}
        />
      )}

    </div>
  )
}

function HourRow({ fc }) {
  const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for, 0, fc.fog_probability ?? 0, fc.precip_mm ?? 0)
  // Only show drops when precip_probability ≥ 20 — same threshold as rain symbol
  const drops = fc.precip_probability >= 20 ? rainDrops(fc.precip_mm) : null
  const fl = feelsLike(fc.temperature, fc.wind_speed)
  return (
    <div className="flex items-center gap-3 py-2 border-b border-slate-700/50 last:border-0">
      <span className="text-slate-400 font-mono text-xs w-12 shrink-0">{formatHour(fc.valid_for)}</span>
      <span className="text-xl w-7 text-center"><WeatherSymbol symbol={symbol} /></span>
      <span className="flex items-baseline gap-1 w-20 shrink-0">
        <span className="text-white font-medium">
          {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
        </span>
        {fl != null && <span className="text-slate-400 text-xs">({fl}°)</span>}
      </span>
      {fc.wind_speed != null && fc.wind_speed >= 3
        ? <span className="text-slate-400 text-xs flex-1">
            {Math.round(fc.wind_speed)} m/s {windDirArrow(fc.wind_direction)}
          </span>
        : <span className="flex-1" />
      }
      <span className="text-xs w-12 text-right">{drops ?? <span className="text-slate-700">—</span>}</span>
    </div>
  )
}

function DayRow({ hours, warnings, weekMin, weekMax }) {
  const [open, setOpen] = useState(false)
  const { minTemp, maxTemp, symbol, drops } = getDaySummary(hours)
  const label   = dayLabel(hours[0].valid_for)
  const date    = dateLabel(hours[0].valid_for)
  const warning = warningForDay(hours, warnings)

  return (
    <div className={`${GLASS} rounded-2xl overflow-hidden`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-4 active:bg-white/5 transition-colors"
      >
        {/* Day name + date */}
        <div className="w-24 shrink-0 text-left">
          <div className="text-white font-medium">{label}</div>
          <div className="text-slate-400 text-xs">{date}</div>
        </div>

        {/* Symbol */}
        <span className="text-2xl w-8 shrink-0 text-center"><WeatherSymbol symbol={symbol} /></span>

        {/* Temp bar + range */}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-xs font-mono w-7 text-right shrink-0">
              {minTemp != null ? `${minTemp}°` : ''}
            </span>
            <TempBar dayMin={minTemp ?? weekMin} dayMax={maxTemp ?? weekMax} weekMin={weekMin} weekMax={weekMax} />
            <span className="text-white text-sm font-mono w-7 shrink-0">
              {maxTemp != null ? `${maxTemp}°` : '—'}
            </span>
          </div>
        </div>

        {/* Warning triangle */}
        <span className="w-4 text-center shrink-0"><WarningTriangle warning={warning} /></span>

        {/* Chevron */}
        <span className={`text-white/50 text-xs transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {open && (
        <div className="px-5 pb-4 border-t border-slate-700/50">
          {hours.map((fc, i) => <HourRow key={i} fc={fc} />)}
        </div>
      )}
    </div>
  )
}

// ── WeekView ──────────────────────────────────────────────────────────────────

function tempToColor(t) {
  if (t >= 22) return '#fb923c'   // orange-400
  if (t >= 16) return '#facc15'   // yellow-400
  if (t >= 10) return '#4ade80'   // green-400
  if (t >=  4) return '#2dd4bf'   // teal-400
  if (t >=  0) return '#93c5fd'   // blue-300
  return '#60a5fa'                // blue-400
}

function TempBar({ dayMin, dayMax, weekMin, weekMax }) {
  const span  = weekMax - weekMin || 1
  const left  = ((dayMin - weekMin) / span) * 100
  const width = Math.max(((dayMax - dayMin) / span) * 100, 6)

  // The gradient always covers the full week range (weekMin→weekMax colours).
  // A clipping wrapper sits at the bar's position; inside it a full-track-width
  // gradient div is shifted left so its origin aligns with the track's left edge.
  // This guarantees the same temperature always maps to the same horizontal colour
  // position across all days — gradients are visually parallel.
  const c1 = tempToColor(weekMin)
  const c2 = tempToColor(weekMax)
  const bg  = c1 === c2 ? c1 : `linear-gradient(to right, ${c1}, ${c2})`

  return (
    <div className="relative h-1.5 bg-slate-700 rounded-full" style={{ minWidth: 80 }}>
      {/* Clipping wrapper — positioned at the day's temperature range */}
      <div
        className="absolute h-full rounded-full overflow-hidden"
        style={{ left: `${left}%`, width: `${width}%` }}
      >
        {/* Full-track gradient, shifted back to track origin */}
        <div
          className="absolute h-full"
          style={{
            left:       `${-(left / width) * 100}%`,
            width:      `${10000 / width}%`,
            background: bg,
          }}
        />
      </div>
    </div>
  )
}

function WeekView({ warnings }) {
  const [weekForecast, setWeekForecast] = useState(null)
  const [loading, setLoading]           = useState(true)

  useEffect(() => {
    fetchEnsemble(168)
      .then(setWeekForecast)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className={`${GLASS} rounded-2xl p-6 text-slate-500 text-center`}>Hämtar prognos…</div>
  )
  if (!weekForecast) return (
    <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm`}>Kunde inte hämta prognos.</div>
  )

  const now     = new Date()
  const future  = weekForecast.filter(fc => parseTS(fc.valid_for) > now)
  const days    = groupByDay(future)
  const summaries = days
    .filter((hours, i) => i === 0 || hours.length >= 23)
    .map(hours => ({ hours, ...getDaySummary(hours) }))

  const weekMin = Math.min(...summaries.map(s => s.minTemp ?? 99))
  const weekMax = Math.max(...summaries.map(s => s.maxTemp ?? -99))

  const cutoff48 = new Date(Date.now() + 48 * 3600 * 1000)

  return (
    <div className={`${GLASS} rounded-2xl overflow-hidden`}>
      {summaries.map(({ hours, minTemp, maxTemp, symbol, totalPrecipMm, maxWind }, i) => (
        <WeekDayRow
          key={i}
          hours={hours}
          minTemp={minTemp}
          maxTemp={maxTemp}
          symbol={symbol}
          totalPrecipMm={totalPrecipMm}
          maxWind={maxWind}
          weekMin={weekMin}
          weekMax={weekMax}
          isHourly={parseTS(hours[0].valid_for) < cutoff48}
          warnings={warnings}
        />
      ))}
    </div>
  )
}

function WeekDayRow({ hours, minTemp, maxTemp, symbol, totalPrecipMm, maxWind, weekMin, weekMax, isHourly, warnings }) {
  const [open, setOpen] = useState(false)
  const label      = dayLabel(hours[0].valid_for)
  const date       = dateLabel(hours[0].valid_for)
  const showPrecip = totalPrecipMm >= 0.1
  const showWind   = maxWind >= 8
  const warning    = warningForDay(hours, warnings)

  // For days beyond 48h show only 6-hour snapshots (00, 06, 12, 18 UTC)
  const detailRows = isHourly
    ? hours
    : hours.filter(h => parseTS(h.valid_for).getHours() % 6 === 0)

  return (
    <div className="border-b border-slate-700/50 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3.5 active:bg-slate-700/50 transition-colors"
      >
        {/* Day name + date */}
        <div className="w-24 shrink-0 text-left">
          <div className="text-white text-sm font-medium leading-tight">{label}</div>
          <div className="text-slate-400 text-xs">{date}</div>
        </div>

        {/* Symbol */}
        <span className="text-2xl w-8 text-center shrink-0"><WeatherSymbol symbol={symbol} /></span>

        {/* Temp bar + secondary info */}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-xs font-mono w-7 text-right shrink-0">
              {minTemp != null ? `${minTemp}°` : ''}
            </span>
            <TempBar dayMin={minTemp ?? weekMin} dayMax={maxTemp ?? weekMax} weekMin={weekMin} weekMax={weekMax} />
            <span className="text-white text-sm font-mono w-7 shrink-0">
              {maxTemp != null ? `${maxTemp}°` : '—'}
            </span>
          </div>
          {(showPrecip || showWind) && (
            <div className="flex items-center gap-3 pl-9 text-xs">
              {showPrecip && <span className="text-blue-300">{totalPrecipMm.toFixed(1)} mm</span>}
              {showWind   && <span className="text-slate-400">{Math.round(maxWind)} m/s</span>}
            </div>
          )}
        </div>

        {/* Warning triangle */}
        <span className="w-4 text-center shrink-0"><WarningTriangle warning={warning} /></span>

        {/* Chevron */}
        <span className={`text-white/50 text-xs transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {open && (
        <div className="px-5 pb-4 border-t border-slate-700/50">
          {!isHourly && (
            <p className="text-white/50 text-xs py-2">Prognos var 6:e timme</p>
          )}
          {detailRows.map((fc, j) => <HourRow key={j} fc={fc} />)}
        </div>
      )}
    </div>
  )
}

// ── WarningsView ──────────────────────────────────────────────────────────────

const WARNING_LEVEL_STYLE = {
  Red:       { border: 'border-red-500',    bg: 'bg-red-500/10',    badge: 'bg-red-500/20 text-red-400' },
  Orange:    { border: 'border-orange-400', bg: 'bg-orange-400/10', badge: 'bg-orange-400/20 text-orange-300' },
  Yellow:    { border: 'border-yellow-400', bg: 'bg-yellow-400/10', badge: 'bg-yellow-400/20 text-yellow-300' },
  Meddelande:{ border: 'border-slate-500',  bg: 'bg-slate-700/40',  badge: 'bg-slate-600/50 text-slate-300' },
}

function formatWarningPeriod(start, end) {
  const fmt = iso => {
    if (!iso) return null
    const d = new Date(iso)
    return d.toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' })
      + ' ' + String(d.getHours()).padStart(2, '0') + ':00'
  }
  const s = fmt(start), e = fmt(end)
  if (s && e) return `${s} – ${e}`
  if (s)      return `Från ${s}`
  if (e)      return `Till ${e}`
  return null
}

function WarningCard({ warning }) {
  const style = WARNING_LEVEL_STYLE[warning.level_code] ?? WARNING_LEVEL_STYLE.Meddelande
  const period = formatWarningPeriod(warning.start, warning.end)

  return (
    <div className={`rounded-2xl border-l-4 p-5 space-y-3 ${style.border} ${style.bg}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="text-white font-medium">{warning.event}</span>
        <span className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${style.badge}`}>
          {warning.level_label}
        </span>
      </div>
      {period && (
        <p className="text-slate-400 text-xs">{period}</p>
      )}
      {warning.description && (
        <p className="text-slate-300 text-sm leading-relaxed">{warning.description}</p>
      )}
    </div>
  )
}

function WarningsView({ warnings }) {
  if (!warnings.length) {
    return (
      <div className={`${GLASS} rounded-2xl p-8 flex flex-col items-center gap-3 text-center`}>
        <span className="text-3xl">✓</span>
        <p className="text-white font-medium">Inga aktiva varningar</p>
        <p className="text-slate-500 text-sm">Inga SMHI-varningar gäller just nu för Göteborg.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-slate-400 text-xs px-1">
        Aktiva SMHI-varningar för Göteborg · Västra Götalands län
      </p>
      {warnings.map((w, i) => <WarningCard key={i} warning={w} />)}
      <p className="text-white/50 text-xs px-1 pt-1">
        Uppdateras var 30:e minut · Källa: SMHI IBW
      </p>
    </div>
  )
}

// ── CollectButton ─────────────────────────────────────────────────────────────

function CollectButton() {
  const [state, setState] = useState('idle') // idle | loading | done | error

  const trigger = async () => {
    setState('loading')
    try {
      await triggerCollect()
      setState('done')
      setTimeout(() => setState('idle'), 4000)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 3000)
    }
  }

  return (
    <button
      onClick={trigger}
      disabled={state === 'loading'}
      className="w-full text-center text-xs text-slate-600 py-2 active:text-slate-400 transition-colors disabled:opacity-50"
    >
      {state === 'idle'    && '↻ Hämta nu'}
      {state === 'loading' && 'Hämtar…'}
      {state === 'done'    && '✓ Klar — ladda om om en stund'}
      {state === 'error'   && '✗ Misslyckades'}
    </button>
  )
}

// ── Source name labels ────────────────────────────────────────────────────────

const SOURCE_LABELS = {
  smhi:                'SMHI',
  yr:                  'Yr.no',
  openweathermap:      'OpenWeatherMap',
  open_meteo:          'Open-Meteo GFS',
  open_meteo_icon_eu:  'Open-Meteo ICON EU',
  open_meteo_ecmwf:    'Open-Meteo ECMWF',
  open_meteo_ukmo:     'UKMO',
  open_meteo_knmi:     'KNMI HARMONIE',
  radar_nowcast:       'Radar',
  ensemble:            'Ensemble',
}

const SOURCE_COLORS = {
  smhi:               '#60a5fa',
  yr:                 '#34d399',
  open_meteo:         '#f97316',
  open_meteo_icon_eu: '#22d3ee',
  open_meteo_ecmwf:   '#fbbf24',
  openweathermap:     '#a78bfa',
  open_meteo_ukmo:    '#e879f9',
  open_meteo_knmi:    '#2dd4bf',
  ensemble:           '#ffffff',
}

const SOURCE_ORDER = [
  'smhi', 'yr', 'openweathermap',
  'open_meteo', 'open_meteo_icon_eu', 'open_meteo_ecmwf',
  'open_meteo_ukmo', 'open_meteo_knmi',
]

// ── ForecastDivergenceChart ───────────────────────────────────────────────────

function buildChartData(sources, ensembleFcs, param) {
  const field = param === 'temperature' ? 'temperature'
              : param === 'precip'      ? 'precip_probability'
              :                           'wind_speed'
  const now = new Date()
  const timeMap = new Map()

  for (const [src, fcs] of Object.entries(sources ?? {})) {
    for (const fc of fcs) {
      if (parseTS(fc.valid_for) <= now) continue
      const t = fc.valid_for
      if (!timeMap.has(t)) timeMap.set(t, { time: t })
      if (fc[field] != null) timeMap.get(t)[src] = Math.round(fc[field] * 10) / 10
    }
  }
  for (const fc of ensembleFcs ?? []) {
    if (parseTS(fc.valid_for) <= now) continue
    const t = fc.valid_for
    if (!timeMap.has(t)) timeMap.set(t, { time: t })
    if (fc[field] != null) timeMap.get(t)['ensemble'] = Math.round(fc[field] * 10) / 10
  }
  return [...timeMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, v]) => v)
}

function DivergenceTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null
  const d = parseTS(label)
  const timeStr = `${d.toLocaleDateString('sv-SE', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:00`
  const sorted = [...payload].sort((a, b) => {
    if (a.dataKey === 'ensemble') return -1
    if (b.dataKey === 'ensemble') return 1
    return (b.value ?? 0) - (a.value ?? 0)
  })
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-2">{timeStr}</p>
      {sorted.map(p => (
        <div key={p.dataKey} className="flex items-center gap-2 mb-0.5">
          <span style={{ color: p.color }} className="text-base leading-none">—</span>
          <span className="text-slate-300 w-28">{SOURCE_LABELS[p.dataKey] ?? p.dataKey}</span>
          <span className="font-mono text-white">{p.value}{unit}</span>
        </div>
      ))}
    </div>
  )
}

function ForecastDivergenceChart({ sources, ensembleFcs }) {
  const [param, setParam] = useState('temperature')

  const chartData = buildChartData(sources, ensembleFcs, param)
  const srcKeys = [...SOURCE_ORDER.filter(k => sources?.[k]), 'ensemble']

  const yUnit   = param === 'temperature' ? '°' : param === 'precip' ? '%' : ' m/s'
  const yDomain = param === 'precip' ? [0, 100] : param === 'wind' ? [0, 'auto'] : ['auto', 'auto']

  const xTicks = chartData
    .filter(d => parseTS(d.time).getHours() % 6 === 0)
    .map(d => d.time)

  const xTickFormatter = iso => {
    const d = parseTS(iso)
    const h = d.getHours()
    if (h === 0) return d.toLocaleDateString('sv-SE', { weekday: 'short' })
    return `${String(h).padStart(2, '0')}`
  }

  const midnights = chartData
    .filter(d => parseTS(d.time).getHours() === 0)
    .map(d => d.time)

  if (!chartData.length) return null

  return (
    <div className={`${GLASS} rounded-2xl p-5 space-y-4`}>
      <div className="flex items-center justify-between">
        <h2 className="text-white font-medium text-sm">Källspridning</h2>
        <div className="flex gap-1">
          {[['temperature', 'Temp'], ['precip', 'Regn'], ['wind', 'Vind']].map(([p, label]) => (
            <button
              key={p}
              onClick={() => setParam(p)}
              className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                param === p ? 'bg-slate-600 text-white' : 'text-slate-500 active:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <XAxis
            dataKey="time"
            ticks={xTicks}
            tickFormatter={xTickFormatter}
            tick={{ fill: '#475569', fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: '#1e293b' }}
          />
          <YAxis
            domain={yDomain}
            tick={{ fill: '#475569', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v}${yUnit}`}
            width={38}
          />
          <Tooltip content={<DivergenceTooltip unit={yUnit} />} />
          {midnights.map(t => (
            <ReferenceLine key={t} x={t} stroke="#1e293b" strokeWidth={1} />
          ))}
          {srcKeys.filter(k => k !== 'ensemble').map(src => (
            <Line
              key={src}
              type="monotone"
              dataKey={src}
              stroke={SOURCE_COLORS[src] ?? '#64748b'}
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          ))}
          <Line
            type="monotone"
            dataKey="ensemble"
            stroke="#ffffff"
            strokeWidth={2.5}
            dot={false}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
        {srcKeys.map(src => (
          <div key={src} className="flex items-center gap-1.5">
            <span
              className="inline-block w-4 rounded-full"
              style={{ height: src === 'ensemble' ? 2.5 : 1.5, backgroundColor: SOURCE_COLORS[src] ?? '#64748b' }}
            />
            <span className="text-xs text-slate-400">{SOURCE_LABELS[src] ?? src}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── EnsembleView ──────────────────────────────────────────────────────────────

function EnsembleView({ ensembleFc }) {
  const [sources, setSources]         = useState(null)
  const [ensembleFcs, setEnsembleFcs] = useState(null)
  const [weights, setWeights]         = useState(null)
  const [loading, setLoading]         = useState(true)

  useEffect(() => {
    Promise.all([fetchSources(48), fetchWeights(), fetchEnsemble(48)])
      .then(([s, w, ens]) => { setSources(s); setWeights(w); setEnsembleFcs(ens) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className={`${GLASS} rounded-2xl p-6 text-slate-500 text-center`}>
      Hämtar källor…
    </div>
  )

  if (!sources) return (
    <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm`}>
      Kunde inte hämta källdata.
    </div>
  )

  // Get first future forecast per source
  const now = new Date()
  const currentBySource = {}
  for (const [src, fcs] of Object.entries(sources)) {
    const upcoming = fcs.filter(fc => parseTS(fc.valid_for) > now)
    if (upcoming.length) currentBySource[src] = upcoming[0]
  }

  // Weights at lead bucket 1 (near-term)
  const weightsAt1 = weights?.filter(w => w.lead_hours === 1) ?? []
  const bySource = Object.fromEntries(weightsAt1.map(w => [w.source, w]))

  // Include ensemble in the ranked list alongside individual sources
  const displayOrder = [...SOURCE_ORDER, 'ensemble'].filter(s => currentBySource[s])

  // Rank sources by summing their per-parameter rank positions (temp + precip + wind).
  // Lower sum = better overall rank. Sources without weight data are placed last.
  const rankSum = Object.fromEntries(displayOrder.map(s => [s, 0]));
  ['mae_temperature', 'mae_precip', 'mae_wind'].forEach(param => {
    const withData    = displayOrder.filter(s => bySource[s]?.[param] != null)
    const withoutData = displayOrder.filter(s => bySource[s]?.[param] == null)
    withData.sort((a, b) => bySource[a][param] - bySource[b][param])
           .forEach((s, i) => { rankSum[s] += i })
    withoutData.forEach(s => { rankSum[s] += displayOrder.length })
  })
  const rankedOrder = [...displayOrder].sort((a, b) => rankSum[a] - rankSum[b])

  // Best source per parameter (lowest MAE)
  const best = (param) => {
    let bestSrc = null, bestVal = Infinity
    for (const src of displayOrder) {
      const val = bySource[src]?.[param]
      if (val != null && val < bestVal) { bestVal = val; bestSrc = src }
    }
    return { src: bestSrc, val: bestVal }
  }
  const bestTemp   = best('mae_temperature')
  const bestPrecip = best('mae_precip')
  const bestWind   = best('mae_wind')

  const hourLabel = ensembleFc
    ? `${parseTS(ensembleFc.valid_for).getHours().toString().padStart(2, '0')}:00`
    : '—'

  return (
    <div className="space-y-3">
      {/* Comparison table */}
      <div className={`${GLASS} rounded-2xl overflow-hidden`}>
        <div className="px-5 pt-4 pb-3 border-b border-slate-700">
          <h2 className="text-white font-medium text-sm">Källjämförelse — kl {hourLabel}</h2>
          <p className="text-slate-400 text-xs mt-0.5">Rankad efter historisk träffsäkerhet · närmaste timme</p>
        </div>

        {/* Header row */}
        <div className="flex items-center gap-2 px-5 py-2 text-slate-400 text-xs">
          <span className="w-5 shrink-0">#</span>
          <span className="flex-1">Källa</span>
          <span className="w-12 text-right">Temp</span>
          <span className="w-12 text-right">Regn%</span>
          <span className="w-14 text-right">Vind</span>
        </div>

        {/* All sources in ranked order — ensemble included */}
        {rankedOrder.map((src, idx) => {
          const fc = currentBySource[src]
          return (
            <div key={src} className="flex items-center gap-2 px-5 py-2 border-b border-slate-700/40 last:border-0">
              <span className="text-white/50 text-xs font-mono w-5 shrink-0">{idx + 1}.</span>
              <span className="flex-1 text-slate-300 text-sm">
                {SOURCE_LABELS[src] ?? src}{src === 'ensemble' ? ' ★' : ''}
              </span>
              <span className="w-12 text-right text-slate-300 text-sm font-mono">
                {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
              </span>
              <span className={`w-12 text-right text-sm font-mono ${fc.precip_probability >= 40 ? 'text-blue-300' : 'text-slate-500'}`}>
                {Math.round(fc.precip_probability)}%
              </span>
              <span className="w-14 text-right text-slate-500 text-sm font-mono">
                {fc.wind_speed != null ? `${Math.round(fc.wind_speed)} m/s` : '—'}
              </span>
            </div>
          )
        })}

        {displayOrder.length === 0 && (
          <div className="px-5 py-4 text-slate-500 text-sm text-center">Ingen källdata tillgänglig.</div>
        )}
      </div>

      {/* Divergence chart */}
      {sources && <ForecastDivergenceChart sources={sources} ensembleFcs={ensembleFcs ?? []} />}

      {/* Manual collect trigger */}
      <CollectButton />

      {/* Weight explanation */}
      {weightsAt1.length > 0 && (
        <div className={`${GLASS} rounded-2xl p-5 space-y-3`}>
          <h2 className="text-white font-medium text-sm">Nuvarande vikter (0–6 h)</h2>
          <div className="space-y-2 text-sm">
            {bestTemp.src && (
              <div className="flex items-start gap-2">
                <span className="text-slate-400 shrink-0">🌡</span>
                <span className="text-slate-300">
                  <span className="text-white font-medium">{SOURCE_LABELS[bestTemp.src]}</span>
                  {' '}har lägst temperaturavvikelse ({bestTemp.val.toFixed(2)} °C MAE)
                </span>
              </div>
            )}
            {bestPrecip.src && (
              <div className="flex items-start gap-2">
                <span className="text-slate-400 shrink-0">🌧</span>
                <span className="text-slate-300">
                  <span className="text-white font-medium">{SOURCE_LABELS[bestPrecip.src]}</span>
                  {' '}har lägst Brier score för regn ({bestPrecip.val.toFixed(3)})
                </span>
              </div>
            )}
            {bestWind.src && (
              <div className="flex items-start gap-2">
                <span className="text-slate-400 shrink-0">💨</span>
                <span className="text-slate-300">
                  <span className="text-white font-medium">{SOURCE_LABELS[bestWind.src]}</span>
                  {' '}har lägst vindavvikelse ({bestWind.val.toFixed(2)} m/s MAE)
                </span>
              </div>
            )}
          </div>
          <p className="text-white/50 text-xs pt-1">
            Ensemblen viktar varje källa efter historisk träffsäkerhet. Bättre källa → högre vikt.
          </p>
        </div>
      )}
    </div>
  )
}

// ── AnalysView ────────────────────────────────────────────────────────────────

const ALERT_STYLE = {
  none:    { bg: 'bg-black/20',       border: '',                    dot: 'bg-slate-500' },
  watch:   { bg: 'bg-black/20',       border: 'border-yellow-500/40', dot: 'bg-yellow-400' },
  warning: { bg: 'bg-orange-900/30',  border: 'border-orange-500/40', dot: 'bg-orange-400' },
  alert:   { bg: 'bg-red-900/30',     border: 'border-red-500/40',    dot: 'bg-red-500' },
}

const CONF_STYLE = {
  high:   { label: 'Hög säkerhet',     color: 'text-green-400',  bg: 'bg-green-400/10' },
  medium: { label: 'Måttlig säkerhet', color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  low:    { label: 'Låg säkerhet',     color: 'text-red-400',    bg: 'bg-red-400/10' },
}

const EVENT_ICON = {
  rain_window:      '🌧',
  wind_event:       '💨',
  clearing:         '🌤',
  temperature_drop: '🌡',
  heat:             '☀️',
}

function formatGeneratedAt(iso) {
  if (!iso) return null
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z')
  const diffMin = Math.round((Date.now() - d) / 60000)
  if (diffMin < 1)  return 'just nu'
  if (diffMin < 60) return `${diffMin} min sedan`
  return `kl ${d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`
}

function AnalysView() {
  const [period, setPeriod] = useState('today')
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setSummary(null)
    setDetailOpen(false)
    fetchSummary(period)
      .then(setSummary)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [period])

  return (
    <div className="space-y-3">
      {/* Period toggle */}
      <div className="flex gap-2">
        {[['today', 'Idag'], ['tomorrow', 'Imorgon']].map(([p, label]) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
              period === p ? 'bg-white/20 text-white' : 'bg-black/20 text-slate-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && (
        <div className={`${GLASS} rounded-2xl p-8 text-slate-500 text-center text-sm`}>
          Hämtar analys…
        </div>
      )}

      {error && (
        <div className={`${GLASS} rounded-2xl p-6 text-slate-400 text-center text-sm`}>
          Kunde inte generera sammanfattning.
        </div>
      )}

      {summary && (() => {
        const alertStyle = ALERT_STYLE[summary.ui?.alert_level] ?? ALERT_STYLE.none
        const confStyle  = CONF_STYLE[summary.confidence?.level] ?? CONF_STYLE.medium

        return (
          <>
            {/* Hero card */}
            <div className={`rounded-2xl p-5 space-y-3 ${alertStyle.bg} ${alertStyle.border ? `border ${alertStyle.border}` : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-white font-semibold text-lg leading-snug flex-1">
                  {summary.summary?.headline}
                </h2>
                {summary.ui?.hero_badge && (
                  <span className="shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-slate-700 text-slate-300">
                    <span className={`w-1.5 h-1.5 rounded-full ${alertStyle.dot}`} />
                    {summary.ui.hero_badge}
                  </span>
                )}
              </div>

              <p className="text-slate-300 text-sm leading-relaxed">{summary.summary?.short}</p>

              {summary.summary?.detailed && (
                <>
                  {detailOpen && (
                    <p className="text-slate-400 text-sm leading-relaxed">{summary.summary.detailed}</p>
                  )}
                  <button
                    onClick={() => setDetailOpen(o => !o)}
                    className="text-xs text-slate-500 active:text-slate-300 transition-colors"
                  >
                    {detailOpen ? '↑ Mindre' : '↓ Läs mer'}
                  </button>
                </>
              )}
            </div>

            {/* Confidence */}
            <div className={`${GLASS} rounded-2xl p-4 flex items-start gap-3`}>
              <ShieldCheck size={15} className={`shrink-0 mt-0.5 ${confStyle.color}`} />
              <div className="flex-1 min-w-0">
                <span className={`text-xs font-medium ${confStyle.color}`}>{confStyle.label}</span>
                <p className="text-slate-400 text-xs leading-relaxed mt-0.5">{summary.confidence?.reason}</p>
              </div>
            </div>

            {/* Key events */}
            {summary.key_events?.length > 0 && (
              <div className={`${GLASS} rounded-2xl overflow-hidden`}>
                <div className="px-5 pt-4 pb-2 border-b border-slate-700 flex items-center gap-2">
                  <Zap size={14} className="text-slate-400 shrink-0" />
                  <h3 className="text-white text-sm font-medium">Händelser</h3>
                </div>
                {summary.key_events.map((ev, i) => (
                  <div key={i} className="flex items-start gap-3 px-5 py-3 border-b border-slate-700/50 last:border-0">
                    <span className="text-xl shrink-0 mt-0.5">{EVENT_ICON[ev.type] ?? '⚡'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-medium">{ev.title}</span>
                        {ev.from && ev.to && (
                          <span className="text-slate-400 text-xs">{ev.from}–{ev.to}</span>
                        )}
                      </div>
                      <p className="text-slate-400 text-xs mt-0.5 leading-relaxed">{ev.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Periods */}
            {summary.periods?.length > 0 && (
              <div className={`${GLASS} rounded-2xl overflow-hidden`}>
                <div className="px-5 pt-4 pb-2 border-b border-slate-700 flex items-center gap-2">
                  <Clock size={14} className="text-slate-400 shrink-0" />
                  <h3 className="text-white text-sm font-medium">Under dagen</h3>
                </div>
                {summary.periods.map((p, i) => {
                  const cs = CONF_STYLE[p.confidence] ?? CONF_STYLE.medium
                  return (
                    <div key={i} className="flex items-start gap-3 px-5 py-3 border-b border-slate-700/50 last:border-0">
                      <div className="w-20 shrink-0">
                        <div className="text-white text-xs font-medium">{p.name}</div>
                        <div className="text-slate-400 text-xs">{p.from}–{p.to}</div>
                      </div>
                      <p className="text-slate-300 text-xs leading-relaxed flex-1">{p.description}</p>
                      <span className={`shrink-0 text-xs ${cs.color}`}>●</span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Insights */}
            {summary.insights?.length > 0 && (
              <div className={`${GLASS} rounded-2xl p-5 space-y-3`}>
                <div className="flex items-center gap-2">
                  <TrendingUp size={14} className="text-slate-400 shrink-0" />
                  <h3 className="text-white text-sm font-medium">Modellinsikter</h3>
                </div>
                {summary.insights.map((ins, i) => (
                  <div key={i} className="space-y-0.5">
                    <div className="text-slate-300 text-xs font-medium">{ins.title}</div>
                    <p className="text-slate-400 text-xs leading-relaxed">{ins.description}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Practical advice */}
            {summary.practical_advice?.main && (
              <div className="bg-slate-700/50 rounded-2xl p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <Lightbulb size={14} className="text-slate-400 shrink-0 mt-0.5" />
                  <p className="text-white text-sm">{summary.practical_advice.main}</p>
                </div>
                {summary.practical_advice.tips?.map((tip, i) => (
                  <p key={i} className="text-slate-400 text-xs">· {tip}</p>
                ))}
              </div>
            )}

            <p className="text-white/50 text-xs px-1">
              Genererad av Claude Haiku{summary._generated_at ? ` · ${formatGeneratedAt(summary._generated_at)}` : ''} · Uppdateras var 2:e timme
            </p>
          </>
        )
      })()}
    </div>
  )
}

// ── Swipe navigation ──────────────────────────────────────────────────────────

const TAB_ORDER = ['now', 'week', 'analysis', 'warnings', 'sources']

// slideDir: 1 = forward (enter from right), -1 = backward (enter from left)
const slideVariants = {
  enter:  (dir) => ({ x: dir > 0 ? '100%' : '-100%' }),
  center: { x: 0 },
  exit:   (dir) => ({ x: dir > 0 ? '-100%' : '100%' }),
}

function useSwipeNav(activeTab, setActiveTab) {
  const start = useRef(null)

  const onTouchStart = useCallback(e => {
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }, [])

  const onTouchEnd = useCallback(e => {
    if (!start.current) return
    const dx = e.changedTouches[0].clientX - start.current.x
    const dy = e.changedTouches[0].clientY - start.current.y
    start.current = null
    // Require clearly horizontal swipe: >50px and more horizontal than vertical
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return
    const idx = TAB_ORDER.indexOf(activeTab)
    if (dx < 0 && idx < TAB_ORDER.length - 1) setActiveTab(TAB_ORDER[idx + 1])
    if (dx > 0 && idx > 0)                    setActiveTab(TAB_ORDER[idx - 1])
  }, [activeTab, setActiveTab])

  return { onTouchStart, onTouchEnd }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MobileApp() {
  const [forecast, setForecast] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [activeTab, setActiveTab] = useState('now')
  const [slideDir, setSlideDir] = useState(1)
  const { radar, coords } = useRadarLocation()
  const geoLocation = useReverseGeocode(coords)
  const bgImage = useCityBackground(coords)
  const motifImage = useCityMotif(coords)

  // Direction-aware tab change: drives the slide animation
  const changeTab = useCallback((newTab) => {
    const curIdx = TAB_ORDER.indexOf(activeTab)
    const newIdx = TAB_ORDER.indexOf(newTab)
    setSlideDir(newIdx >= curIdx ? 1 : -1)
    setActiveTab(newTab)
  }, [activeTab])

  const swipeHandlers = useSwipeNav(activeTab, changeTab)

  useEffect(() => {
    const loadWarnings = () => fetchWarnings().then(setWarnings).catch(() => {})
    loadWarnings()
    const interval = setInterval(loadWarnings, 30 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const load = useCallback(async () => {
    try {
      setForecast(coords
        ? await fetchLocalForecast(coords.lat, coords.lon, 72)
        : await fetchEnsemble(72))
    } catch {}
  }, [coords])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const interval = setInterval(load, 10 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  const now = new Date()
  const future = forecast?.filter(fc => parseTS(fc.valid_for) > now) ?? []
  const currentFc = future[0] ?? null
  const days = groupByDay(future)

  return (
    <div className="fixed inset-0 bg-slate-900 text-slate-100 flex flex-col">

      {/* Animated content area */}
      <div className="flex-1 relative overflow-x-hidden min-h-0" {...swipeHandlers}>

        {/* Weather particles (rain/snow) — no sky gradient */}
        {activeTab === 'now' && (
          <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
            <WeatherParticles
              precip={currentFc?.precip_probability ?? 0}
              temperature={currentFc?.temperature ?? 10}
            />
          </div>
        )}

<AnimatePresence mode="sync" custom={slideDir}>
          <motion.div
            key={activeTab}
            custom={slideDir}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: 'tween', duration: 0.28, ease: 'easeInOut' }}
            className="absolute inset-0 overflow-y-auto z-10"
          >
            <div className="px-4 pt-10 pb-4 space-y-3 max-w-lg mx-auto">

              {activeTab === 'now' && (
                <>
                  {geoLocation && (
                    <div className="flex items-center gap-1.5 px-1 text-white/50 text-xs">
                      <span>📍</span>
                      <span>{[geoLocation.suburb, geoLocation.place].filter(Boolean).join(' · ')}</span>
                    </div>
                  )}
                  <CurrentCard fc={currentFc} radar={radar} allForecasts={future} motifImage={motifImage} />

                  {/* Prognossäkerhet + sammanfattning — under "just nu"-kortet */}
                  {(() => {
                    const conf = summariseConfidence(future)
                    const summary = generateSummary(future)
                    if (!conf && !summary) return null
                    return (
                      <div className={`${GLASS} rounded-2xl px-5 py-4 flex flex-col gap-2`}>
                        <ConfidenceBadge conf={conf} />
                        {summary && <p className="text-slate-300 text-sm leading-relaxed">{summary}</p>}
                      </div>
                    )
                  })()}

                  {/* 6-timmarsprognos + kommande dagar */}
                  {(() => {
                    const visibleDays = days.slice(1).filter(h => h.length >= 23)
                    const allSummaries = visibleDays.map(getDaySummary)
                    const wMin = Math.min(...allSummaries.map(s => s.minTemp ?? 99))
                    const wMax = Math.max(...allSummaries.map(s => s.maxTemp ?? -99))
                    return (
                      <>
                        {/* 6-timmarsprognos precis över "imorgon"-kortet */}
                        <SixHourTable forecasts={future} />
                        {visibleDays.map((hours, i) => (
                          <DayRow key={i} hours={hours} warnings={warnings} weekMin={wMin} weekMax={wMax} />
                        ))}
                      </>
                    )
                  })()}
                </>
              )}

              {activeTab === 'week' && (
                <WeekView warnings={warnings} />
              )}

              {activeTab === 'analysis' && (
                <AnalysView />
              )}

              {activeTab === 'warnings' && (
                <WarningsView warnings={warnings} />
              )}

              {activeTab === 'sources' && (
                <EnsembleView ensembleFc={currentFc} />
              )}

            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom tab bar */}
      <div className="bg-slate-800/95 backdrop-blur border-t border-slate-700 safe-bottom">
        <div className="flex max-w-lg mx-auto">
          <button
            onClick={() => changeTab('now')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'now' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <Thermometer size={22} strokeWidth={1.5} />
            <span>Nu</span>
          </button>
          <button
            onClick={() => changeTab('week')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'week' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <CalendarDays size={22} strokeWidth={1.5} />
            <span>Vecka</span>
          </button>
          <button
            onClick={() => changeTab('analysis')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'analysis' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <Sparkles size={22} strokeWidth={1.5} />
            <span>Analys</span>
          </button>
          <button
            onClick={() => changeTab('warnings')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'warnings' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <div className="relative">
              <TriangleAlert size={22} strokeWidth={1.5} />
              {warnings.some(w => WARNING_TRIANGLE_COLOR[w.level_code]) && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-orange-400" />
              )}
            </div>
            <span>Varningar</span>
          </button>
          <button
            onClick={() => changeTab('sources')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'sources' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <Layers size={22} strokeWidth={1.5} />
            <span>Källor</span>
          </button>
        </div>
      </div>
    </div>
  )
}
