import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchLocalForecast, fetchEnsemble, fetchRadarNow } from './api'
import HourlyTimeline from './components/HourlyTimeline'

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

export default function MobileApp() {
  const [forecast, setForecast] = useState(null)
  const { radar, coords } = useRadarLocation()

  const load = useCallback(async () => {
    try {
      const data = coords
        ? await fetchLocalForecast(coords.lat, coords.lon, 48)
        : await fetchEnsemble(48)
      setForecast(data)
    } catch {}
  }, [coords])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const interval = setInterval(load, 10 * 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <div className="px-4 pt-10 pb-6 space-y-4">

        <div className="flex items-center justify-between">
          <img src="/logo.png" alt="gbgvader.se" className="h-20 w-auto" />
          <a href="/" className="text-xs text-slate-600 hover:text-slate-400 transition-colors">
            Admin →
          </a>
        </div>

        {radar != null && (
          <div className={`px-4 py-2 rounded-xl text-sm space-y-1 ${
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
                  ? `${radar.dbz >= 55 ? 'Sannolikt hagel' : radar.dbz >= 45 ? 'Hagel möjligt' : 'Regnar'} just nu`
                  : 'Torrt just nu'}
              </span>
            </div>
            {radar.cape != null && radar.cape >= 300 && (
              <div className="flex items-center gap-2 text-xs text-yellow-300/80">
                <span>⚡</span>
                <span>
                  {radar.cape >= 2500 ? 'Extremt instabil luft — hagel/åska sannolikt' :
                   radar.cape >= 1000 ? 'Instabil luft — åska möjlig' :
                                       'Viss instabilitet'}
                </span>
              </div>
            )}
          </div>
        )}

        <HourlyTimeline data={forecast} />

      </div>
    </div>
  )
}
