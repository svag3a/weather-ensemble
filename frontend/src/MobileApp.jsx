import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createNoise2D } from 'simplex-noise'
import { AnimatePresence, motion } from 'framer-motion'
import { Thermometer, CalendarDays, ChartSpline, TriangleAlert, Sparkles, Zap, Clock, TrendingUp, Lightbulb, ShieldCheck, Shirt, Umbrella, Glasses, Waves, TreePine, Footprints, Sailboat, Sun, Moon, Droplet, Droplets, UtensilsCrossed, Coffee, Martini, Beer, Utensils, User, Star, MapPin, Bell } from 'lucide-react'

function JacketIcon({ size = 24, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      {/* Jacket outline: collar → left shoulder → left sleeve (horizontal) →
          left armhole → left body → bottom → right body → right armhole →
          right sleeve → right shoulder → right collar */}
      <path d="M8 4 L4 7 L3 11 L3 15 L8 15 L8 20 L16 20 L16 15 L21 15 L21 11 L20 7 L16 4 L14 2 L12 5 L10 2 Z" />
      {/* Zipper/button line */}
      <line x1="12" y1="5" x2="12" y2="20" />
    </svg>
  )
}
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { fetchLocalForecast, fetchEnsemble, fetchRadarNow, fetchRainNowcast, fetchSources, fetchWeights, fetchWarnings, triggerCollect, fetchSummary, fetchCityImages, fetchSunTerraces, fetchTopTerraces } from './api'
import SolView from './components/SolView'
import { getWeatherInfo, feelsLike, sunTimesUTC } from './weatherSymbol'
import { getWeatherMomentum } from './weatherMomentum'
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
  const [rainTimeline, setRainTimeline] = useState(null)
  const [coords, setCoords] = useState(null)
  const timerRef = useRef(null)

  const poll = useCallback(async (lat, lon) => {
    try { setRadar(await fetchRadarNow(lat, lon)) } catch {}
    try { const r = await fetchRainNowcast(lat, lon); setRainTimeline(r.timeline) } catch {}
  }, [])

  const locate = useCallback(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude
      const lon = pos.coords.longitude
      setCoords({ lat, lon })
      poll(lat, lon)
    })
  }, [poll])

  useEffect(() => {
    const start = (lat, lon) => {
      setCoords({ lat, lon })
      poll(lat, lon)
      timerRef.current = setInterval(locate, 5 * 60 * 1000)
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
  }, [poll, locate])

  return { radar, rainTimeline, coords, locate }
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

function getSkyTheme(gradient) {
  // Extract bottom hex color from "linear-gradient(to bottom, #xxx, #yyy)"
  if (!gradient) return 'dark'
  const match = gradient.match(/#([0-9a-f]{6})\s*\)$/i)
  if (!match) return 'dark'
  const hex = match[1]
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const toLinear = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  return lum > 0.2 ? 'light' : 'dark'
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

  const urbanAnchors = [
    [0,              '#0f172a', '#1e3a5f'],
    [sr - 1,         '#1e293b', '#334155'],
    [sr,             '#1e3a5f', '#4a7fa5'],
    [sr + 1,         '#1d4ed8', '#93c5fd'],
    [sr + 3,         '#0284c7', '#bae6fd'],
    [(sr + ss) / 2,  '#0369a1', '#7dd3fc'],
    [ss - 2,         '#0284c7', '#bae6fd'],
    [ss - 1,         '#1e40af', '#93c5fd'],
    [ss,             '#1e3a5f', '#334155'],
    [ss + 1,         '#1e293b', '#0f172a'],
    [ss + 2,         '#0f172a', '#1e3a5f'],
    [24,             '#0f172a', '#1e3a5f'],
  ]
  const anchors = urbanAnchors
    .filter(([h]) => h >= 0 && h <= 24).sort((a, b) => a[0] - b[0])

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

function WeatherParticles({ precip = 0, temperature = 10, radar = null }) {
  const isSnow = temperature < 1
  // Boost effective precip if radar confirms active rain right now
  const effectivePrecip = (radar?.raining && radar?.dbz != null)
    ? Math.max(precip, radar.dbz >= 35 ? 80 : radar.dbz >= 25 ? 60 : 30)
    : precip
  const count  = effectivePrecip >= 80 ? 55 : effectivePrecip >= 60 ? 35 : effectivePrecip >= 30 ? 15 : 0

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

// Returns [count, useDouble] where count=1–3 droplets, useDouble=show Droplets icon
function rainDropLevel(mm) {
  if (mm == null || mm < 0.5) return null
  if (mm < 2.0)  return 1
  if (mm < 6.0)  return 2
  return 3
}

function RainDrops({ mm, size = 12 }) {
  const level = rainDropLevel(mm)
  if (!level) return null
  const color = '#93c5fd'  // blue-300
  return (
    <span className="inline-flex items-center gap-px leading-none">
      {Array.from({ length: level }).map((_, i) => (
        <Droplet key={i} size={size} className="shrink-0" style={{ color, fill: color }} />
      ))}
    </span>
  )
}

// Legacy string helper for places that still need a string (getDaySummary drops field)
function rainDrops(mm) {
  return rainDropLevel(mm)  // returns 1-3 or null — callers now use RainDrops component
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

  const totalPrecipMm = hours.reduce((s, h) => s + (h.precip_mm ?? 0), 0)
  const maxWind = Math.max(...hours.map(h => h.wind_speed ?? 0))

  return { minTemp, maxTemp, symbol, totalPrecipMm, maxWind }
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
  return <TriangleAlert size={12} className={color} title={`${warning.level_label}: ${warning.event}`} />
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
    <div className="mt-4 border-t border-slate-700 pt-4">
      <div className="max-w-xs mx-auto space-y-1">
      {rows.map((fc, i) => {
        const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for, 0, fc.fog_probability ?? 0, fc.precip_mm ?? 0)
        const drops = fc.precip_probability >= 20 ? fc.precip_mm : null
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
            <span className="w-8 flex justify-end"><RainDrops mm={drops} size={10}/></span>
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
    </div>
  )
}

// ── Star canvas ───────────────────────────────────────────────────────────────
// Coordinates J2000: [ra_hours, dec_degrees, visual_magnitude]
// ~120 brightest stars visible from Göteborg (dec > -35°)
const STAR_CATALOG = [
  // Sirius region
  [6.753, -16.72, -1.46], [6.378, -17.96,  1.98], [6.977, -28.97,  1.50],
  // Arcturus / Boötes
  [14.261, 19.18, -0.05], [14.749, 27.07,  2.37], [15.032, 40.39,  3.49],
  // Vega / Lyra
  [18.616, 38.78,  0.03], [18.835, 33.36,  3.52], [18.982, 32.69,  3.24],
  // Capella / Auriga
  [5.278,  45.998, 0.08], [5.992,  44.95,  1.90], [4.950,  33.17,  2.69],
  // Orion
  [5.242,  -8.202, 0.13], [5.920,   7.407, 0.45], [5.419,   6.350, 1.64],
  [5.533,  -0.300, 2.23], [5.603,  -1.202, 1.69], [5.680,  -1.943, 1.77],
  [5.796,  -9.670, 2.06],
  // Procyon / CMi
  [7.655,   5.217, 0.38], [7.452,   8.289, 2.89],
  // Altair / Aquila
  [19.847,  8.867, 0.77], [19.771, 10.613, 2.72],
  // Aldebaran / Taurus
  [4.598,  16.509, 0.87], [5.438,  28.608, 1.65], [3.793,  24.113, 2.87],
  [4.476,  15.953, 3.42],
  // Spica / Virgo
  [13.420, -11.161, 1.04], [12.695, -1.450, 2.74],
  // Antares / Scorpius
  [16.490, -26.432, 1.06],
  // Gemini
  [7.755,  28.026, 1.16], [7.577,  31.883, 1.58],
  [6.628,  16.400, 1.93], [6.383,  22.514, 2.88],
  // Fomalhaut
  [22.960, -29.62, 1.16],
  // Deneb / Cygnus
  [20.690, 45.280, 1.25], [20.370, 40.257, 2.23], [20.770, 33.970, 2.48],
  [19.512, 27.960, 3.05], [19.749, 45.130, 2.87],
  // Regulus / Leo
  [10.140, 11.967, 1.36], [11.818, 14.572, 2.14], [10.332, 19.842, 2.14],
  [10.278, 23.417, 3.44],
  // Ursa Major (Big Dipper)
  [12.900, 55.958, 1.76], [11.062, 61.750, 1.81], [13.792, 49.317, 1.86],
  [11.031, 56.382, 2.37], [11.897, 53.695, 2.44], [12.257, 57.033, 3.32],
  [13.398, 54.925, 2.23],
  // Ursa Minor + Polaris
  [2.530,  89.264, 2.02], [14.845, 74.155, 2.08], [15.345, 71.834, 3.05],
  // Cassiopeia
  [0.675,  56.537, 2.23], [0.153,  59.150, 2.27], [0.945,  60.717, 2.15],
  [1.432,  60.234, 2.68], [1.907,  63.670, 3.35],
  // Perseus
  [3.405,  49.861, 1.81], [3.137,  40.957, 2.12], [3.080,  53.502, 2.93],
  // Mirfak already above
  // Ophiuchus
  [17.582, 12.550, 2.08], [17.173, -15.725, 2.43],
  // Corona Borealis
  [15.578, 26.714, 2.23],
  // Hercules
  [16.503, 21.490, 2.78], [17.244, 14.390, 3.31],
  // Andromeda
  [0.140,  29.090, 2.07], [1.162,  35.620, 2.06], [2.065,  42.330, 2.10],
  // Pegasus (Great Square)
  [23.080, 15.206, 2.49], [23.063, 28.083, 2.44],
  [0.220,  15.183, 2.83], [21.737,  9.875, 2.38],
  // Aquarius
  [21.527, -5.571, 2.87], [22.097, -0.320, 2.95],
  // Aries / Cetus
  [2.120,  23.462, 2.00], [0.727, -17.987, 2.04], [3.038,  4.090, 2.53],
  // Cepheus
  [21.310, 62.583, 2.45], [21.478, 70.561, 3.23],
  // Draco
  [17.943, 51.489, 2.24], [17.507, 52.301, 2.79],
  // Miscellaneous
  [14.261, 19.180, 2.89], // Cor Caroli (CVn)
  [9.460,  -8.659, 2.00], // Alphard (Hya)
  [15.737,  6.426, 2.63], // Unukalhai (Ser)
  [5.132,  -5.086, 2.79], // Cursa (Eri)
  [3.967, -13.509, 2.95], // Zaurak (Eri)
  [8.275,   9.186, 3.52], // Altarf (Cnc)
  [10.372, 41.500, 3.05], // Tania Australis (UMa)
  [8.987,  48.042, 3.14], // Talitha (UMa)
  [14.530, 30.372, 3.46], // Seginus (Boo)
  [19.043,-29.880, 2.59], // Ascella (Sgr, low)
  [18.921,-26.297, 2.05], // Nunki (Sgr, low)
  [3.820,  24.054, 3.63], // Atlas (Pleiades)
]

const GBG_LAT = 57.7089
const GBG_LON = 11.9746

function _gmstHours(date) {
  const D = date.getTime() / 86400000 + 2440587.5 - 2451545.0
  const g = (18.697374558 + 24.06570982441908 * D) % 24
  return g < 0 ? g + 24 : g
}

function _sunAltDeg(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360
  const g = ((357.528 + 0.9856003 * n) % 360 + 360) % 360
  const gR = g * Math.PI / 180
  const lam = (L + 1.915 * Math.sin(gR) + 0.02 * Math.sin(2 * gR)) * Math.PI / 180
  const eps = (23.439 - 0.0000004 * n) * Math.PI / 180
  const raSun = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam))
  const decSun = Math.asin(Math.sin(eps) * Math.sin(lam))
  const lst = (_gmstHours(date) + GBG_LON / 15 + 24) % 24
  const H = ((lst - raSun * 12 / Math.PI) % 24 + 24) % 24 * 15 * Math.PI / 180
  const lat = GBG_LAT * Math.PI / 180
  return Math.asin(Math.sin(lat) * Math.sin(decSun) + Math.cos(lat) * Math.cos(decSun) * Math.cos(H)) * 180 / Math.PI
}

function _raDecToAltAz(raH, decDeg, lstH) {
  const H = ((lstH - raH) % 24 + 24) % 24 * 15 * Math.PI / 180
  const dec = decDeg * Math.PI / 180
  const lat = GBG_LAT * Math.PI / 180
  const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H))
  const az  = Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H))
  return { alt: alt * 180 / Math.PI, az: ((az * 180 / Math.PI) + 360) % 360 }
}

function StarCanvas() {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const W = parent.offsetWidth
      const H = parent.offsetHeight
      const dpr = window.devicePixelRatio || 1
      canvas.width  = W * dpr
      canvas.height = H * dpr
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, W, H)

      const now    = new Date()
      const sunAlt = _sunAltDeg(now)
      if (sunAlt > -6) return   // too bright, nothing to draw

      const lst = (_gmstHours(now) + GBG_LON / 15 + 24) % 24

      for (const [ra, dec, mag] of STAR_CATALOG) {
        const { alt, az } = _raDecToAltAz(ra, dec, lst)
        if (alt < 1) continue   // below horizon

        // Magnitude-aware fade per twilight depth
        let opacity = 0
        if (sunAlt <= -18) {
          opacity = Math.min(1, (5.5 - mag) / 3.5)
        } else if (sunAlt <= -12) {
          const t = (-sunAlt - 12) / 6        // 0→1 as sun goes -12→-18
          const magLim = 1.0 + t * 4.5        // opens from mag 1 to 5.5
          if (mag > magLim) continue
          opacity = Math.min(1, (magLim - mag + 0.5)) * Math.min(1, t * 1.8 + 0.2)
        } else {
          // nautical twilight (-6 to -12): only mag < 1.5
          if (mag > 1.5) continue
          opacity = ((-sunAlt - 6) / 6) * 0.85
        }
        if (opacity < 0.03) continue

        // Equirectangular: az 0-360 → x, alt 0-90 → y (0=bottom)
        const x = (az / 360) * W
        const y = H * (1 - alt / 90)
        const r = Math.max(0.45, 1.9 - mag * 0.28)

        // Soft glow for bright stars (mag < 2)
        if (mag < 2.0) {
          const gr = ctx.createRadialGradient(x, y, 0, x, y, r * 4)
          gr.addColorStop(0, `rgba(255,252,230,${(opacity * 0.35).toFixed(2)})`)
          gr.addColorStop(1, 'rgba(255,252,230,0)')
          ctx.beginPath()
          ctx.arc(x, y, r * 4, 0, Math.PI * 2)
          ctx.fillStyle = gr
          ctx.fill()
          // Also draw at wrapped position
          const x2 = x < W / 2 ? x + W : x - W
          const gr2 = ctx.createRadialGradient(x2, y, 0, x2, y, r * 4)
          gr2.addColorStop(0, `rgba(255,252,230,${(opacity * 0.35).toFixed(2)})`)
          gr2.addColorStop(1, 'rgba(255,252,230,0)')
          ctx.beginPath()
          ctx.arc(x2, y, r * 4, 0, Math.PI * 2)
          ctx.fillStyle = gr2
          ctx.fill()
        }

        ctx.globalAlpha = Math.min(1, opacity)
        ctx.fillStyle = 'rgba(255,252,235,1)'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        // Wrapped copy for seamless horizon edge
        const x2 = x < W / 2 ? x + W : x - W
        ctx.beginPath()
        ctx.arc(x2, y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    draw()
    const id = setInterval(draw, 60_000)
    return () => clearInterval(id)
  }, [])

  return (
    <canvas
      ref={ref}
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 0,
      }}
    />
  )
}

// ── Cloud canvas ──────────────────────────────────────────────────────────────

function CloudCanvas({ cloudCover = 0, windSpeed = 2, precipProbability = 0, speedMult = 1, opacityMult = 1, noiseOffset = 0 }) {
  const canvasRef  = useRef(null)
  const animRef    = useRef(null)
  const offsetRef  = useRef(0)
  const noise2D    = useRef(createNoise2D())  // Math.random() seed → unique per instance

  // Draw cloud texture into the canvas (3× card width for seamless drift)
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || canvas.width === 0) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    const coverage  = Math.max(0, cloudCover - 15) / 85
    const isRainy   = precipProbability > 40
    const isGloomy  = cloudCover > 70
    // Base lightness: 230 (bright white) → 170 (grey) → 120 (storm dark)
    const baseLightness = isRainy ? 120 : isGloomy ? 170 : 230
    const maxAlpha  = Math.round(100 * opacityMult)
    const threshold = 0.25 - coverage * 0.7

    const noise = noise2D.current
    const idata = ctx.createImageData(w, h)
    const data  = idata.data

    const tileW = w / 2
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {               // full card height (#4)
        const nx = (x % tileW) / tileW * 4.5 + noiseOffset
        const ny = y / h * 3.0 + noiseOffset * 0.5
        const n = noise(nx, ny)      * 0.55
               + noise(nx*2, ny*2)  * 0.30
               + noise(nx*4, ny*4)  * 0.15
        if (n > threshold) {
          const density = Math.min(1, (n - threshold) / 0.45)
          // Fade out in bottom third — fully transparent at bottom edge
          const fade  = y < h * 2/3 ? 1 : Math.max(0, 1 - (y - h * 2/3) / (h / 3))
          const alpha = Math.round(density * density * maxAlpha * fade)
          if (alpha > 3) {
            // Color variation: slow noise adds ±25 for natural cloud shading (#5)
            const colorVar = Math.round(noise(nx * 0.3, ny * 0.3) * 25)
            const r = Math.min(255, Math.max(0, baseLightness + colorVar))
            const g = Math.min(255, Math.max(0, baseLightness + Math.round(colorVar * 0.9)))
            const b = Math.min(255, Math.max(0, baseLightness + Math.round(colorVar * 0.8)))
            const i = (y * w + x) * 4
            data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = alpha
          }
        }
      }
    }
    ctx.putImageData(idata, 0, 0)
  }, [cloudCover, precipProbability])

  // Size canvas to 2× card width (seamless tile: right half = left half), then draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const card = canvas.parentElement
    if (!card) return
    canvas.width  = card.offsetWidth * 2   // 2× for seamless loop
    canvas.height = card.offsetHeight
    draw()
  }, [draw])

  // Seamless drift animation: canvas is 2× wide, reset at -cardWidth → no jump
  useEffect(() => {
    if (cloudCover < 15) return
    // Beaufort 3 ≈ 4 m/s → moderate drift; Beaufort 8 ≈ 20 m/s → fast
    const speed = Math.max(0.02, (windSpeed ?? 2) * 0.067 * speedMult)
    const cardW = () => (canvasRef.current?.parentElement?.offsetWidth ?? 360)

    const step = () => {
      offsetRef.current -= speed
      if (offsetRef.current <= -cardW()) offsetRef.current = 0  // seamless reset
      if (canvasRef.current)
        canvasRef.current.style.transform = `translateX(${offsetRef.current}px)`
      animRef.current = requestAnimationFrame(step)
    }
    animRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(animRef.current)
  }, [cloudCover, windSpeed])

  if (cloudCover < 15) return null

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', top: 0, left: 0,
        height: '100%', pointerEvents: 'none',
        willChange: 'transform', zIndex: 1,
      }}
    />
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

function PrecipChance({ prob, skyTheme }) {
  if (prob == null) return null
  const p = Math.round(prob)
  const color = p >= 60 ? '#60a5fa' : p >= 30 ? '#93c5fd' : skyTheme === 'light' ? '#94a3b8' : '#475569'
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span style={{ fontSize: 18, lineHeight: 1 }}>💧</span>
      <span className="text-xs font-medium" style={{ color }}>{p}%</span>
    </div>
  )
}

function BeaufortGauge({ windSpeed, windDirection, skyTheme }) {
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
            backgroundColor: i <= bf.bft ? color : skyTheme === 'light' ? 'rgba(30,41,59,0.5)' : 'rgba(148,163,184,0.2)',
            borderRadius: 1,
          }} />
        ))}
      </div>
      <div className="text-xs font-medium text-center" style={{ color: skyTheme === 'light' ? '#475569' : '#cbd5e1' }}>
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

function CurrentCard({ fc, radar, allForecasts, motifImage, skyGradient, skyTheme }) {
  if (!fc) return (
    <div className={`${GLASS} rounded-2xl p-6 text-slate-500 text-center`}>
      Hämtar prognos…
    </div>
  )

  const { symbol, label } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for, radar?.cape ?? 0, fc.fog_probability ?? 0, fc.precip_mm ?? 0, radar?.raining ?? false, radar?.dbz ?? null)
  const feels = feelsLike(fc.temperature, fc.wind_speed)

  // Text colours adapt to sky brightness
  const light = skyTheme === 'light'
  const cPrimary   = light ? 'text-slate-900'  : 'text-white'
  const cSecondary = light ? 'text-slate-700'  : 'text-slate-300'
  const cMuted     = light ? 'text-slate-600'  : 'text-slate-400'
  const border     = light ? 'border-slate-300/60' : 'border-white/10'

  return (
    <div
      className={`rounded-2xl relative overflow-hidden backdrop-blur-sm border ${border}`}
      style={{ minHeight: 312, background: skyGradient ?? 'rgba(0,0,0,0.2)' }}
    >
      {/* Stars — beneath clouds, z-index 0 */}
      <StarCanvas />

      {/* Two cloud layers at different speeds for depth parallax */}
      <CloudCanvas cloudCover={Math.max(0, (fc.cloud_cover ?? 0) - 10)} windSpeed={fc.wind_speed ?? 2} precipProbability={fc.precip_probability ?? 0} speedMult={0.55} opacityMult={0.75} noiseOffset={47.3} />
      <CloudCanvas cloudCover={fc.cloud_cover ?? 0} windSpeed={fc.wind_speed ?? 2} precipProbability={fc.precip_probability ?? 0} speedMult={1.45} opacityMult={1.0} noiseOffset={0} />
      <WeatherParticles precip={fc.precip_probability ?? 0} temperature={fc.temperature ?? 10} radar={radar} />

      {/* Motif anchored to bottom at natural aspect ratio */}
      {motifImage && (
        <img
          src={motifImage.url}
          alt={motifImage.label}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: 'auto',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}

      {/* Motif label — top right, readable on any background */}
      {motifImage?.label && (
        <span
          className="absolute top-3 right-3 text-xs text-white"
          style={{ zIndex: 3, textShadow: '0 1px 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.5)', pointerEvents: 'none' }}
        >
          {motifImage.label}
        </span>
      )}
    </div>
  )
}

function WindGaugeSemi({ windSpeed, windDirection }) {
  const bf = getBeaufort(windSpeed)
  if (!bf) return null

  const color = bf.bft <= 4 ? '#2dd4bf'
              : bf.bft <= 7 ? '#facc15'
              : bf.bft <= 9 ? '#fb923c'
              : '#ef4444'

  const cx = 40, cy = 40, r = 32, sw = 6
  const toXY = (deg) => {
    const rad = (deg * Math.PI) / 180
    return { x: +(cx + r * Math.cos(rad)).toFixed(2), y: +(cy - r * Math.sin(rad)).toFixed(2) }
  }

  const left  = toXY(180)
  const right = toXY(0)
  const currDeg = 180 * (1 - bf.bft / 12)
  const curr  = toXY(currDeg)

  // Upper semi-circle: sweep=1 (clockwise on screen), large-arc=0
  const bgPath   = `M ${left.x} ${left.y} A ${r} ${r} 0 0 1 ${right.x} ${right.y}`
  const fillPath = bf.bft > 0
    ? `M ${left.x} ${left.y} A ${r} ${r} 0 0 1 ${curr.x} ${curr.y}`
    : null

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 80 46" width="70" style={{ display: 'block' }}>
        <path d={bgPath} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth={sw} strokeLinecap="round" />
        {fillPath && (
          <path d={fillPath} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        )}
        {bf.bft > 0 && <circle cx={curr.x} cy={curr.y} r={4} fill={color} />}
        {/* Wind direction arrow centred inside the arc */}
        <text x="40" y="38" textAnchor="middle" dominantBaseline="middle"
          fontSize="18" fill={color} style={{ userSelect: 'none' }}>
          {windDirArrow(windDirection)}
        </text>
      </svg>
      <span className="text-xs text-slate-400 text-center" style={{ marginTop: -2 }}>
        {bf.label}
      </span>
    </div>
  )
}

function fmtSunHour(decHours) {
  const h = Math.floor(((decHours % 24) + 24) % 24)
  const m = Math.round((decHours % 1) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function WeatherBanner({ fc, radar, coords, forecastHours }) {
  if (!fc) return null
  const { symbol, label } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for, radar?.cape ?? 0, fc.fog_probability ?? 0, fc.precip_mm ?? 0, radar?.raining ?? false, radar?.dbz ?? null)
  const feels = feelsLike(fc.temperature, fc.wind_speed)
  const momentum = getWeatherMomentum(fc, forecastHours ?? [])

  return (
    <div className={`${GLASS} rounded-2xl flex items-center px-5 py-4`}>
      {/* 1. Weather symbol */}
      <div className="flex flex-col items-center gap-1" style={{ flex: '1.4', marginLeft: -10 }}>
        <span className="text-4xl leading-none"><WeatherSymbol symbol={symbol} /></span>
        <span className="text-slate-400 text-xs text-center leading-tight">{label}</span>
      </div>

      <div className="w-px self-stretch bg-white/10 shrink-0" />

      {/* 2. Temperature */}
      <div className="flex-1 flex flex-col items-center gap-1" style={{ marginLeft: 6 }}>
        <span className={`text-white text-4xl font-thin leading-none${feels == null ? ' mt-2' : ''}`}>
          {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
        </span>
        {feels != null
          ? <span className="text-slate-400 text-xs">Känns {feels}°</span>
          : null}
      </div>

      <div className="w-px self-stretch bg-white/10 shrink-0" />

      {/* 3. Wind gauge */}
      <div className="flex-1 flex justify-center">
        <WindGaugeSemi windSpeed={fc.wind_speed ?? 0} windDirection={fc.wind_direction} />
      </div>

      {/* 4. Weather momentum — symbol when change expected, dash when stable */}
      <div className="w-px self-stretch bg-white/10 shrink-0" />
      <div className="flex-1 flex flex-col items-center gap-1">
        {momentum.visible ? (
          <>
            <span className="text-2xl leading-none">{momentum.symbol}</span>
            <span className={`text-xs text-center leading-tight ${
              momentum.direction === 'worsening' ? 'text-slate-400' : 'text-emerald-400'
            }`}>{momentum.label}</span>
          </>
        ) : (
          <span className="text-slate-600 text-2xl leading-none">—</span>
        )}
      </div>
    </div>
  )
}

function HourRow({ fc }) {
  const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for, 0, fc.fog_probability ?? 0, fc.precip_mm ?? 0)
  // Only show drops when precip_probability ≥ 20 — same threshold as rain symbol
  const drops = fc.precip_probability >= 20 ? fc.precip_mm : null
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
      <span className="w-12 flex justify-end items-center">{drops != null ? <RainDrops mm={drops} size={11}/> : <span className="text-slate-700 text-xs">—</span>}</span>
    </div>
  )
}

function DayRow({ hours, warnings, weekMin, weekMax }) {
  const [open, setOpen] = useState(false)
  const { minTemp, maxTemp, symbol, totalPrecipMm } = getDaySummary(hours)
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

// ── WeekDaysAccordion — accordion wrapper for WeekDayRow list ─────────────────

function WeekDaysAccordion({ visibleDays, summaries, wMin, wMax, cutoff48, warnings }) {
  const [openIdx, setOpenIdx] = useState(null)

  function toggle(i) {
    setOpenIdx(prev => prev === i ? null : i)
  }

  return (
    <div className={`${GLASS} rounded-2xl overflow-hidden`}>
      {visibleDays.map((hours, i) => {
        const { minTemp, maxTemp, symbol, totalPrecipMm, maxWind } = summaries[i]
        return (
          <WeekDayRow
            key={i}
            hours={hours}
            minTemp={minTemp}
            maxTemp={maxTemp}
            symbol={symbol}
            totalPrecipMm={totalPrecipMm}
            maxWind={maxWind}
            weekMin={wMin}
            weekMax={wMax}
            isHourly={parseTS(hours[0].valid_for) < cutoff48}
            warnings={warnings}
            open={openIdx === i}
            onToggle={() => toggle(i)}
          />
        )
      })}
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

function WeekDayRow({ hours, minTemp, maxTemp, symbol, totalPrecipMm, maxWind, weekMin, weekMax, isHourly, warnings, open: openProp, onToggle }) {
  const [openInternal, setOpenInternal] = useState(false)
  const open   = openProp !== undefined ? openProp : openInternal
  const toggle = onToggle ?? (() => setOpenInternal(o => !o))
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
        onClick={toggle}
        className="w-full flex items-center gap-3 px-5 py-3.5 active:bg-slate-700/50 transition-colors"
      >
        {/* Day name + date + optional warning icon */}
        <div className="w-24 shrink-0 text-left">
          <div className="flex items-center gap-1.5">
            <span className="text-white text-sm font-medium leading-tight">{label}</span>
            <WarningTriangle warning={warning} />
          </div>
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

function WarningsBanner({ warnings }) {
  const [open, setOpen] = useState(false)
  const active = warnings.filter(w => WARNING_TRIANGLE_COLOR[w.level_code])
  if (!active.length) return null

  const topColor = WARNING_TRIANGLE_COLOR[active[0].level_code]
  const summary = active.length === 1
    ? active[0].event
    : `${active.length} aktiva SMHI-varningar`

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl w-full text-left"
        style={{ background: 'rgba(251,146,60,0.10)', border: '1px solid rgba(251,146,60,0.20)' }}
      >
        <TriangleAlert size={13} className={`${topColor} shrink-0`} />
        <span className="text-orange-300 text-xs flex-1 leading-snug">{summary}</span>
        <span className="text-orange-400/50 text-xs">›</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-3xl px-5 pt-5 pb-8 space-y-4"
            style={{ background: '#0f172a', maxHeight: '80vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-white font-semibold text-base">SMHI-varningar</span>
              <button onClick={() => setOpen(false)} className="text-slate-400 text-xl leading-none px-1">×</button>
            </div>
            {active.map((w, i) => <WarningCard key={i} warning={w} />)}
            <p className="text-white/30 text-xs pt-1">Uppdateras var 30:e minut · Källa: SMHI IBW</p>
          </div>
        </div>
      )}
    </>
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

function EnsembleView({ ensembleFc, prefetchedSources, prefetchedWeights }) {
  const [sources, setSources]         = useState(prefetchedSources ?? null)
  const [ensembleFcs, setEnsembleFcs] = useState(null)
  const [weights, setWeights]         = useState(prefetchedWeights ?? null)
  const [loading, setLoading]         = useState(!prefetchedSources || !prefetchedWeights)

  useEffect(() => {
    // Use prefetched data if available, otherwise fetch
    const needsSources  = !prefetchedSources
    const needsWeights  = !prefetchedWeights
    const promises = [
      needsSources  ? fetchSources(48)  : Promise.resolve(prefetchedSources),
      needsWeights  ? fetchWeights()    : Promise.resolve(prefetchedWeights),
      fetchEnsemble(48),
    ]
    Promise.all(promises)
      .then(([s, w, ens]) => { setSources(s); setWeights(w); setEnsembleFcs(ens) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [prefetchedSources, prefetchedWeights])

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

function AnalysView({ prefetchedToday, prefetchedTomorrow }) {
  const [period, setPeriod] = useState('today')
  const prefetched = period === 'today' ? prefetchedToday : prefetchedTomorrow
  const [summary, setSummary] = useState(prefetched ?? null)
  const [loading, setLoading] = useState(!prefetched)
  const [error, setError] = useState(null)
  const [detailOpen, setDetailOpen] = useState(false)

  useEffect(() => {
    const cached = period === 'today' ? prefetchedToday : prefetchedTomorrow
    if (cached) { setSummary(cached); setLoading(false); return }
    setLoading(true)
    setError(null)
    setSummary(null)
    setDetailOpen(false)
    fetchSummary(period)
      .then(setSummary)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [period, prefetchedToday, prefetchedTomorrow])

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

            {/* Practical advice — moved up for quick access */}
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
                  const tempAvg = ((p.temp_min ?? 12) + (p.temp_max ?? 16)) / 2
                  const precip  = p.precip_max ?? 0
                  const wind    = p.wind_max   ?? 0
                  const clouds  = p.cloud_avg  ?? 80
                  const tMax = p.temp_max ?? tempAvg
                  const tMin = p.temp_min ?? tempAvg
                  const isNight = p.name === 'Natt'
                  // Windchill-adjusted apparent temperature for clothing
                  const apparent = feelsLike(tempAvg, wind) ?? (wind > 5 ? tempAvg - wind * 0.4 : tempAvg)
                  const ClothIcon = apparent < 16 ? JacketIcon : Shirt
                  // Accessory: umbrella on real rain risk; sunglasses on clear sky (not temp-dependent)
                  const AccIcon =
                    precip > 40                           ? Umbrella :
                    !isNight && clouds < 40 && precip < 30 ? Glasses  :
                                                             null
                  // Activity: priority order, daytime only — filtered by user's activity preferences
                  const _actPref = loadActPref()
                  const _act = k => !_actPref || _actPref.has(k)
                  const ActivityIcon = isNight ? null :
                    _act('badliv')       && tMax > 23 && precip < 20 && wind < 8                   ? Waves           :
                    _act('uteservering') && tempAvg > 17 && precip < 30 && wind < 8 && clouds < 70 ? UtensilsCrossed :
                    _act('segling')      && wind >= 4 && wind <= 10 && precip < 30 && tMin > 14    ? Sailboat        :
                    _act('natur')        && tMin > 10 && precip < 40 && wind < 12                  ? TreePine        :
                    _act('promenad')     && tMin > 8  && precip < 50                               ? Footprints      :
                                                                                                     null
                  return (
                    <div key={i} className="flex items-start gap-3 px-5 py-3 border-b border-slate-700/50 last:border-0">
                      <div className="w-20 shrink-0">
                        <div className="text-white text-xs font-medium">{p.name}</div>
                        <div className="text-slate-400 text-xs">{p.from}–{p.to}</div>
                        <div className="flex gap-1.5 mt-1.5">
                          <ClothIcon size={14} color="white" />
                          {AccIcon && <AccIcon size={14} color="white" />}
                          {ActivityIcon && <ActivityIcon size={14} color="white" />}
                        </div>
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

const TAB_ORDER = ['now', 'sol', 'analysis', 'sources', 'profile']

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

// ── Profile view ─────────────────────────────────────────────────────────────

const FAVS_KEY_P      = 'sol_favourites'
const FAV_DATA_KEY_P  = 'sol_favourites_data'
const UV_PREF_KEY     = 'sol_uv_threshold'
const SOL_RADIUS_KEY  = 'sol_radius'
const SOL_TIME_KEY    = 'sol_time_pref'
const SOL_ACT_KEY     = 'sol_activities'
const NOTIF_SUN_KEY   = 'notif_sun_window'
const NOTIF_UV_KEY    = 'notif_uv'
const VENUE_ICONS_P   = { cafe: Coffee, bar: Martini, pub: Beer, restaurant: Utensils }

const TIME_SLOTS = [
  { key: 'förmiddag',  label: 'Förmiddag',  hint: '6–12'  },
  { key: 'eftermiddag', label: 'Eftermiddag', hint: '12–18' },
  { key: 'kväll',      label: 'Kväll',       hint: '18–24' },
]

const ALL_ACTIVITIES = [
  { key: 'badliv',        label: 'Badliv',         Icon: Waves         },
  { key: 'uteservering',  label: 'Uteservering',    Icon: UtensilsCrossed },
  { key: 'segling',       label: 'Segling',         Icon: Sailboat      },
  { key: 'natur',         label: 'Natur',           Icon: TreePine      },
  { key: 'promenad',      label: 'Promenad',        Icon: Footprints    },
]

function loadFavsP()    { try { return new Set(JSON.parse(localStorage.getItem(FAVS_KEY_P) || '[]')) } catch { return new Set() } }
function loadFavDataP() { try { return JSON.parse(localStorage.getItem(FAV_DATA_KEY_P) || '{}') } catch { return {} } }
function loadRadiusPref() { try { return parseFloat(localStorage.getItem(SOL_RADIUS_KEY)) || 2.0 } catch { return 2.0 } }
function loadTimePrefP()  { try { return new Set(JSON.parse(localStorage.getItem(SOL_TIME_KEY) || '[]')) } catch { return new Set() } }
function loadActPref()    { try { const s = localStorage.getItem(SOL_ACT_KEY); return s ? new Set(JSON.parse(s)) : null } catch { return null } }

function ProfileView({ onNavigateToSol }) {
  const [favs]         = useState(loadFavsP)
  const [favData]      = useState(loadFavDataP)
  const [uvThreshold, setUvThreshold] = useState(
    () => { try { return parseInt(localStorage.getItem(UV_PREF_KEY) || '6') } catch { return 6 } }
  )
  const [timePref, setTimePref] = useState(loadTimePrefP)
  const [radius, setRadius]     = useState(loadRadiusPref)
  const [actPref, setActPref]   = useState(() => loadActPref() ?? new Set(ALL_ACTIVITIES.map(a => a.key)))
  const [notifSun, setNotifSun] = useState(() => localStorage.getItem(NOTIF_SUN_KEY) === 'true')
  const [notifUv,  setNotifUv]  = useState(() => localStorage.getItem(NOTIF_UV_KEY)  === 'true')

  const favorites = [...favs].map(id => favData[id]).filter(Boolean)

  function handleUv(v) {
    setUvThreshold(v)
    localStorage.setItem(UV_PREF_KEY, String(v))
  }

  function toggleTime(key) {
    setTimePref(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      localStorage.setItem(SOL_TIME_KEY, JSON.stringify([...next]))
      return next
    })
  }

  function handleRadius(v) {
    setRadius(v)
    localStorage.setItem(SOL_RADIUS_KEY, String(v))
  }

  function toggleActivity(key) {
    setActPref(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        if (next.size === 1) return prev  // keep at least one
        next.delete(key)
      } else {
        next.add(key)
      }
      localStorage.setItem(SOL_ACT_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const UV_LEVELS = [
    { v: 3,  label: 'Låg',       color: 'text-green-400'  },
    { v: 6,  label: 'Måttlig',   color: 'text-yellow-400' },
    { v: 8,  label: 'Hög',       color: 'text-orange-400' },
    { v: 11, label: 'Mycket hög', color: 'text-red-400'   },
  ]
  const uvLabel = UV_LEVELS.slice().reverse().find(l => uvThreshold >= l.v) ?? UV_LEVELS[0]

  return (
    <div className="px-4 pt-10 pb-8 space-y-3 max-w-lg mx-auto">

      {/* Favourites */}
      <div className={`${GLASS} rounded-2xl overflow-hidden`}>
        <div className="px-5 pt-4 pb-3 border-b border-slate-700 flex items-center gap-2">
          <Star size={13} className="text-amber-400 shrink-0" />
          <span className="text-white text-sm font-medium">Favoritställen</span>
          {favorites.length > 0 && (
            <span className="text-slate-500 text-xs ml-auto">{favorites.length}</span>
          )}
        </div>
        {favorites.length === 0 ? (
          <div className="px-5 py-6 text-center space-y-2">
            <p className="text-slate-400 text-xs">Inga favoriter än.</p>
            <button
              onClick={onNavigateToSol}
              className="text-amber-400 text-xs touch-manipulation"
            >
              Gå till sol-vyn och stjärnmärk ställen →
            </button>
          </div>
        ) : (
          <>
            {favorites.map(v => {
              const Icon = VENUE_ICONS_P[v.amenity_type]
              return (
                <div key={v.id} className="flex items-center gap-3 px-5 py-3 border-b border-slate-700/50 last:border-0">
                  {Icon && <Icon size={13} className="text-slate-400 shrink-0" strokeWidth={1.5} />}
                  <span className="text-white text-xs flex-1">{v.name}</span>
                </div>
              )
            })}
            <button
              onClick={onNavigateToSol}
              className="w-full px-5 py-3 text-amber-400 text-xs text-right border-t border-slate-700/50 touch-manipulation"
            >
              Visa i sol-vyn →
            </button>
          </>
        )}
      </div>

      {/* Solpreferenser */}
      <div className={`${GLASS} rounded-2xl px-5 py-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <Clock size={13} className="text-amber-400 shrink-0" />
          <span className="text-white text-sm font-medium">Solpreferens</span>
          {timePref.size === 0 && <span className="text-slate-500 text-xs ml-auto">Ingen inställd</span>}
        </div>
        <div className="flex gap-2">
          {TIME_SLOTS.map(({ key, label, hint }) => {
            const active = timePref.has(key)
            return (
              <button
                key={key}
                onPointerUp={() => toggleTime(key)}
                className={`flex-1 py-2 rounded-xl text-xs font-medium transition-colors touch-manipulation select-none ${
                  active ? 'bg-amber-500/25 text-amber-300 border border-amber-500/40'
                         : 'bg-white/5 text-slate-400 border border-white/5'
                }`}
              >
                <div>{label}</div>
                <div className="text-[10px] opacity-60 mt-0.5">{hint}</div>
              </button>
            )
          })}
        </div>
        <p className="text-slate-500 text-xs">Förmarkerar tidsfilter när du öppnar sol-vyn.</p>
      </div>

      {/* Standardradius */}
      <div className={`${GLASS} rounded-2xl px-5 py-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <MapPin size={13} className="text-slate-400 shrink-0" />
          <span className="text-white text-sm font-medium">Standardradius</span>
          <span className="text-slate-400 text-xs ml-auto">{radius} km</span>
        </div>
        <input
          type="range" min="0.5" max="10" step="0.5" value={radius}
          onChange={e => handleRadius(parseFloat(e.target.value))}
          className="sol-slider w-full"
          style={{'--fill': `${(radius - 0.5) / 9.5 * 100}%`}}
        />
        <p className="text-slate-500 text-xs">Sökradie som används som standard i sol-vyn.</p>
      </div>

      {/* Aktivitetspreferenser */}
      <div className={`${GLASS} rounded-2xl overflow-hidden`}>
        <div className="px-5 pt-4 pb-3 border-b border-slate-700 flex items-center gap-2">
          <TreePine size={13} className="text-slate-400 shrink-0" />
          <span className="text-white text-sm font-medium">Aktiviteter</span>
        </div>
        {ALL_ACTIVITIES.map(({ key, label, Icon }) => {
          const on = actPref.has(key)
          return (
            <button
              key={key}
              onPointerUp={() => toggleActivity(key)}
              className="w-full flex items-center gap-3 px-5 py-3 border-b border-slate-700/50 last:border-0 touch-manipulation select-none active:bg-white/5 transition-colors"
            >
              <Icon size={14} className={on ? 'text-white shrink-0' : 'text-slate-600 shrink-0'} strokeWidth={1.5} />
              <span className={`flex-1 text-xs text-left ${on ? 'text-white' : 'text-slate-500'}`}>{label}</span>
              <span className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[10px] ${
                on ? 'bg-white/20 border-white/40 text-white' : 'border-slate-600 text-transparent'
              }`}>✓</span>
            </button>
          )
        })}
        <p className="px-5 py-3 text-slate-500 text-xs">Vilka aktiviteter visas i analysvy under "Under dagen".</p>
      </div>

      {/* UV threshold */}
      <div className={`${GLASS} rounded-2xl px-5 py-4 space-y-3`}>
        <div className="flex items-center gap-2">
          <Sun size={13} className="text-yellow-400 shrink-0" />
          <span className="text-white text-sm font-medium">UV-varning</span>
          <span className={`text-xs ml-auto ${uvLabel.color}`}>UV {uvThreshold}+ · {uvLabel.label}</span>
        </div>
        <input
          type="range" min="3" max="11" step="1" value={uvThreshold}
          onChange={e => handleUv(parseInt(e.target.value))}
          className="sol-slider w-full"
          style={{'--fill': `${(uvThreshold - 3) / 8 * 100}%`}}
        />
        <p className="text-slate-500 text-xs">Varna mig i sol-vyn när UV-index överstiger detta värde.</p>
      </div>

      {/* Notiser */}
      <div className={`${GLASS} rounded-2xl overflow-hidden`}>
        <div className="px-5 pt-4 pb-3 border-b border-slate-700 flex items-center gap-2">
          <Bell size={13} className="text-slate-400 shrink-0" />
          <span className="text-white text-sm font-medium">Notiser</span>
        </div>
        {[
          { key: NOTIF_SUN_KEY,  state: notifSun,  set: setNotifSun,  label: 'Sol-fönster',  desc: 'Påminn när ett bra solläge öppnar sig.' },
          { key: NOTIF_UV_KEY,   state: notifUv,   set: setNotifUv,   label: 'UV-varning',   desc: `Påminn när UV-index överstiger ${uvThreshold}.` },
        ].map(({ key, state, set, label, desc }) => (
          <button
            key={key}
            onPointerUp={() => { const next = !state; set(next); localStorage.setItem(key, String(next)) }}
            className="w-full flex items-center gap-3 px-5 py-3.5 border-b border-slate-700/50 last:border-0 touch-manipulation select-none active:bg-white/5 transition-colors"
          >
            <div className="flex-1 text-left">
              <div className={`text-xs font-medium ${state ? 'text-white' : 'text-slate-400'}`}>{label}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{desc}</div>
            </div>
            {/* iOS-style toggle */}
            <div className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${state ? 'bg-amber-500' : 'bg-slate-600'}`}>
              <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${state ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
          </button>
        ))}
        <p className="px-5 py-3 text-slate-600 text-[11px]">Push-notiser aktiveras när appen installeras som native-app.</p>
      </div>

    </div>
  )
}

// ── Sol just nu card ──────────────────────────────────────────────────────────

function RainBand({ timeline }) {
  if (!timeline || timeline.length === 0) return null
  const hasRain = timeline.some(s => s.raining)
  if (!hasRain) return null

  function dbzToColor(dbz) {
    if (dbz === null || dbz === undefined) return 'rgba(255,255,255,0.05)'
    if (dbz < 20) return 'rgba(147,197,253,0.40)'
    if (dbz < 30) return 'rgba(96,165,250,0.70)'
    if (dbz < 40) return 'rgba(59,130,246,0.90)'
    return 'rgba(29,78,216,0.98)'
  }

  const n = timeline.length
  const stops = timeline.map((step, i) => {
    const pct = ((i / (n - 1)) * 100).toFixed(1)
    return `${dbzToColor(step.dbz)} ${pct}%`
  })
  const gradient = `linear-gradient(to right, ${stops.join(', ')})`

  return (
    <div className="rounded-2xl px-4 py-3" style={{ background: 'rgba(23,37,84,0.35)', border: '1px solid rgba(96,165,250,0.18)' }}>
      <div className="flex items-center gap-2 mb-2.5">
        <Droplets size={13} className="text-blue-400 shrink-0" />
        <span className="text-blue-300 text-sm font-medium">Regnband</span>
      </div>
      <div className="h-4 rounded-lg" style={{ background: gradient }} />
      <div className="flex justify-between mt-1.5">
        {timeline.map((step, i) => (
          <span key={i} style={{ fontSize: '10px', color: 'rgba(147,197,253,0.65)' }}>
            {step.offset_min === 0 ? 'Nu' : `+${step.offset_min}`}
          </span>
        ))}
      </div>
    </div>
  )
}

const VENUE_TYPE_ICONS_TOP = { cafe: Coffee, bar: Martini, pub: Beer, restaurant: Utensils }

function SolNuCard({ data, onViewAll }) {
  if (!data || data.venues.length === 0) return null
  const { venues, sun_window, has_sun_now } = data
  const label = has_sun_now ? 'Sol just nu' : 'Sol snart'

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.18)' }}>
      <div className="px-4 pt-3.5 pb-2 flex items-center gap-2">
        <Sun size={13} className="text-amber-400 shrink-0" />
        <span className="text-amber-300 text-sm font-medium">{label}</span>
        {sun_window && (
          <span className="text-amber-600 text-xs ml-0.5">· {sun_window.from}–{sun_window.to}</span>
        )}
      </div>
      <div>
        {venues.map((v, i) => {
          const Icon = VENUE_TYPE_ICONS_TOP[v.amenity_type]
          const dist = v.distance_km < 1
            ? `${Math.round(v.distance_km * 1000)} m`
            : `${v.distance_km} km`
          const score = v.now_score >= 45 ? v.now_score : v.best_score
          const filled = Math.round(score / 25)
          return (
            <div key={v.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-amber-500/10">
              {Icon && <Icon size={13} className="text-amber-500/70 shrink-0" strokeWidth={1.5} />}
              <span className="text-white text-xs font-medium flex-1 truncate">{v.name}</span>
              <span className="text-slate-500 text-xs shrink-0">{dist}</span>
              <div className="flex gap-0.5 shrink-0">
                {[1,2,3,4].map(d => (
                  <div key={d} className={`w-1 h-3.5 rounded-sm ${d <= filled ? 'bg-amber-400' : 'bg-white/10'}`} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <button
        onClick={onViewAll}
        className="w-full px-4 py-2.5 text-amber-400 text-xs font-medium text-right border-t border-amber-500/10 touch-manipulation"
      >
        Visa alla ställen →
      </button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MobileApp() {
  const [forecast, setForecast]   = useState(null)
  const [warnings, setWarnings]   = useState([])
  const [sources, setSources]         = useState(null)
  const [weights, setWeights]         = useState(null)
  const [summaryToday, setSummaryToday]       = useState(null)
  const [summaryTomorrow, setSummaryTomorrow] = useState(null)
  const [topTerraces, setTopTerraces]         = useState(null)
  const [prefetchedTerraces, setPrefetchedTerraces] = useState(null)
  const [activeTab, setActiveTab] = useState('now')
  const [slideDir, setSlideDir] = useState(1)
  const { radar, rainTimeline, coords, locate } = useRadarLocation()
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

  // Prefetch sources data so the Sources tab opens instantly
  useEffect(() => {
    const loadSources = () => Promise.all([
      fetchSources(48).catch(() => null),
      fetchWeights().catch(() => null),
    ]).then(([s, w]) => { setSources(s); setWeights(w) })
    loadSources()
    const interval = setInterval(loadSources, 10 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // Prefetch AI summaries so the Analysis tab opens instantly
  useEffect(() => {
    const loadSummaries = () => {
      fetchSummary('today').then(setSummaryToday).catch(() => {})
      fetchSummary('tomorrow').then(setSummaryTomorrow).catch(() => {})
    }
    loadSummaries()
    const interval = setInterval(loadSummaries, 70 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const load = useCallback(async () => {
    try {
      setForecast(coords
        ? await fetchLocalForecast(coords.lat, coords.lon, 168)
        : await fetchEnsemble(168))
    } catch {}
    if (coords) {
      try { setTopTerraces(await fetchTopTerraces({ lat: coords.lat, lon: coords.lon })) } catch {}
      try {
        const terraces = await fetchSunTerraces({
          lat: coords.lat, lon: coords.lon,
          radius: loadRadiusPref(),
          type: 'all',
          tags: [...loadTimePrefP()].join(','),
          min_score: 25,
        })
        setPrefetchedTerraces(terraces)
      } catch {}
    }
  }, [coords])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const interval = setInterval(load, 10 * 60 * 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        locate()   // refresh GPS immediately → triggers coords update → load() reruns
        load()     // also reload forecast with current coords while GPS resolves
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible) }
  }, [load, locate])

  const now = new Date()
  const future = forecast?.filter(fc => parseTS(fc.valid_for) > now) ?? []
  const currentFc = future[0] ?? null
  const days = groupByDay(future)

  return (
    <div className="fixed inset-0 bg-slate-900 text-slate-100 flex flex-col">

      {/* Animated content area */}
      <div className="flex-1 relative overflow-x-hidden min-h-0" {...swipeHandlers}>


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
                  {(() => {
                    const sky = getSkyCss(currentFc, coords)
                    return <>
                      <CurrentCard fc={currentFc} radar={radar} allForecasts={future} motifImage={motifImage} skyGradient={sky.gradient} skyTheme={getSkyTheme(sky.gradient)} />
                      <WeatherBanner fc={currentFc} radar={radar} coords={coords} forecastHours={future} />
                      <RainBand timeline={rainTimeline} />
                    </>
                  })()}

                  {warnings.some(w => WARNING_TRIANGLE_COLOR[w.level_code]) && (
                    <WarningsBanner warnings={warnings} />
                  )}


                  {!(rainTimeline && rainTimeline.some(s => s.raining)) && (
                    <SolNuCard data={topTerraces} onViewAll={() => changeTab('sol')} />
                  )}

                  {/* Dagsprognos accordion — idag + kommande dagar */}
                  {(() => {
                    const today      = days[0] ? [days[0]] : []
                    const futureDays = days.slice(1).filter(h => h.length >= 23)
                    const visibleDays = [...today, ...futureDays]
                    const summaries   = visibleDays.map(getDaySummary)
                    const wMin = Math.min(...summaries.map(s => s.minTemp ?? 99))
                    const wMax = Math.max(...summaries.map(s => s.maxTemp ?? -99))
                    const cutoff48 = new Date(Date.now() + 48 * 3600 * 1000)
                    return (
                      <WeekDaysAccordion
                        visibleDays={visibleDays}
                        summaries={summaries}
                        wMin={wMin}
                        wMax={wMax}
                        cutoff48={cutoff48}
                        warnings={warnings}
                      />
                    )
                  })()}
                </>
              )}

              {activeTab === 'analysis' && (
                <AnalysView prefetchedToday={summaryToday} prefetchedTomorrow={summaryTomorrow} />
              )}

              {activeTab === 'sources' && (
                <EnsembleView ensembleFc={currentFc} prefetchedSources={sources} prefetchedWeights={weights} />
              )}

              {activeTab === 'sol' && (
                <SolView coords={coords} initialData={prefetchedTerraces} />
              )}

              {activeTab === 'profile' && (
                <ProfileView onNavigateToSol={() => changeTab('sol')} />
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
            <div className="relative">
              <Thermometer size={22} strokeWidth={1.5} />
              {warnings.some(w => WARNING_TRIANGLE_COLOR[w.level_code]) && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-orange-400" />
              )}
            </div>
            <span>Väder</span>
          </button>
          <button
            onClick={() => changeTab('sol')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'sol' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <Sun size={22} strokeWidth={1.5} />
            <span>Sol</span>
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
            onClick={() => changeTab('sources')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'sources' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <ChartSpline size={22} strokeWidth={1.5} />
            <span>Statistik</span>
          </button>
          <button
            onClick={() => changeTab('profile')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'profile' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <User size={22} strokeWidth={1.5} />
            <span>Profil</span>
          </button>
        </div>
      </div>
    </div>
  )
}
