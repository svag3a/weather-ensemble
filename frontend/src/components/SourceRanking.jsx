const SOURCE_LABELS = {
  smhi: 'SMHI',
  yr: 'Yr.no',
  open_meteo: 'Open-Meteo',
  open_meteo_icon_eu: 'Open-Meteo ICON-EU',
  open_meteo_ecmwf: 'Open-Meteo ECMWF',
  openweathermap: 'OpenWeatherMap',
  radar_nowcast: 'Radar (nowcast)',
  ensemble: 'Ensemble ★',
}

const PARAMS = [
  { key: 'temperature', label: 'Temp',   maeField: 'mae_temperature', span: 60,  unit: '°C', weight: 0.30 },
  { key: 'precip',      label: 'Precip', maeField: 'mae_precip',      span: 100, unit: '%',  weight: 0.40 },
  { key: 'wind',        label: 'Vind',   maeField: 'mae_wind',        span: 30,  unit: 'm/s', weight: 0.20 },
  { key: 'cloud',       label: 'Moln',   maeField: 'mae_cloud',       span: 100, unit: '%',  weight: 0.10 },
]

const MEDALS = ['🥇', '🥈', '🥉']

function computeRankings(data) {
  const bySource = {}
  for (const row of data) {
    if (!bySource[row.source]) bySource[row.source] = []
    bySource[row.source].push(row)
  }

  const rankings = []
  for (const [source, rows] of Object.entries(bySource)) {
    const realRows = rows.filter(r => r.sample_count > 0)
    if (realRows.length === 0) continue

    const totalSamples = realRows.reduce((s, r) => s + r.sample_count, 0)
    const wavg = field => realRows.reduce((s, r) => s + r[field] * r.sample_count, 0) / totalSamples

    const params = {}
    let weightedSum = 0
    let totalWeight = 0
    for (const p of PARAMS) {
      const mae = wavg(p.maeField)
      const pct = (mae / p.span) * 100
      params[p.key] = { mae, pct }
      weightedSum += pct * p.weight
      totalWeight += p.weight
    }

    const deviation = totalWeight > 0 ? weightedSum / totalWeight : null
    rankings.push({ source, params, deviation, accuracy: deviation != null ? 100 - deviation : null })
  }

  return rankings.sort((a, b) => (b.accuracy ?? -Infinity) - (a.accuracy ?? -Infinity))
}

export default function SourceRanking({ data }) {
  if (!data?.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Inga vikter ännu — systemet behöver minst ett par timmars data.
      </div>
    )
  }

  const rankings = computeRankings(data)

  if (!rankings.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Ingen rankingdata tillgänglig ännu.
      </div>
    )
  }


  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <h2 className="text-lg font-semibold text-white mb-1">Källrangordning</h2>
      <p className="text-xs text-slate-500 mb-5">
        Viktad träffsäkerhet mot utfall — högre är bättre
      </p>

      <div className="space-y-4">
        {rankings.map((r, i) => (
          <div key={r.source} className="bg-slate-700/40 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">{MEDALS[i] ?? `${i + 1}.`}</span>
                <span className="text-white font-semibold">{SOURCE_LABELS[r.source] ?? r.source}</span>
              </div>
              <span className="text-slate-200 font-mono text-sm">
                {r.accuracy != null ? `${r.accuracy.toFixed(1)}% träffsäkerhet` : '—'}
              </span>
            </div>

            {/* Total bar */}
            <div className="w-full bg-slate-700 rounded-full h-2 mb-4">
              <div
                className="h-2 rounded-full bg-blue-500"
                style={{ width: `${Math.max(0, r.accuracy ?? 0)}%` }}
              />
            </div>

            {/* Per-parameter breakdown */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {PARAMS.map(p => {
                const val = r.params[p.key]
                return (
                  <div key={p.key} className="flex items-center gap-2">
                    <span className="text-slate-400 text-xs w-10 shrink-0">{p.label}</span>
                    <div className="flex-1 bg-slate-700 rounded-full h-1">
                      <div
                        className="h-1 rounded-full bg-orange-400"
                        style={{ width: `${Math.min(100, val.pct)}%` }}
                      />
                    </div>
                    <span className="text-slate-300 text-xs font-mono w-20 text-right">
                      {val.mae.toFixed(2)} {p.unit} ({val.pct.toFixed(1)}%)
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-600 mt-4">
        Vikt: Precip 40% · Temp 30% · Vind 20% · Moln 10% · Spann: Temp ±60°C · Vind 0–30 m/s · Viktat mot antal mätpunkter per ledtid
      </p>
    </div>
  )
}
