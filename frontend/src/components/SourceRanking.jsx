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

const PARAMS = [
  { key: 'temperature', label: 'Temp',  maeField: 'mae_temperature', unit: '°C',  decimals: 2 },
  { key: 'precip',      label: 'Regn',  maeField: 'mae_precip',      unit: 'BS',  decimals: 3 },
  { key: 'wind',        label: 'Vind',  maeField: 'mae_wind',        unit: 'm/s', decimals: 2 },
  { key: 'cloud',       label: 'Moln',  maeField: 'mae_cloud',       unit: '%',   decimals: 1 },
]

// Normalise scale per param for the progress bar only (visual reference)
const PARAM_SCALE = { temperature: 6, precip: 1.0, wind: 8, cloud: 40 }

// Composite score for sorting: lower = better
const PARAM_WEIGHTS = { mae_temperature: 0.30, mae_precip: 0.40, mae_wind: 0.20, mae_cloud: 0.10 }
function compositeScore(params) {
  return (
    params.temperature.mae / PARAM_SCALE.temperature * 0.30 +
    params.precip.mae      / PARAM_SCALE.precip      * 0.40 +
    params.wind.mae        / PARAM_SCALE.wind        * 0.20 +
    params.cloud.mae       / PARAM_SCALE.cloud       * 0.10
  )
}

const TABS = [
  { key: 'overall',     label: 'Totalt' },
  { key: 'temperature', label: 'Bäst på temp' },
  { key: 'precip',      label: 'Bäst på regn' },
  { key: 'wind',        label: 'Bäst på vind' },
  { key: 'cloud',       label: 'Bäst på moln' },
]

const MEDALS = ['🥇', '🥈', '🥉']

// Short-range lead buckets used for ranking — most practically relevant for a weather app
const RANK_LEAD_HOURS = [1, 3, 6]

function computeRankings(data) {
  const bySource = {}
  for (const row of data) {
    // Only include short-range buckets for ranking
    if (!RANK_LEAD_HOURS.includes(row.lead_hours)) continue
    if (!bySource[row.source]) bySource[row.source] = []
    bySource[row.source].push(row)
  }

  // Compute sample-count weighted MAE per parameter per source
  const sourceParams = {}
  for (const [source, rows] of Object.entries(bySource)) {
    const realRows = rows.filter(r => r.sample_count > 0)
    if (realRows.length === 0) continue
    const totalSamples = realRows.reduce((s, r) => s + r.sample_count, 0)
    const wavg = field => realRows.reduce((s, r) => s + r[field] * r.sample_count, 0) / totalSamples
    const params = {}
    for (const p of PARAMS) {
      const mae = wavg(p.maeField)
      params[p.key] = { mae, barPct: Math.min(100, (mae / PARAM_SCALE[p.key]) * 100) }
    }
    sourceParams[source] = params
  }

  const sources = Object.keys(sourceParams)
  if (!sources.length) return []

  // Rank-sum: for each parameter, rank sources by MAE (lower = better rank 1)
  // and sum ranks. Lower total = better overall.
  const rankSum = Object.fromEntries(sources.map(s => [s, 0]))
  for (const p of PARAMS) {
    const sorted = [...sources]
      .filter(s => sourceParams[s][p.key]?.mae != null)
      .sort((a, b) => sourceParams[a][p.key].mae - sourceParams[b][p.key].mae)
    sorted.forEach((s, i) => { rankSum[s] += i })
    // Sources without data for this param get a penalty
    sources.filter(s => sourceParams[s][p.key]?.mae == null)
           .forEach(s => { rankSum[s] += sources.length })
  }

  return sources
    .map(source => ({ source, params: sourceParams[source], rankSum: rankSum[source] }))
    .sort((a, b) => a.rankSum - b.rankSum)
}

function sortByParam(rankings, paramKey) {
  return [...rankings].sort((a, b) => a.params[paramKey].mae - b.params[paramKey].mae)
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
        Rank-sum på 1h+3h+6h (kortsiktig träffsäkerhet) · Lägre MAE = bättre · Regn mäts med Brier score (0–1)
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
        {rankings.map((r, i) => {
          const activeP = PARAMS.find(p => p.key === activeTab)
          return (
            <div key={r.source} className="bg-slate-700/40 rounded-lg p-4">
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{MEDALS[i] ?? `${i + 1}.`}</span>
                  <span className="text-white font-semibold">{SOURCE_LABELS[r.source] ?? r.source}</span>
                </div>
                {activeTab !== 'overall' && activeP && (
                  <span className="text-slate-200 font-mono text-sm">
                    {r.params[activeTab].mae.toFixed(activeP.decimals)} {activeP.unit}
                  </span>
                )}
              </div>

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
                          style={{ width: `${val.barPct}%` }}
                        />
                      </div>
                      <span className="text-slate-300 text-xs font-mono w-20 text-right">
                        {val.mae.toFixed(p.decimals)} {p.unit}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-slate-600 mt-4">
        Totalsortering: rank-sum på 1h+3h+6h (kortsiktig träffsäkerhet) · staplar normaliserade mot typiska maxvärden
      </p>
    </div>
  )
}
