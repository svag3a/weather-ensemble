const SOURCE_LABELS = {
  smhi: 'SMHI',
  yr: 'Yr.no',
  open_meteo: 'Open-Meteo',
  openweathermap: 'OpenWeatherMap',
}

function MaeBar({ value, max }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-slate-700 rounded-full h-1.5">
        <div className="bg-orange-400 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-10 text-right">{value.toFixed(3)}</span>
    </div>
  )
}

export default function WeightsTable({ data }) {
  if (!data?.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Inga vikter ännu — systemet behöver minst ett par timmars data.
      </div>
    )
  }

  const maxMaeTemp   = Math.max(...data.map(d => d.mae_temperature))
  const maxMaePrecip = Math.max(...data.map(d => d.mae_precip))
  const maxMaeWind   = Math.max(...data.map(d => d.mae_wind))
  const maxMaeCloud  = Math.max(...data.map(d => d.mae_cloud))

  const byLead = data.reduce((acc, row) => {
    if (!acc[row.lead_hours]) acc[row.lead_hours] = {}
    acc[row.lead_hours][row.source] = row
    return acc
  }, {})

  const leadTimes = Object.keys(byLead).map(Number).sort((a, b) => a - b)
  const sources = [...new Set(data.map(d => d.source))]

  return (
    <div className="bg-slate-800 rounded-xl p-6">
      <h2 className="text-lg font-semibold text-white mb-4">MAE-vikter per källa och ledtid</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-400 border-b border-slate-700">
              <th className="text-left py-2 pr-4">Ledtid</th>
              {sources.map(src => (
                <th key={src} className="text-left py-2 px-4" colSpan={4}>
                  {SOURCE_LABELS[src] ?? src}
                </th>
              ))}
            </tr>
            <tr className="text-slate-500 text-xs border-b border-slate-700">
              <th className="py-1 pr-4" />
              {sources.map(src => (
                <>
                  <th key={`${src}-t`} className="py-1 px-4 font-normal">Temp</th>
                  <th key={`${src}-p`} className="py-1 px-4 font-normal">Precip</th>
                  <th key={`${src}-w`} className="py-1 px-4 font-normal">Vind</th>
                  <th key={`${src}-c`} className="py-1 px-4 font-normal">Moln</th>
                </>
              ))}
            </tr>
          </thead>
          <tbody>
            {leadTimes.map(lead => (
              <tr key={lead} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                <td className="py-2 pr-4 text-slate-300 font-medium">{lead}h</td>
                {sources.map(src => {
                  const row = byLead[lead]?.[src]
                  return row ? (
                    <>
                      <td key={`${src}-t`} className="py-2 px-4">
                        <MaeBar value={row.mae_temperature} max={maxMaeTemp} />
                      </td>
                      <td key={`${src}-p`} className="py-2 px-4">
                        <MaeBar value={row.mae_precip} max={maxMaePrecip} />
                      </td>
                      <td key={`${src}-w`} className="py-2 px-4">
                        <MaeBar value={row.mae_wind} max={maxMaeWind} />
                      </td>
                      <td key={`${src}-c`} className="py-2 px-4">
                        <MaeBar value={row.mae_cloud} max={maxMaeCloud} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td key={`${src}-t`} className="py-2 px-4 text-slate-600">—</td>
                      <td key={`${src}-p`} className="py-2 px-4 text-slate-600">—</td>
                      <td key={`${src}-w`} className="py-2 px-4 text-slate-600">—</td>
                      <td key={`${src}-c`} className="py-2 px-4 text-slate-600">—</td>
                    </>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500 mt-3">
        Lägre MAE = bättre. Vikter uppdateras varje timme.
      </p>
    </div>
  )
}
