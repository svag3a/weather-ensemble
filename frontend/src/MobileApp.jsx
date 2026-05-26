import { useState, useEffect, useCallback, useRef } from 'react'
import { Thermometer, CalendarDays, Layers } from 'lucide-react'
import { fetchLocalForecast, fetchEnsemble, fetchRadarNow, fetchSources, fetchWeights } from './api'
import { getWeatherInfo, feelsLike } from './weatherSymbol'
import { generateSummary, summariseConfidence } from './summary'

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

  // Representative condition: worst precipitation daytime hour (07–20 UTC).
  // Falling back to all hours only if no daytime data exists.
  const daytime = hours.filter(h => {
    const utcH = parseTS(h.valid_for).getUTCHours()
    return utcH >= 7 && utcH < 20
  })
  const pool = daytime.length ? daytime : hours
  const rep = [...pool].sort((a, b) => b.precip_probability - a.precip_probability)[0]
  // Pass null for validFor — day summaries always use daytime symbols
  const { symbol } = getWeatherInfo(rep.temperature, rep.precip_probability, rep.wind_speed, rep.cloud_cover, null)

  const maxPrecipMm = Math.max(...hours.map(h => h.precip_mm ?? 0))
  const drops = rainDrops(maxPrecipMm)
  const totalPrecipMm = hours.reduce((s, h) => s + (h.precip_mm ?? 0), 0)
  const maxWind = Math.max(...hours.map(h => h.wind_speed ?? 0))

  return { minTemp, maxTemp, symbol, drops, totalPrecipMm, maxWind }
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
  const now = new Date()
  const rows = forecasts?.filter(fc => parseTS(fc.valid_for) > now).slice(0, 6) ?? []
  if (!rows.length) return null
  return (
    <div className="mt-4 border-t border-slate-700 pt-4 space-y-1">
      {rows.map((fc, i) => {
        const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for)
        const drops = rainDrops(fc.precip_mm)
        return (
          <div key={i} className="flex items-center gap-3 py-0.5">
            <span className="text-slate-400 font-mono text-xs w-12 shrink-0">{formatHour(fc.valid_for)}</span>
            <span className="text-lg w-6 text-center leading-none">{symbol}</span>
            <span className="text-white text-sm font-medium w-8">
              {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
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
    </div>
  )
}

function CurrentCard({ fc, radar, allForecasts }) {
  if (!fc) return (
    <div className="bg-slate-800 rounded-2xl p-6 text-slate-500 text-center">
      Hämtar prognos…
    </div>
  )

  const { symbol, label } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for)
  const feels = feelsLike(fc.temperature, fc.wind_speed)
  const conf = summariseConfidence(allForecasts)
  const summary = generateSummary(allForecasts)

  return (
    <div className="bg-slate-800 rounded-2xl p-6">
      {/* Temp + symbol */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-6xl leading-none">{symbol}</span>
          <span className="text-slate-400 text-sm mt-2">{label}</span>
        </div>
        <div className="text-right">
          <div className="text-7xl font-thin text-white leading-none">
            {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
          </div>
          {feels != null && (
            <div className="text-slate-400 text-sm mt-1">Känns som {feels}°</div>
          )}
        </div>
      </div>

      {/* Wind */}
      {fc.wind_speed != null && fc.wind_speed >= 3 && (
        <div className="mt-3 flex items-center gap-2 text-slate-300 text-sm">
          <span>💨</span>
          <span>
            {Math.round(fc.wind_speed)} m/s {windDirArrow(fc.wind_direction)}
            {fc.wind_speed >= 14 ? ' · Hård vind' : fc.wind_speed >= 8 ? ' · Frisk vind' : ''}
          </span>
        </div>
      )}

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

      {/* Confidence badge + summary */}
      <div className="mt-4 flex flex-col gap-2">
        <ConfidenceBadge conf={conf} />
        {summary && (
          <p className="text-slate-300 text-sm leading-relaxed">{summary}</p>
        )}
      </div>

      {/* 6-hour table */}
      <SixHourTable forecasts={allForecasts} />
    </div>
  )
}

function HourRow({ fc }) {
  const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for)
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

// ── WeekView ──────────────────────────────────────────────────────────────────

function tempBarColor(avg) {
  if (avg >= 22) return 'bg-orange-400'
  if (avg >= 16) return 'bg-yellow-400'
  if (avg >= 10) return 'bg-green-400'
  if (avg >=  4) return 'bg-teal-400'
  if (avg >=  0) return 'bg-blue-300'
  return 'bg-blue-500'
}

function TempBar({ dayMin, dayMax, weekMin, weekMax }) {
  const span = weekMax - weekMin || 1
  const left  = ((dayMin - weekMin) / span) * 100
  const width = Math.max(((dayMax - dayMin) / span) * 100, 6)
  const color = tempBarColor((dayMin + dayMax) / 2)
  return (
    <div className="relative h-1.5 bg-slate-700 rounded-full" style={{ minWidth: 80 }}>
      <div
        className={`absolute h-full rounded-full ${color}`}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
    </div>
  )
}

function WeekView() {
  const [weekForecast, setWeekForecast] = useState(null)
  const [loading, setLoading]           = useState(true)

  useEffect(() => {
    fetchEnsemble(168)
      .then(setWeekForecast)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="bg-slate-800 rounded-2xl p-6 text-slate-500 text-center">Hämtar prognos…</div>
  )
  if (!weekForecast) return (
    <div className="bg-slate-800 rounded-2xl p-6 text-slate-400 text-center text-sm">Kunde inte hämta prognos.</div>
  )

  const now     = new Date()
  const future  = weekForecast.filter(fc => parseTS(fc.valid_for) > now)
  const days    = groupByDay(future)
  const summaries = days.map(hours => ({ hours, ...getDaySummary(hours) }))

  const weekMin = Math.min(...summaries.map(s => s.minTemp ?? 99))
  const weekMax = Math.max(...summaries.map(s => s.maxTemp ?? -99))

  const cutoff48 = new Date(Date.now() + 48 * 3600 * 1000)

  return (
    <div className="bg-slate-800 rounded-2xl overflow-hidden">
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
        />
      ))}
    </div>
  )
}

function WeekDayRow({ hours, minTemp, maxTemp, symbol, totalPrecipMm, maxWind, weekMin, weekMax, isHourly }) {
  const [open, setOpen] = useState(false)
  const label      = dayLabel(hours[0].valid_for)
  const date       = dateLabel(hours[0].valid_for)
  const showPrecip = totalPrecipMm >= 0.1
  const showWind   = maxWind >= 8

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
          <div className="text-slate-500 text-xs">{date}</div>
        </div>

        {/* Symbol */}
        <span className="text-2xl w-8 text-center shrink-0">{symbol}</span>

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
        <span className={`text-slate-600 text-xs ml-1 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {open && (
        <div className="px-5 pb-4 border-t border-slate-700/50">
          {!isHourly && (
            <p className="text-slate-600 text-xs py-2">Prognos var 6:e timme</p>
          )}
          {detailRows.map((fc, j) => <HourRow key={j} fc={fc} />)}
        </div>
      )}
    </div>
  )
}

// ── Source name labels ────────────────────────────────────────────────────────

const SOURCE_LABELS = {
  smhi:                'SMHI',
  yr:                  'Yr.no',
  openweathermap:      'OpenWeatherMap',
  open_meteo:          'Open-Meteo',
  open_meteo_icon_eu:  'Open-Meteo ICON EU',
  open_meteo_ecmwf:    'Open-Meteo ECMWF',
  radar_nowcast:       'Radar',
  ensemble:            'Ensemble',
}

const SOURCE_ORDER = ['smhi', 'yr', 'openweathermap', 'open_meteo', 'open_meteo_icon_eu', 'open_meteo_ecmwf']

// ── EnsembleView ──────────────────────────────────────────────────────────────

function EnsembleView({ ensembleFc }) {
  const [sources, setSources] = useState(null)
  const [weights, setWeights] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetchSources(6), fetchWeights()])
      .then(([s, w]) => { setSources(s); setWeights(w) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="bg-slate-800 rounded-2xl p-6 text-slate-500 text-center">
      Hämtar källor…
    </div>
  )

  if (!sources) return (
    <div className="bg-slate-800 rounded-2xl p-6 text-slate-400 text-center text-sm">
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

  const displayOrder = SOURCE_ORDER.filter(s => currentBySource[s])

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
      <div className="bg-slate-800 rounded-2xl overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-slate-700">
          <h2 className="text-white font-medium text-sm">Källjämförelse — kl {hourLabel}</h2>
          <p className="text-slate-500 text-xs mt-0.5">Närmaste timme per källa</p>
        </div>

        {/* Header row */}
        <div className="flex items-center gap-2 px-5 py-2 text-slate-500 text-xs">
          <span className="flex-1">Källa</span>
          <span className="w-12 text-right">Temp</span>
          <span className="w-12 text-right">Regn%</span>
          <span className="w-14 text-right">Vind</span>
        </div>

        {/* Ensemble row */}
        {ensembleFc && (
          <div className="flex items-center gap-2 px-5 py-2.5 bg-slate-700/50 border-y border-slate-600/50">
            <span className="flex-1 text-white text-sm font-medium">Ensemble ★</span>
            <span className="w-12 text-right text-white text-sm font-mono">
              {ensembleFc.temperature != null ? `${Math.round(ensembleFc.temperature)}°` : '—'}
            </span>
            <span className={`w-12 text-right text-sm font-mono ${ensembleFc.precip_probability >= 40 ? 'text-blue-300' : 'text-slate-300'}`}>
              {Math.round(ensembleFc.precip_probability)}%
            </span>
            <span className="w-14 text-right text-slate-300 text-sm font-mono">
              {ensembleFc.wind_speed != null ? `${Math.round(ensembleFc.wind_speed)} m/s` : '—'}
            </span>
          </div>
        )}

        {/* Source rows */}
        {displayOrder.map(src => {
          const fc = currentBySource[src]
          return (
            <div key={src} className="flex items-center gap-2 px-5 py-2 border-b border-slate-700/40 last:border-0">
              <span className="flex-1 text-slate-300 text-sm">{SOURCE_LABELS[src] ?? src}</span>
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

      {/* Weight explanation */}
      {weightsAt1.length > 0 && (
        <div className="bg-slate-800 rounded-2xl p-5 space-y-3">
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
          <p className="text-slate-600 text-xs pt-1">
            Ensemblen viktar varje källa efter historisk träffsäkerhet. Bättre källa → högre vikt.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MobileApp() {
  const [forecast, setForecast] = useState(null)
  const [activeTab, setActiveTab] = useState('now')
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
  const future = forecast?.filter(fc => parseTS(fc.valid_for) > now) ?? []
  const currentFc = future[0] ?? null
  const days = groupByDay(future)

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 pb-20">
      <div className="px-4 pt-10 pb-4 space-y-3 max-w-lg mx-auto">

        {activeTab === 'now' && (
          <>
            <CurrentCard fc={currentFc} radar={radar} allForecasts={future} />
            {days.map((hours, i) => (
              <DayRow key={i} hours={hours} />
            ))}
          </>
        )}

        {activeTab === 'sources' && (
          <EnsembleView ensembleFc={currentFc} />
        )}

        {activeTab === 'week' && (
          <WeekView />
        )}

      </div>

      {/* Bottom tab bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-slate-800/95 backdrop-blur border-t border-slate-700 safe-bottom">
        <div className="flex max-w-lg mx-auto">
          <button
            onClick={() => setActiveTab('now')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'now' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <Thermometer size={22} strokeWidth={1.5} />
            <span>Nu</span>
          </button>
          <button
            onClick={() => setActiveTab('week')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'week' ? 'text-white' : 'text-slate-500'
            }`}
          >
            <CalendarDays size={22} strokeWidth={1.5} />
            <span>Vecka</span>
          </button>
          <button
            onClick={() => setActiveTab('sources')}
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
