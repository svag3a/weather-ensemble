import { useState, useEffect, useCallback, useRef } from 'react'
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
  const { symbol } = getWeatherInfo(rep.temperature, rep.precip_probability, rep.wind_speed, rep.cloud_cover, rep.valid_for)

  const maxPrecipMm = Math.max(...hours.map(h => h.precip_mm ?? 0))
  const drops = rainDrops(maxPrecipMm)

  return { minTemp, maxTemp, symbol, drops }
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
  const rows = forecasts?.filter(fc => new Date(fc.valid_for) > now).slice(0, 6) ?? []
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
    const upcoming = fcs.filter(fc => new Date(fc.valid_for) > now)
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
    ? `${new Date(ensembleFc.valid_for).getUTCHours().toString().padStart(2, '0')}:00`
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
  const future = forecast?.filter(fc => new Date(fc.valid_for) > now) ?? []
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

      </div>

      {/* Bottom tab bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-slate-800/95 backdrop-blur border-t border-slate-700 safe-bottom">
        <div className="flex max-w-lg mx-auto">
          <button
            onClick={() => setActiveTab('now')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'now' ? 'text-white' : 'text-slate-500 active:text-slate-300'
            }`}
          >
            <span className="text-lg leading-none">🌤</span>
            <span>Nu</span>
          </button>
          <button
            onClick={() => setActiveTab('sources')}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              activeTab === 'sources' ? 'text-white' : 'text-slate-500 active:text-slate-300'
            }`}
          >
            <span className="text-lg leading-none">📊</span>
            <span>Källor</span>
          </button>
        </div>
      </div>
    </div>
  )
}
