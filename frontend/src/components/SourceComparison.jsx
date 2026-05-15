import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { addTimeLabels, formatIso } from '../timeLabels'

const SOURCE_COLORS = {
  smhi: '#22c55e',
  yr: '#a78bfa',
  open_meteo: '#facc15',
  open_meteo_icon_eu: '#fb923c',
  open_meteo_ecmwf: '#38bdf8',
  openweathermap: '#fb7185',
  radar_nowcast: '#e2e8f0',
}

const SOURCE_LABELS = {
  smhi: 'SMHI',
  yr: 'Yr.no',
  open_meteo: 'Open-Meteo',
  open_meteo_icon_eu: 'ICON-EU',
  open_meteo_ecmwf: 'ECMWF',
  openweathermap: 'OpenWeatherMap',
  radar_nowcast: 'Radar (nowcast)',
}

function buildChartData(sources, field) {
  const times = new Map()
  for (const [source, forecasts] of Object.entries(sources)) {
    for (const fc of forecasts) {
      if (!times.has(fc.valid_for)) times.set(fc.valid_for, { time: formatIso(fc.valid_for) })
      const val = field(fc)
      if (val != null) times.get(fc.valid_for)[source] = val
    }
  }
  return addTimeLabels([...times.values()])
}

function SourceLineChart({ data, sources, unit, domain }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="time" tick={{ fill: '#94a3b8', fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis domain={domain ?? ['auto', 'auto']} tick={{ fill: '#94a3b8', fontSize: 10 }} unit={unit} width={45} />
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #475569', borderRadius: 8 }}
          labelStyle={{ color: '#94a3b8' }}
          formatter={(v, name) => [`${v?.toFixed(1)}${unit}`, SOURCE_LABELS[name] ?? name]}
        />
        <Legend formatter={name => SOURCE_LABELS[name] ?? name} wrapperStyle={{ color: '#94a3b8', fontSize: 11 }} />
        {sources.map(src => (
          <Line key={src} type="monotone" dataKey={src} stroke={SOURCE_COLORS[src] ?? '#64748b'}
            dot={false} strokeWidth={1.5} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

function SourceBarChart({ data, sources, unit, domain }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="time" tick={{ fill: '#94a3b8', fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis domain={domain ?? [0, 100]} tick={{ fill: '#94a3b8', fontSize: 10 }} unit={unit} width={45} />
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #475569', borderRadius: 8 }}
          labelStyle={{ color: '#94a3b8' }}
          formatter={(v, name) => [`${v?.toFixed(1)}${unit}`, SOURCE_LABELS[name] ?? name]}
        />
        <Legend formatter={name => SOURCE_LABELS[name] ?? name} wrapperStyle={{ color: '#94a3b8', fontSize: 11 }} />
        {sources.map(src => (
          <Bar key={src} dataKey={src} fill={SOURCE_COLORS[src] ?? '#64748b'} opacity={0.7} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

export default function SourceComparison({ data }) {
  if (!data || !Object.keys(data).length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Ingen källdata tillgänglig än.
      </div>
    )
  }

  const sources = Object.keys(data)
  const tempData   = buildChartData(data, fc => fc.temperature)
  const precipData = buildChartData(data, fc => fc.precip_probability)
  const windData   = buildChartData(data, fc => fc.wind_speed)
  const cloudData  = buildChartData(data, fc => fc.cloud_cover)

  return (
    <div className="bg-slate-800 rounded-xl p-6 space-y-6">
      <h2 className="text-lg font-semibold text-white">Källjämförelse</h2>
      <div>
        <p className="text-xs text-slate-400 mb-2">Temperatur (°C)</p>
        <SourceLineChart data={tempData} sources={sources} unit="°" />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-2">Nederbördssannolikhet (%)</p>
        <SourceLineChart data={precipData} sources={sources} unit="%" domain={[0, 100]} />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-2">Vind (m/s)</p>
        <SourceLineChart data={windData} sources={sources} unit=" m/s" domain={[0, 'auto']} />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-2">Molnighet (%)</p>
        <SourceLineChart data={cloudData} sources={sources} unit="%" domain={[0, 100]} />
      </div>
    </div>
  )
}
