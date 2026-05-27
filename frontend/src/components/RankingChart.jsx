import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer
} from 'recharts'

const SOURCE_LABELS = {
  smhi:               'SMHI',
  yr:                 'Yr.no',
  open_meteo:         'OM GFS',
  open_meteo_icon_eu: 'OM ICON-EU',
  open_meteo_ecmwf:   'OM ECMWF',
  open_meteo_ukmo:    'UKMO',
  open_meteo_knmi:    'KNMI',
  openweathermap:     'OWM',
  radar_nowcast:      'Radar',
  ensemble:           'Ensemble ★',
}

const SOURCE_COLORS = {
  smhi:               '#60a5fa',
  yr:                 '#34d399',
  open_meteo:         '#f97316',
  open_meteo_icon_eu: '#22d3ee',
  open_meteo_ecmwf:   '#fbbf24',
  open_meteo_ukmo:    '#e879f9',
  open_meteo_knmi:    '#2dd4bf',
  openweathermap:     '#a78bfa',
  radar_nowcast:      '#f43f5e',
  ensemble:           '#e2e8f0',
}

// Composite MAE score: lower = better (used to determine rank)
// Precip has Brier scale (0–1), rest in physical units — normalised by typical spread
const PARAM_WEIGHTS = { mae_temperature: 0.30, mae_precip: 0.40, mae_wind: 0.20, mae_cloud: 0.10 }
const PARAM_SCALE   = { mae_temperature: 6,    mae_precip: 1.0,  mae_wind: 8,    mae_cloud: 40 }

function compositeScore(row) {
  let score = 0
  for (const [field, w] of Object.entries(PARAM_WEIGHTS)) {
    score += (row[field] / PARAM_SCALE[field]) * w
  }
  return score
}

/**
 * From raw history rows build [{date, source1_rank, source2_rank, ...}]
 * Each day: aggregate across lead_hours (sample-count weighted), then rank sources.
 */
function buildChartData(history) {
  if (!history?.length) return { chartData: [], sources: [] }

  // Group by date → source → list of rows
  const byDate = {}
  for (const row of history) {
    byDate[row.snapshot_date] ??= {}
    byDate[row.snapshot_date][row.source] ??= []
    byDate[row.snapshot_date][row.source].push(row)
  }

  const chartData = []
  for (const [dateStr, bySrc] of Object.entries(byDate).sort()) {
    // Compute weighted-average composite score per source
    const scores = {}
    for (const [src, rows] of Object.entries(bySrc)) {
      const total = rows.reduce((s, r) => s + r.sample_count, 0)
      if (total === 0) continue
      const wavg = field => rows.reduce((s, r) => s + r[field] * r.sample_count, 0) / total
      const synth = {
        mae_temperature: wavg('mae_temperature'),
        mae_precip:      wavg('mae_precip'),
        mae_wind:        wavg('mae_wind'),
        mae_cloud:       wavg('mae_cloud'),
      }
      scores[src] = compositeScore(synth)
    }

    // Rank all sources together (including ensemble) — guarantees unique ranks,
    // no duplicate #1 when scores are tied (stable insertion-order tiebreak).
    const point = { date: dateStr.slice(5) } // "MM-DD"
    Object.entries(scores)
      .sort((a, b) => a[1] - b[1])
      .forEach(([src], i) => { point[src] = i + 1 })
    chartData.push(point)
  }

  const sources = [...new Set(history.map(r => r.source))]
  return { chartData, sources }
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  const sorted = [...payload].sort((a, b) => (a.value ?? 99) - (b.value ?? 99))
  return (
    <div className="bg-slate-900 border border-slate-600 rounded-lg p-3 text-xs">
      <p className="text-slate-400 mb-2">{label}</p>
      {sorted.map(p => (
        <div key={p.dataKey} className="flex items-center gap-2 mb-1">
          <span style={{ color: p.color }}>●</span>
          <span className="text-slate-300 w-28">{SOURCE_LABELS[p.dataKey] ?? p.dataKey}</span>
          <span className="font-mono text-white">#{p.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function RankingChart({ history }) {
  if (!history?.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center text-sm">
        Ingen historik ännu — första snapshot sparas i slutet av dagen.
      </div>
    )
  }

  const { chartData, sources } = buildChartData(history)
  // Fixed scale = all configured sources, so the axis never rescales
  // as new sources accumulate history data over time.
  const nSources = Object.keys(SOURCE_LABELS).length

  if (chartData.length < 2) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center text-sm">
        Behöver minst två dagars data för att visa en trend.
      </div>
    )
  }

  // Build rank → source mapping from the latest data point for Y-axis labels
  const latestPoint = chartData[chartData.length - 1]
  const rankToSource = {}
  for (const src of sources) {
    const rank = latestPoint?.[src]
    if (rank != null) rankToSource[rank] = src
  }

  const YAxisTick = ({ x, y, payload }) => {
    const src = rankToSource[payload.value]
    const label = src ? (SOURCE_LABELS[src] ?? src) : `#${payload.value}`
    const color = src ? (SOURCE_COLORS[src] ?? '#94a3b8') : '#475569'
    return (
      <text x={x} y={y} dy={4} textAnchor="end" fill={color} fontSize={10}>
        {label}
      </text>
    )
  }

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <h2 className="text-lg font-semibold text-white mb-1">Ranking över tid</h2>
      <p className="text-xs text-slate-500 mb-5">
        Placering per dag baserat på viktat MAE — #1 är bäst · Ensemble är streckad
      </p>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tick={{ fill: '#94a3b8', fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: '#334155' }}
          />
          <YAxis
            reversed
            domain={[1, nSources]}
            ticks={Array.from({ length: nSources }, (_, i) => i + 1)}
            tick={<YAxisTick />}
            tickLine={false}
            axisLine={false}
            interval={0}
            width={80}
          />
          <Tooltip content={<CustomTooltip />} />
          {sources.map(src => (
            <Line
              key={src}
              type="monotone"
              dataKey={src}
              stroke={SOURCE_COLORS[src] ?? '#94a3b8'}
              strokeWidth={src === 'ensemble' ? 2 : 1.5}
              strokeDasharray={src === 'ensemble' ? '5 3' : undefined}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <p className="text-xs text-slate-600 mt-3">
        Komposit: Regn 40% · Temp 30% · Vind 20% · Moln 10% · normaliserat per parameter
      </p>
    </div>
  )
}
