/**
 * Weather momentum — detects significant upcoming weather changes.
 *
 * Compares current conditions to 3h and 6h forecasts using a "badness"
 * score built from precip, cloud cover, wind, and pressure trend.
 * Only returns visible=true when the change is large enough to matter.
 */

function _baseEmoji(fc) {
  if (!fc) return '☀️'
  const p  = fc.precip_probability ?? 0
  const c  = fc.cloud_cover ?? 0
  const mm = fc.precip_mm ?? 0
  const t  = fc.temperature ?? 5
  if (p >= 60 && mm > 5) return t <= 0 ? '🌨' : '⛈'
  if (p >= 60)           return t <= 0 ? '🌨' : '🌧'
  if (p >= 20)           return '🌦'
  if (c > 75)            return '☁️'
  if (c > 50)            return '⛅'
  if (c > 25)            return '🌤'
  return '☀️'
}

function _badness(fc) {
  if (!fc) return null
  let s = 0
  s += (fc.precip_probability ?? 0) * 0.50   // 0–50 pts
  s += (fc.cloud_cover ?? 0)        * 0.15   // 0–15 pts
  s += Math.min(fc.wind_speed ?? 0, 20) * 1.0 // 0–20 pts
  s += Math.min(fc.precip_mm ?? 0, 10)   * 1.5 // 0–15 pts
  return Math.min(s, 100)
}

function _parseTS(ts) {
  if (!ts) return null
  const iso = typeof ts === 'string' && !ts.endsWith('Z') && !ts.includes('+')
    ? ts + 'Z' : ts
  return new Date(iso)
}

/**
 * @param {object} currentFc   — the current forecast hour
 * @param {Array}  forecastHours — upcoming forecast hours (sorted by valid_for)
 * @returns {WeatherMomentumResult}
 */
export function getWeatherMomentum(currentFc, forecastHours) {
  if (!currentFc || !forecastHours?.length) return { visible: false }

  const now = new Date()
  const t3  = now.getTime() + 3 * 3600_000
  const t6  = now.getTime() + 6 * 3600_000

  const fc3h = forecastHours.find(fc => {
    const d = _parseTS(fc.valid_for)
    return d && d.getTime() >= t3
  }) ?? null
  const fc6h = forecastHours.find(fc => {
    const d = _parseTS(fc.valid_for)
    return d && d.getTime() >= t6
  }) ?? fc3h

  if (!fc3h) return { visible: false }

  const b0 = _badness(currentFc) ?? 0
  const b3 = _badness(fc3h) ?? b0
  const b6 = _badness(fc6h) ?? b3

  const delta3 = b3 - b0
  const delta6 = b6 - b0

  // Pressure trend bonus (hPa over 6h — falling = worse)
  let pressureBonus = 0
  if (currentFc.pressure != null && fc6h?.pressure != null) {
    const dp = fc6h.pressure - currentFc.pressure
    if (dp < -3) pressureBonus =  10  // falling → worse
    if (dp >  3) pressureBonus = -10  // rising  → better
  }

  const effectiveDelta = delta6 + pressureBonus

  const THRESHOLD_VISIBLE = 15   // min change to show anything
  const THRESHOLD_FAST    = 20   // change in 0–3 h counts as fast

  if (Math.abs(effectiveDelta) < THRESHOLD_VISIBLE) return { visible: false }

  const direction = effectiveDelta > 0 ? 'worsening' : 'improving'
  const speed     = Math.abs(delta3) >= THRESHOLD_FAST ? 'fast' : 'slow'

  const fromIcon = _baseEmoji(currentFc)
  const toIcon   = _baseEmoji(fc6h ?? fc3h)

  // Don't show if icons are the same (change is numeric but not visually obvious)
  if (fromIcon === toIcon && Math.abs(effectiveDelta) < 25) return { visible: false }

  const arrow  = speed === 'fast' ? '⟹' : '→'
  const symbol = `${fromIcon}${arrow}${toIcon}`

  const LABELS = {
    'worsening-slow': 'Försämras',
    'worsening-fast': 'Snabbt sämre',
    'improving-slow': 'Klarnar upp',
    'improving-fast': 'Snabbt bättre',
  }

  return {
    visible:   true,
    direction,
    speed,
    fromIcon,
    toIcon,
    symbol,
    label:  LABELS[`${direction}-${speed}`],
    reason: `${Math.round(Math.abs(effectiveDelta))} poängs förändring på ${speed === 'fast' ? '3' : '6'}h`,
  }
}
