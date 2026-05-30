const SOURCE_LABELS = {
  smhi:               'SMHI',
  yr:                 'Yr.no',
  open_meteo:         'Open-Meteo GFS',
  open_meteo_icon_eu: 'Open-Meteo ICON EU',
  open_meteo_ecmwf:   'Open-Meteo ECMWF',
  open_meteo_ukmo:    'UKMO',
  open_meteo_knmi:    'KNMI HARMONIE',
  openweathermap:     'OpenWeatherMap',
  radar_nowcast:      'Radar (nowcast)',
}

const STATUS_DOT = {
  ok:      'bg-green-400',
  stale:   'bg-yellow-400',
  missing: 'bg-red-500',
}

const STATUS_TEXT = {
  ok:      'text-green-400',
  stale:   'text-yellow-400',
  missing: 'text-red-400',
}

function fmtAge(minutes) {
  if (minutes == null) return '—'
  if (minutes < 60)   return `${minutes} min sedan`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}min sedan` : `${h}h sedan`
}

function StatusDot({ status }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status] ?? 'bg-slate-600'}`} />
  )
}

function SectionHeader({ title }) {
  return (
    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-1 mb-2 mt-5 first:mt-0">
      {title}
    </h3>
  )
}

function Row({ left, right, sub, status }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-700/50 last:border-0">
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <div className="text-slate-200 text-sm">{left}</div>
        {sub && <div className="text-slate-500 text-xs mt-0.5">{sub}</div>}
      </div>
      <div className={`text-xs font-mono shrink-0 ${STATUS_TEXT[status] ?? 'text-slate-500'}`}>
        {right}
      </div>
    </div>
  )
}

export default function SystemStatus({ data }) {
  if (!data) return (
    <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center text-sm">
      Hämtar systemstatus…
    </div>
  )

  const { forecast_sources, observation, weights, ensemble, ai_summaries, server_time } = data

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 pt-5 pb-3 border-b border-slate-700">
        <h2 className="text-lg font-semibold text-white">Systemstatus</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Servertid: {server_time ? new Date(server_time + 'Z').toLocaleTimeString('sv-SE') : '—'}
        </p>
      </div>

      <div className="px-4 py-3">

        {/* Forecast sources */}
        <SectionHeader title="Prognoskällor" />
        <div className="bg-slate-700/30 rounded-lg overflow-hidden mb-1">
          {forecast_sources.map(src => (
            <Row
              key={src.source}
              status={src.status}
              left={SOURCE_LABELS[src.source] ?? src.source}
              right={fmtAge(src.age_minutes)}
              sub={src.issued_at
                ? `${src.forecast_hours} prognostimmar · ${new Date(src.issued_at + 'Z').toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                : 'Ingen data'}
            />
          ))}
        </div>

        {/* Observations */}
        <SectionHeader title="SMHI-observationer (sanningskälla)" />
        <div className="bg-slate-700/30 rounded-lg overflow-hidden mb-1">
          <Row
            status={observation.status}
            left="Göteborg A · Vinga · Landvetter"
            right={fmtAge(observation.age_minutes)}
            sub={observation.valid_for
              ? [
                  observation.temperature != null && `${observation.temperature}°C`,
                  observation.wind_speed   != null && `${observation.wind_speed} m/s`,
                  observation.precip_mm    != null && `${observation.precip_mm} mm`,
                ].filter(Boolean).join(' · ')
              : 'Ingen observation'}
          />
        </div>

        {/* Weights */}
        <SectionHeader title="Viktsuppdateringar" />
        <div className="bg-slate-700/30 rounded-lg overflow-hidden mb-1">
          <Row
            status={weights.status}
            left={`${weights.source_count} källor uppdaterade`}
            right={fmtAge(weights.age_minutes)}
            sub={weights.last_updated
              ? `${weights.min_samples}–${weights.max_samples} observationer per källa`
              : 'Inga uppdateringar'}
          />
        </div>

        {/* Ensemble */}
        <SectionHeader title="Ensembleberäkning" />
        <div className="bg-slate-700/30 rounded-lg overflow-hidden mb-1">
          <Row
            status={ensemble.status}
            left="Ensemble"
            right={fmtAge(ensemble.age_minutes)}
            sub={ensemble.computed_at
              ? `${ensemble.forecast_hours} prognostimmar genererade`
              : 'Ej beräknad'}
          />
        </div>

        {/* AI summaries */}
        <SectionHeader title="AI-sammanfattningar" />
        <div className="bg-slate-700/30 rounded-lg overflow-hidden">
          {['today', 'tomorrow'].map(period => {
            const s = ai_summaries?.find(x => x.period === period)
            return (
              <Row
                key={period}
                status={s?.status ?? 'missing'}
                left={period === 'today' ? 'Idag' : 'Imorgon'}
                right={s ? fmtAge(s.age_minutes) : '—'}
                sub={s
                  ? `Giltig ${s.valid_date} · genererad ${new Date(s.generated_at + 'Z').toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`
                  : 'Ej genererad'}
              />
            )
          })}
        </div>

      </div>
    </div>
  )
}
