import { useState, useEffect, useCallback } from 'react'
import { fetchEnsemble, fetchSources, fetchWeights, fetchWeightsHistory, fetchStatus, triggerCollect, fetchCityImages, uploadCityImage, updateCityImage, deleteCityImage, fetchEnsembleHealth } from './api'
import EnsembleForecast from './components/EnsembleForecast'
import SourceComparison from './components/SourceComparison'
import SourceRanking from './components/SourceRanking'
import RankingChart from './components/RankingChart'
import SystemStatus from './components/SystemStatus'
import ImageLibrary from './components/ImageLibrary'
import EnsembleOptimizer from './components/EnsembleOptimizer'

function useData(fetcher, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    try {
      setError(null)
      setData(await fetcher())
    } catch (e) {
      setError(e.message)
    }
  }, deps)
  useEffect(() => { load() }, [load])
  return { data, error, reload: load }
}

export default function App() {
  const [collecting, setCollecting] = useState(false)
  const [hoursAhead, setHoursAhead] = useState(48)
  const [activeTab, setActiveTab]   = useState('status')

  const ensemble = useData(() => fetchEnsemble(hoursAhead), [hoursAhead])
  const sources       = useData(() => fetchSources(hoursAhead), [hoursAhead])
  const weights        = useData(fetchWeights)
  const weightsHistory = useData(fetchWeightsHistory)
  const systemStatus   = useData(fetchStatus)
  const cityImages     = useData(fetchCityImages)
  const ensembleHealth = useData(fetchEnsembleHealth)

  useEffect(() => {
    const refresh = () => {
      ensemble.reload()
      sources.reload()
      weights.reload()
      cityImages.reload()
    }
    const interval = setInterval(refresh, 10 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ensemble.reload, sources.reload, weights.reload])

  async function handleCollect() {
    setCollecting(true)
    try {
      await triggerCollect()
      await new Promise(r => setTimeout(r, 3000))
      ensemble.reload()
      sources.reload()
      weights.reload()
    } finally {
      setCollecting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <div className="max-w-6xl mx-auto px-4 py-8">

        <div className="flex items-center justify-between mb-8">
          <div>
            <img src="/logo.png" alt="gbgvader.se" className="h-32 w-auto" />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => fetch('/auth/logout', { method: 'POST' }).then(() => { window.location.href = '/' })}
              className="bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-medium px-3 py-2 rounded-lg border border-slate-600 transition-colors"
            >
              Logga ut
            </button>
            <select
              value={hoursAhead}
              onChange={e => setHoursAhead(Number(e.target.value))}
              className="bg-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-600"
            >
              <option value={24}>24 timmar</option>
              <option value={48}>48 timmar</option>
              <option value={72}>72 timmar</option>
            </select>
            <button
              onClick={handleCollect}
              disabled={collecting}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              {collecting ? 'Samlar in…' : 'Hämta nu'}
            </button>
          </div>
        </div>

        {[ensemble.error, sources.error, weights.error].filter(Boolean).map((e, i) => (
          <div key={i} className="bg-red-900/50 border border-red-700 text-red-200 rounded-lg px-4 py-3 mb-4 text-sm">
            {e}
          </div>
        ))}

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 border-b border-slate-700">
          {[['status', 'Status'], ['karta', 'Karta']].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === id
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'status' && (
          <div className="space-y-6">
            <EnsembleOptimizer data={ensembleHealth.data} onReload={ensembleHealth.reload} />
            <SystemStatus data={systemStatus.data} />
            <EnsembleForecast data={ensemble.data} sources={sources.data} />
            <SourceComparison data={sources.data} />
            <SourceRanking data={weights.data} />
            <RankingChart history={weightsHistory.data} />
          </div>
        )}

        {activeTab === 'karta' && (
          <div className="space-y-6">
            <ImageLibrary
              data={cityImages.data}
              onUpload={async (fd) => { await uploadCityImage(fd); cityImages.reload() }}
              onUpdate={async (id, fields) => { await updateCityImage(id, fields); cityImages.reload() }}
              onDelete={async (id) => { await deleteCityImage(id); cityImages.reload() }}
            />
          </div>
        )}

        <p className="text-center text-xs text-slate-600 mt-8">
          Uppdateras automatiskt varje timme · Vikter baserade på EMA av 1h-konsensus
        </p>
      </div>
    </div>
  )
}
