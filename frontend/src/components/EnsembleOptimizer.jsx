import { useState, useCallback } from 'react'
import { excludeSource, includeSource } from '../api'

const STATUS_DOT = {
  ok:       { dot: 'bg-green-500',  badge: 'bg-green-900 text-green-300',   label: 'OK' },
  warning:  { dot: 'bg-yellow-400', badge: 'bg-yellow-900 text-yellow-300', label: 'Varning' },
  critical: { dot: 'bg-red-500',    badge: 'bg-red-900 text-red-300',       label: 'Kritisk' },
  excluded: { dot: 'bg-slate-500',  badge: 'bg-slate-700 text-slate-400',   label: 'Exkluderad' },
}

export default function EnsembleOptimizer({ data, onReload }) {
  const [busy, setBusy] = useState(null)
  const [actionError, setActionError] = useState(null)

  const handleToggle = useCallback(async (source, currentlyExcluded) => {
    setBusy(source)
    setActionError(null)
    try {
      if (currentlyExcluded) {
        await includeSource(source)
      } else {
        await excludeSource(source)
      }
      if (onReload) await onReload()
    } catch (e) {
      setActionError(e.message)
    } finally {
      setBusy(null)
    }
  }, [onReload])

  if (!data) {
    return (
      <div className="bg-slate-800 rounded-xl p-4 text-slate-400 text-sm">
        Laddar källhälsa…
      </div>
    )
  }

  const { sources, ensemble_mae_temp, excluded_count } = data
  const activeSources = sources.filter(s => !s.excluded).length
  const suggestions = sources.filter(s => s.suggestion !== null)

  return (
    <div className="bg-slate-800 rounded-xl p-4 space-y-4">
      <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">
        Ensemble-optimering
      </h2>

      {actionError && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 rounded-lg px-3 py-2 text-xs">
          {actionError}
        </div>
      )}

      {/* Source health table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-slate-300">
          <thead>
            <tr className="text-slate-500 border-b border-slate-700">
              <th className="pb-2 text-left w-4"></th>
              <th className="pb-2 text-left">Källa</th>
              <th className="pb-2 text-right">Bias temp</th>
              <th className="pb-2 text-right">MAE temp</th>
              <th className="pb-2 text-right">MAE vind</th>
              <th className="pb-2 text-right">Prover</th>
              <th className="pb-2 text-center">Status</th>
              <th className="pb-2 text-right">Åtgärd</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {sources.map(src => {
              const s = STATUS_DOT[src.status] || STATUS_DOT.ok
              const isExcluded = src.excluded
              const isBusy = busy === src.source
              return (
                <tr key={src.source} className={isExcluded ? 'opacity-50' : ''}>
                  <td className="py-2 pr-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${s.dot}`} />
                  </td>
                  <td className="py-2 font-medium">{src.label}</td>
                  <td className="py-2 text-right font-mono">
                    {src.bias_temp != null
                      ? <span className={Math.abs(src.bias_temp) > 1.0 ? 'text-yellow-300' : ''}>
                          {src.bias_temp > 0 ? '+' : ''}{src.bias_temp.toFixed(2)}°C
                        </span>
                      : '—'}
                  </td>
                  <td className="py-2 text-right font-mono">{src.mae_temp.toFixed(3)}°C</td>
                  <td className="py-2 text-right font-mono">{src.mae_wind.toFixed(2)} m/s</td>
                  <td className="py-2 text-right text-slate-400">{src.sample_count}</td>
                  <td className="py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${s.badge}`}>
                      {s.label}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => handleToggle(src.source, isExcluded)}
                      disabled={isBusy}
                      className={`text-xs px-2 py-1 rounded transition-colors ${
                        isBusy
                          ? 'bg-slate-600 text-slate-400 cursor-not-allowed'
                          : isExcluded
                            ? 'bg-green-700 hover:bg-green-600 text-white'
                            : 'bg-red-900 hover:bg-red-800 text-red-200'
                      }`}
                    >
                      {isBusy ? '…' : isExcluded ? 'Återställ' : 'Exkludera'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Förslag</p>
          <ul className="space-y-1">
            {suggestions.map(s => (
              <li key={s.source} className="text-xs text-slate-400 flex gap-2">
                <span className="text-slate-500 shrink-0">{s.label}:</span>
                <span>{s.suggestion}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Summary line */}
      <p className="text-xs text-slate-500 border-t border-slate-700 pt-3">
        {activeSources} av {sources.length} källor aktiva
        {excluded_count > 0 && ` · ${excluded_count} exkluderade`}
        {ensemble_mae_temp != null && ` · Ensemble MAE temp: ${ensemble_mae_temp.toFixed(3)}°C`}
      </p>
    </div>
  )
}
