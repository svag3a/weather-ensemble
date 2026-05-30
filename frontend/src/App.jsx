import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchEnsemble, fetchLocalForecast, fetchSources, fetchWeights, fetchWeightsHistory, fetchRadarNow, fetchStatus, triggerCollect, fetchCityImages, uploadCityImage, updateCityImage, deleteCityImage, fetchEnsembleHealth } from './api'
import HourlyTimeline from './components/HourlyTimeline'
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

function useRadarLocation() {
  const [radar, setRadar] = useState(null)
  const [coords, setCoords] = useState(null)
  const timerRef = useRef(null)

  const poll = useCallback(async (lat, lon) => {
    try {
      const result = await fetchRadarNow(lat, lon)
      setRadar(result)
    } catch {
      // silently ignore radar errors
    }
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
        () => start(57.7089, 11.9746) // fall back to Göteborg
      )
    } else {
      start(57.7089, 11.9746)
    }
    return () => clearInterval(timerRef.current)
  }, [poll])

  return { radar, coords }
}

export default function App() {
  const [collecting, setCollecting] = useState(false)
  const [hoursAhead, setHoursAhead] = useState(48)
  const { radar, coords } = useRadarLocation()

  const ensemble = useData(
    () => coords
      ? fetchLocalForecast(coords.lat, coords.lon, hoursAhead)
      : fetchEnsemble(hoursAhead),
    [hoursAhead, coords]
  )
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

        <div className="space-y-6">
          {radar != null && (
            <div className={`px-4 py-2 rounded-lg text-sm space-y-1 ${
              radar.raining
                ? 'bg-blue-900/50 border border-blue-700 text-blue-200'
                : 'bg-slate-800 border border-slate-700 text-slate-400'
            }`}>
              <div className="flex items-center gap-2">
                <span>
                  {radar.raining && radar.dbz >= 55 ? '🧊' :
                   radar.raining && radar.dbz >= 45 ? '🌨' :
                   radar.raining ? '🌧' : '☀️'}
                </span>
                <span>
                  {radar.raining
                    ? `${radar.dbz >= 55 ? 'Sannolikt hagel' : radar.dbz >= 45 ? 'Hagel möjligt' : 'Regnar'} på din plats${radar.dbz != null ? ` (${radar.dbz} dBZ, ${radar.confirmed_in}/${radar.checked} bilder)` : ''}`
                    : `Torrt på din plats just nu (${radar.confirmed_in}/${radar.checked} bilder)`
                  }
                </span>
              </div>
              {radar.cape != null && radar.cape >= 300 && (
                <div className="flex items-center gap-2 text-xs text-yellow-300/80">
                  <span>⚡</span>
                  <span>
                    {radar.cape >= 2500 ? `Extremt instabil luft (CAPE ${Math.round(radar.cape)} J/kg) — hagel/åska sannolikt` :
                     radar.cape >= 1000 ? `Instabil luft (CAPE ${Math.round(radar.cape)} J/kg) — åska möjlig` :
                                         `Viss instabilitet (CAPE ${Math.round(radar.cape)} J/kg)`}
                  </span>
                </div>
              )}
            </div>
          )}
          <HourlyTimeline data={ensemble.data} />
          <details className="group">
            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300 transition-colors list-none flex items-center gap-1 mb-4">
              <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
              Tekniska detaljer
            </summary>
            <div className="space-y-6">
              <ImageLibrary
                data={cityImages.data}
                onUpload={async (fd) => { await uploadCityImage(fd); cityImages.reload() }}
                onUpdate={async (id, fields) => { await updateCityImage(id, fields); cityImages.reload() }}
                onDelete={async (id) => { await deleteCityImage(id); cityImages.reload() }}
              />
              <EnsembleOptimizer data={ensembleHealth.data} onReload={ensembleHealth.reload} />
              <SystemStatus data={systemStatus.data} />
              <EnsembleForecast data={ensemble.data} sources={sources.data} />
              <SourceComparison data={sources.data} />
              <SourceRanking data={weights.data} />
              <RankingChart history={weightsHistory.data} />
            </div>
          </details>
        </div>

        <p className="text-center text-xs text-slate-600 mt-8">
          Uppdateras automatiskt varje timme · Vikter baserade på EMA av 1h-konsensus
        </p>
      </div>
    </div>
  )
}
