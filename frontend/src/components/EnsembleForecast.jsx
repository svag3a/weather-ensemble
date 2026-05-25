import { useState } from 'react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { addTimeLabels, formatIso } from '../timeLabels'
import { getWeatherInfo } from '../weatherSymbol'

const EXCLUDED_FROM_SPREAD = new Set(['radar_nowcast'])

function stdDev(values) {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
}

function buildSpreadMap(sources, field, clampLow = -Infinity, clampHigh = Infinity) {
  const buckets = new Map()
  if (!sources) return buckets
  for (const [source, forecasts] of Object.entries(sources)) {
    if (EXCLUDED_FROM_SPREAD.has(source)) continue
    for (const fc of forecasts) {
      const val = fc[field]
      if (val == null) continue
      const key = fc.valid_for
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(val)
    }
  }
  const result = new Map()
  for (const [key, values] of buckets) {
    if (values.length < 2) continue
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const sd = stdDev(values)
    result.set(key, {
      low:   Math.max(clampLow,  mean - sd),
      high:  Math.min(clampHigh, mean + sd),
      sd,
    })
  }
  return result
}

function spreadDomain(data, valueKey, padding = 1) {
  const vals = data.flatMap(d => {
    const v = d[valueKey]
    const lo = d['_spread_low']
    const hi = lo != null && d['_spread_delta'] != null ? lo + d['_spread_delta'] : null
    return [v, lo, hi].filter(x => x != null)
  })
  if (!vals.length) return ['auto', 'auto']
  return [Math.floor(Math.min(...vals)) - padding, Math.ceil(Math.max(...vals)) + padding]
}

function SpreadTooltip({ active, payload, label, dataKey, unit }) {
  if (!active || !payload?.length) return null
  const main  = payload.find(p => p.dataKey === dataKey)
  const low   = payload.find(p => p.dataKey === '_spread_low')
  const delta = payload.find(p => p.dataKey === '_spread_delta')
  if (!main) return null
  const spreadStr = (low != null && delta != null)
    ? ` ±${((delta.value ?? 0) / 2).toFixed(1)}`
    : ''
  return (
    <div style={{ background: '#1e293b', border: '1px solid #475569', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <p style={{ color: '#94a3b8', marginBottom: 4 }}>{label}</p>
      <p style={{ color: main.color }}>{main.value?.toFixed(1)}{unit}{spreadStr && <span style={{ color: '#64748b' }}>{spreadStr}</span>}</p>
    </div>
  )
}

function Chart({ data, dataKey, color, unit, domain, hasSpread }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="time" tick={{ fill: '#94a3b8', fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis domain={domain ?? ['auto', 'auto']} tick={{ fill: '#94a3b8', fontSize: 10 }} unit={unit} width={45} />
        <Tooltip content={<SpreadTooltip dataKey={dataKey} unit={unit} />} />
        {hasSpread && <>
          <Area type="monotone" dataKey="_spread_low"   stroke="none" fill="transparent" stackId="sp" isAnimationActive={false} />
          <Area type="monotone" dataKey="_spread_delta" stroke="none" fill={color} fillOpacity={0.15} stackId="sp" isAnimationActive={false} />
        </>}
        <Line type="monotone" dataKey={dataKey} stroke={color} dot={false} strokeWidth={2} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function SymbolRow({ data }) {
  const [tooltip, setTooltip] = useState(null)

  return (
    <div className="relative" style={{ height: 36 }}>
      <div style={{ marginLeft: 45, marginRight: 8, display: 'flex', height: '100%', alignItems: 'center' }}>
        {data.map((d, i) => {
          const { symbol, label } = getWeatherInfo(d.temperature, d.precip_probability, d.wind_speed, d.cloud_cover, d.valid_for)
          return (
            <div key={i} style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              {i % 3 === 0 && (
                <span
                  style={{ fontSize: 20, cursor: 'default', lineHeight: 1 }}
                  onMouseEnter={e => setTooltip({ d, label, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setTooltip(null)}
                >
                  {symbol}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {tooltip && (
        <div
          className="fixed z-50 bg-slate-800 border border-slate-600 rounded-lg p-3 text-sm pointer-events-none shadow-xl"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <p className="text-white font-medium mb-2">{tooltip.d.time} — {tooltip.label}</p>
          <p className="text-orange-400">🌡 {tooltip.d.temperature?.toFixed(1)}°C</p>
          <p className="text-blue-400">🌧 {tooltip.d.precip_probability?.toFixed(0)}% nederbörd</p>
          <p className="text-sky-400">💨 {tooltip.d.wind_speed?.toFixed(1)} m/s</p>
          <p className="text-slate-300">☁️ {tooltip.d.cloud_cover?.toFixed(0)}% molnighet</p>
        </div>
      )}
    </div>
  )
}

export default function EnsembleForecast({ data, sources }) {
  if (!data?.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Ingen ensemble-prognos tillgänglig än. Trigga en insamling först.
      </div>
    )
  }

  const tempSpread   = buildSpreadMap(sources, 'temperature')
  const precipSpread = buildSpreadMap(sources, 'precip_probability', 0, 100)
  const windSpread   = buildSpreadMap(sources, 'wind_speed', 0)
  const cloudSpread  = buildSpreadMap(sources, 'cloud_cover', 0, 100)

  function withSpread(d, spreadMap) {
    const sp = spreadMap.get(d.valid_for)
    if (!sp) return { _spread_low: undefined, _spread_delta: undefined }
    return {
      _spread_low:   sp.low,
      _spread_delta: Math.max(0, sp.high - sp.low),
    }
  }

  const tempData   = addTimeLabels(data.map(d => ({ time: formatIso(d.valid_for), temperature: d.temperature, precip_probability: d.precip_probability, wind_speed: d.wind_speed, cloud_cover: d.cloud_cover, 'Temp (°C)': d.temperature,   ...withSpread(d, tempSpread)   })))
  const precipData = addTimeLabels(data.map(d => ({ time: formatIso(d.valid_for), 'Nederbörd (%)': d.precip_probability, ...withSpread(d, precipSpread) })))
  const windData   = addTimeLabels(data.map(d => ({ time: formatIso(d.valid_for), 'Vind (m/s)':    d.wind_speed,         ...withSpread(d, windSpread)   })))
  const cloudData  = addTimeLabels(data.map(d => ({ time: formatIso(d.valid_for), 'Molnighet (%)': d.cloud_cover,        ...withSpread(d, cloudSpread)  })))

  return (
    <div className="bg-slate-800 rounded-xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Ensemble-prognos</h2>
        <p className="text-xs text-slate-500">Skuggat band = modellspridning ±1σ</p>
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-1">Vädersymboler (var 3:e timme)</p>
        <SymbolRow data={tempData} />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-2">Temperatur (°C)</p>
        <Chart data={tempData}   dataKey="Temp (°C)"    color="#f97316" unit="°"    domain={spreadDomain(tempData, 'Temp (°C)')} hasSpread={tempSpread.size > 0} />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-2">Nederbördssannolikhet (%)</p>
        <Chart data={precipData} dataKey="Nederbörd (%)" color="#3b82f6" unit="%"   domain={[0, 100]} hasSpread={precipSpread.size > 0} />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-2">Vind (m/s)</p>
        <Chart data={windData}   dataKey="Vind (m/s)"   color="#38bdf8" unit=" m/s" domain={spreadDomain(windData, 'Vind (m/s)', 0)} hasSpread={windSpread.size > 0} />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-2">Molnighet (%)</p>
        <Chart data={cloudData}  dataKey="Molnighet (%)" color="#94a3b8" unit="%"   domain={[0, 100]} hasSpread={cloudSpread.size > 0} />
      </div>
    </div>
  )
}
