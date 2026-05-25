import { getWeatherInfo } from '../weatherSymbol'

const RAIN_THRESHOLD = 20  // % precip probability → it rains (matches 🌦 symbol threshold)
const WIND_THRESHOLD = 5   // m/s → show wind

function rainDrops(mm) {
  if (mm == null || mm < 0.1) return null
  if (mm < 0.5) return '💧'
  if (mm < 2.0) return '💧💧'
  if (mm < 5.0) return '💧💧💧'
  if (mm < 10.0) return '💧💧💧💧'
  return '💧💧💧💧💧'
}

function windDirArrow(deg) {
  if (deg == null || isNaN(deg)) return ''
  // Wind "from" direction → arrow points in direction of travel
  const arrows = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘']
  return arrows[Math.round(deg / 45) % 8]
}

function isDay(isoString) {
  const h = new Date(isoString).getUTCHours()
  return h >= 6 && h < 21
}

function formatHour(isoString) {
  const d = new Date(isoString)
  return `${d.getUTCHours().toString().padStart(2, '0')}:00`
}

function formatDay(isoString) {
  return new Date(isoString).toLocaleDateString('sv-SE', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}

function isSameDay(a, b) {
  const da = new Date(a), db = new Date(b)
  return da.getUTCFullYear() === db.getUTCFullYear()
    && da.getUTCMonth() === db.getUTCMonth()
    && da.getUTCDate() === db.getUTCDate()
}


function HourCard({ fc }) {
  const rain = fc.precip_probability >= RAIN_THRESHOLD
  const wind = fc.wind_speed != null && fc.wind_speed >= WIND_THRESHOLD
  const night = !isDay(fc.valid_for)
  const { symbol } = getWeatherInfo(fc.temperature, fc.precip_probability, fc.wind_speed, fc.cloud_cover, fc.valid_for)

  return (
    <div className="flex flex-col items-center gap-1 px-3 py-3 rounded-xl shrink-0 w-[68px] bg-slate-700/40"
    >
      <span className="text-xs text-slate-400 font-mono">{formatHour(fc.valid_for)}</span>
      <span className="text-2xl leading-none">{symbol}</span>
      <span className="text-sm font-semibold text-white">
        {fc.temperature != null ? `${Math.round(fc.temperature)}°` : '—'}
      </span>
      {wind
        ? <span className="text-xs text-slate-300 whitespace-nowrap">
            {fc.wind_speed?.toFixed(0)} m/s {windDirArrow(fc.wind_direction)}
          </span>
        : <span className="text-xs text-slate-600">—</span>
      }
      {rain && rainDrops(fc.precip_mm)
        ? <span className="text-xs leading-none">{rainDrops(fc.precip_mm)}</span>
        : <span className="text-xs text-slate-600">—</span>
      }
    </div>
  )
}

export default function HourlyTimeline({ data }) {
  const now = new Date()
  const future = data?.filter(fc => new Date(fc.valid_for) > now) ?? []

  if (!future.length) {
    return (
      <div className="bg-slate-800 rounded-xl p-6 text-slate-400 text-center">
        Ingen prognos tillgänglig än. Tryck på "Hämta nu".
      </div>
    )
  }

  // Group into days
  const days = []
  for (const fc of future) {
    const last = days[days.length - 1]
    if (!last || !isSameDay(last[0].valid_for, fc.valid_for)) {
      days.push([fc])
    } else {
      last.push(fc)
    }
  }

  return (
    <div className="bg-slate-800 rounded-xl p-6 space-y-5">
      {days.map((hours, di) => (
        <div key={di}>
          <p className="text-xs font-medium text-slate-400 mb-3 capitalize">
            {formatDay(hours[0].valid_for)}
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-slate-600">
            {hours.map((fc, i) => <HourCard key={i} fc={fc} />)}
          </div>
        </div>
      ))}
    </div>
  )
}
