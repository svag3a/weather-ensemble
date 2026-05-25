import { useState } from 'react'

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

// span = "worst realistic error" used to normalise the bar to 0–100%.
// Precip uses Brier score (0–1) so its span is 1.0 (not 100 %).
const PARAMS = [
  { key: 'temperature', label: 'Temp',   maeField: 'mae_temperature', span: 6,   unit: '°C',  weight: 0.30 },
  { key: 'precip',      label: 'Regn',   maeField: 'mae_precip',      span: 1.0, unit: 'BS',  weight: 0.40 },
  { key: 'wind',        label: 'Vind',   maeField: 'mae_wind',        span: 8,   unit: 'm/s', weight: 0.20 },
  { key: 'cloud',       label: 'Moln',   maeField: 'mae_cloud',       span: 40,  unit: '%',   weight: 0.10 },
]

const TABS = [
  { key: 'overall', label: 'Totalt' },
  { key: 'temperature', label: 'Bäst på temp' },
  { key: 'precip',      label: 'Bäst på regn' },
  { key: 'wind',        label: 'Bäst på vind' },
  { key: 'cloud',       label: 'Bäst på moln' },
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

function sortByParam(rankings, paramKey) {
  return [...rankings].sort((a, b) => (a.params[paramKey]?.pct ?? Infinity) - (b.params[paramKey]?.pct ?? Infinity))
}

export default function SourceRanking({ data }) {
  const [activeTab, setActiveTab] = useState('overall')

  if (!data?.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Inga vikter ännu — systemet behöver minst ett par timmars data.
      </div>
    )
  }

  const allRankings = computeRankings(data)

  if (!allRankings.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Ingen rankingdata tillgänglig ännu.
      </div>
    )
  }

  const rankings = activeTab === 'overall'
    ? allRankings
    : sortByParam(allRankings, activeTab)

  const highlightParam = activeTab === 'overall' ? null : activeTab

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <h2 className="text-lg font-semibold text-white mb-1">Källrangordning</h2>
      <p className="text-xs text-slate-500 mb-4">
        Viktad träffsäkerhet mot utfall — högre är bättre
      </p>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-5">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {rankings.map((r, i) => (
          <div key={r.source} className="bg-slate-700/40 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">{MEDALS[i] ?? `${i + 1}.`}</span>
                <span className="text-white font-semibold">{SOURCE_LABELS[r.source] ?? r.source}</span>
              </div>
              {activeTab === 'overall' && (
                <span className="text-slate-200 font-mono text-sm">
                  {r.accuracy != null ? `${r.accuracy.toFixed(1)}% träffsäkerhet` : '—'}
                </span>
              )}
              {activeTab !== 'overall' && (() => {
                const p = PARAMS.find(p => p.key === activeTab)
                const val = r.params[activeTab]
                return (
                  <span className="text-slate-200 font-mono text-sm">
                    {val ? `${val.mae.toFixed(p.key === 'precip' ? 3 : 2)} ${p.unit}` : '—'}
                  </span>
                )
              })()}
            </div>

            {/* Total bar (overall tab only) */}
            {activeTab === 'overall' && (
              <div className="w-full bg-slate-700 rounded-full h-2 mb-4">
                <div
                  className="h-2 rounded-full bg-blue-500"
                  style={{ width: `${Math.max(0, r.accuracy ?? 0)}%` }}
                />
              </div>
            )}

            {/* Per-parameter breakdown */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {PARAMS.map(p => {
                const val = r.params[p.key]
                const isHighlighted = highlightParam === p.key
                return (
                  <div key={p.key} className={`flex items-center gap-2 ${isHighlighted ? 'opacity-100' : 'opacity-60'}`}>
                    <span className={`text-xs w-10 shrink-0 ${isHighlighted ? 'text-blue-300 font-semibold' : 'text-slate-400'}`}>
                      {p.label}
                    </span>
                    <div className="flex-1 bg-slate-700 rounded-full h-1">
                      <div
                        className={`h-1 rounded-full ${isHighlighted ? 'bg-blue-400' : 'bg-orange-400'}`}
                        style={{ width: `${Math.min(100, val.pct)}%` }}
                      />
                    </div>
                    <span className="text-slate-300 text-xs font-mono w-20 text-right">
                      {p.key === 'precip'
                        ? `${val.mae.toFixed(3)} BS`
                        : `${val.mae.toFixed(2)} ${p.unit}`}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-600 mt-4">
        Vikt: Regn 40% · Temp 30% · Vind 20% · Moln 10% · Regn mäts med Brier score (0–1) · Viktat mot antal mätpunkter per ledtid
      </p>
    </div>
  )
}
