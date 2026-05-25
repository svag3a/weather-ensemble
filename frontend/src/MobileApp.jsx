import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchLocalForecast, fetchEnsemble, fetchRadarNow } from './api'
import { getWeatherInfo } from './weatherSymbol'

// ── Hooks ────────────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSameDay(a, b) {
  const da = new Date(a), db = new Date(b)
  return da.getUTCFullYear() === db.getUTCFullYear()
    && da.getUTCMonth() === db.getUTCMonth()
    && da.getUTCDate() === db.getUTCDate()
}

function formatHour(iso) {
  return `${new Date(iso).getUTCHours().toString().padStart(2, '0')}:00`
}

function dayLabel(isoString) {
  const d = new Date(isoString)
  const today = new Date()
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1)
  const sameDay = (a, b) =>
    a.getUTCFullYear() === b.getFullYear() &&
    a.getUTCMonth() === b.getMonth() &&
    a.getUTCDate() === b.getDate()

  if (sameDay(d, today))    return 'Idag'
  if (sameDay(d, tomorrow)) return 'Imorgon'
  return d.toLocaleDateString('sv-SE', { weekday: 'long', timeZone: 'UTC' })
    .replace(/^\w/, c => c.toUpperCase())
}

function dateLabel(isoString) {
  return new Date(isoString).toLocaleDateString('sv-SE', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  })
}

function windDirArrow(deg) {
  if (deg == null || isNaN(deg)) return ''
  return ['↓','↙','←','↖','↑','↗','→','↘'][Math.round(deg / 45) % 8]
}

function rainDrops(mm) {
  if (mm == null || mm < 0.1) return null
  if (mm < 0.5)  return '💧'
  if (mm < 2.0)  return '💧💧'
  if (mm < 5.0)  return '💧💧💧'
  if (mm < 10.0) return '💧💧💧💧'
  return '💧💧💧💧💧'
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

function getDaySummary(hours) {
  const temps = hours.map(h => h.temperature).filter(t => t != null)
  const minTemp = temps.length ? Math.round(Math.min(...temps)) : null
  const maxTemp = temps.length ? Math.round(Math.max(...temps)) : null

  // Representative condition: worst precipitation hour, or midday if dry
  const rep = [...hours].sort((a, b) => b.precip_probability - a.precip_probability)[0]
  const { symbol } = getWeatherInfo(rep.temperature, rep.precip_probability, rep.wind_speed, rep.cloud_cover)

  const maxPrecipMm = Math.max(...hours.map(h => h.precip_mm ?? 0))
  const drops = rainDrops(maxPrecipMm)

  return { minTemp, maxTemp, symbol, drops }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CurrentCard({ fc, radar }) {
  if (!fc) return (
    <div className="bg-slate-800 rounded-2xl p-6 text-slate-500 text-center">
      Hämtar prognos…
    </div>
  )

  const { symbol, label } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover)

  return (
    <div className="bg-slate-800 rounded-2xl p-6">
      <div className="flex items-center justify-between">
        {/* Left: symbol + label */}
        <div className="flex flex-col gap-1">
          <span className="text-6xl leading-none">{symbol}</span>
          <span className="text-slate-400 text-sm mt-2">{label}</span>
        </div>

        {/* Right: temperature */}
        <span className="text-7xl font-thin text-white leading-none">
          {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
        </span>
      </div>

      {/* Wind */}
      {fc.wind_speed != null && fc.wind_speed >= 3 && (
        <div className="mt-4 flex items-center gap-2 text-slate-300 text-sm">
          <span>💨</span>
          <span>
            {Math.round(fc.wind_speed)} m/s {windDirArrow(fc.wind_direction)}
            {fc.wind_speed >= 14 ? ' · Hård vind' : fc.wind_speed >= 8 ? ' · Frisk vind' : ''}
          </span>
        </div>
      )}

      {/* CAPE instability — only show when meaningfully elevated */}
      {radar?.cape != null && radar.cape >= 300 && (
        <div className="mt-2 flex items-center gap-2 text-xs text-yellow-300/80 px-3">
          <span>⚡</span>
          <span>
            {radar.cape >= 2500 ? 'Extremt instabil luft — hagel/åska sannolikt'
             : radar.cape >= 1000 ? 'Instabil luft — åska möjlig'
             : 'Viss instabilitet'}
          </span>
        </div>
      )}
    </div>
  )
}

function HourRow({ fc }) {
  const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover)
  const drops = rainDrops(fc.precip_mm)
  return (
    <div className="flex items-center gap-3 py-2 border-b border-slate-700/50 last:border-0">
      <span className="text-slate-400 font-mono text-xs w-12 shrink-0">{formatHour(fc.valid_for)}</span>
      <span className="text-xl w-7 text-center">{symbol}</span>
      <span className="text-white font-medium w-10">
        {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
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

function DayRow({ hours }) {
  const [open, setOpen] = useState(false)
  const { minTemp, maxTemp, symbol, drops } = getDaySummary(hours)
  const label = dayLabel(hours[0].valid_for)
  const date = dateLabel(hours[0].valid_for)

  return (
    <div className="bg-slate-800 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-4 active:bg-slate-700/50 transition-colors"
      >
        {/* Day name + date */}
        <div className="flex-1 text-left">
          <span className="text-white font-medium">{label}</span>
          <span className="text-slate-500 text-sm ml-2">{date}</span>
        </div>

        {/* Symbol */}
        <span className="text-2xl">{symbol}</span>

        {/* Temp range */}
        <span className="text-sm font-mono text-slate-300 w-16 text-right">
          {minTemp != null ? `${minTemp}–${maxTemp}°` : '—'}
        </span>

        {/* Rain */}
        <span className="text-xs w-10 text-center">{drops ?? <span className="text-slate-700">—</span>}</span>

        {/* Chevron */}
        <span className={`text-slate-600 text-xs transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {open && (
        <div className="px-5 pb-4 border-t border-slate-700/50">
          {hours.map((fc, i) => <HourRow key={i} fc={fc} />)}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MobileApp() {
  const [forecast, setForecast] = useState(null)
  const { radar, coords } = useRadarLocation()

  const load = useCallback(async () => {
    try {
      setForecast(coords
        ? await fetchLocalForecast(coords.lat, coords.lon, 48)
        : await fetchEnsemble(48))
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
  const future = forecast?.filter(fc => new Date(fc.valid_for) > now) ?? []
  const currentFc = future[0] ?? null
  const days = groupByDay(future)

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <div className="px-4 pt-10 pb-10 space-y-3 max-w-lg mx-auto">

        <CurrentCard fc={currentFc} radar={radar} />

        {days.map((hours, i) => (
          <DayRow key={i} hours={hours} />
        ))}

      </div>
    </div>
  )
}
