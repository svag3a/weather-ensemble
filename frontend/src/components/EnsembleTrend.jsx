import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'

const DIR = {
  improving: { icon: '↓', color: 'text-green-400', bg: 'bg-green-400/10', label: 'Förbättras' },
  worsening: { icon: '↑', color: 'text-red-400',   bg: 'bg-red-400/10',   label: 'Försämras'  },
  stable:    { icon: '→', color: 'text-slate-400',  bg: 'bg-slate-700/40', label: 'Stabil'     },
}

function TrendBadge({ direction, pct }) {
  const d = DIR[direction] ?? DIR.stable
  const sign = pct > 0 ? '+' : ''
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${d.bg} ${d.color}`}>
      {d.icon} {d.label} {pct != null ? `(${sign}${pct}%)` : ''}
    </span>
  )
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs shadow-xl">
      <p className="text-slate-400 mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.dataKey} className="flex gap-2">
          <span style={{ color: p.color }}>{p.name}:</span>
          <span className="text-white font-mono">{p.value?.toFixed(p.dataKey === 'brier' ? 4 : 3)}</span>
        </div>
      ))}
    </div>
  )
}

export default function EnsembleTrend({ data }) {
  if (!data) return (
    <div className="bg-slate-800 rounded-xl p-4 text-slate-500 text-sm">Laddar trend…</div>
  )
  if (data.message) return (
    <div className="bg-slate-800 rounded-xl p-4 text-slate-500 text-sm">{data.message}</div>
  )

  const { daily, trend } = data
  const midDate = daily[Math.floor(daily.length / 2)]?.date

  return (
    <div className="bg-slate-800 rounded-xl p-5 space-y-4">
      <h2 className="text-lg font-semibold text-white">Ensembleprestanda — direkt mätning</h2>
      <p className="text-xs text-slate-500 -mt-2">
        1h-prognoser jämförda mot SMHI-observationer · {daily.length} dagar med data
      </p>

      {trend && (
        <div className="grid grid-cols-2 gap-3">
          {/* Temperature */}
          <div className="bg-slate-700/40 rounded-lg p-3 space-y-1.5">
            <div className="text-xs text-slate-400 font-medium">Temperatur MAE</div>
            <div className="flex items-baseline gap-2">
              <span className="text-white text-xl font-mono">{trend.temp_mae_new}°C</span>
              <span className="text-slate-500 text-xs">senaste {Math.floor(daily.length / 2)}d</span>
            </div>
            <TrendBadge direction={trend.direction} pct={trend.temp_pct_change} />
            <div className="text-xs text-slate-600">
              Tidigare: {trend.temp_mae_old}°C
            </div>
          </div>

          {/* Precipitation */}
          <div className="bg-slate-700/40 rounded-lg p-3 space-y-1.5">
            <div className="text-xs text-slate-400 font-medium">Regn Brier Score</div>
            <div className="flex items-baseline gap-2">
              <span className="text-white text-xl font-mono">{trend.brier_new}</span>
              <span className="text-slate-500 text-xs">senaste {Math.floor(daily.length / 2)}d</span>
            </div>
            <TrendBadge
              direction={
                (trend.brier_pct_change ?? 0) < -2 ? 'improving' :
                (trend.brier_pct_change ?? 0) > 2  ? 'worsening' : 'stable'
              }
              pct={trend.brier_pct_change}
            />
            <div className="text-xs text-slate-600">
              Tidigare: {trend.brier_old}
            </div>
          </div>
        </div>
      )}

      {/* Sparkline — temperature MAE */}
      {daily.length >= 3 && (
        <div>
          <p className="text-xs text-slate-500 mb-2">Temperatur MAE per dag (°C) — lägre är bättre</p>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={daily} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <XAxis
                dataKey="date"
                tickFormatter={d => d.slice(5)}
                tick={{ fill: '#475569', fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: '#1e293b' }}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: '#475569', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `${v}°`}
              />
              <Tooltip content={<CustomTooltip />} />
              {midDate && (
                <ReferenceLine x={midDate} stroke="#334155" strokeDasharray="3 3" />
              )}
              <Line
                type="monotone"
                dataKey="mae_temp"
                name="MAE temp"
                stroke="#60a5fa"
                strokeWidth={2}
                dot={{ r: 3, fill: '#60a5fa' }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <p className="text-xs text-slate-600">
        Streckad linje = mittpunkt · Procentändring = senaste halvan vs tidigare halvan av perioden
      </p>
    </div>
  )
}
