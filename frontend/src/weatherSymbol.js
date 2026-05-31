// Default coordinates — Göteborg. Overridden whenever GPS is available.
const _DEFAULT_LAT = 57.706
const _DEFAULT_LON = 11.967

/**
 * Compute sunrise and sunset times (fractional UTC hours) for a given date
 * and geographic position using the Spencer equation-of-time + declination
 * approximation. Accurate to within ~5 minutes for mid-latitudes.
 *
 * Handles edge cases:
 *   cosHA > 1  → polar night (sun never rises)  → sunrise = sunset = 0
 *   cosHA < -1 → midnight sun (sun never sets)  → sunrise = 0, sunset = 24
 *
 * @param {Date}   date
 * @param {number} lat  Latitude  in decimal degrees (default: Göteborg)
 * @param {number} lon  Longitude in decimal degrees (default: Göteborg)
 */
export function sunTimesUTC(date, lat = _DEFAULT_LAT, lon = _DEFAULT_LON) {
  const rad = Math.PI / 180

  // Day of year (1–366)
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0)
  const dayOfYear = Math.floor((date - startOfYear) / 86_400_000)

  // Solar declination (degrees)
  const declination = -23.45 * Math.cos(rad * (360 / 365) * (dayOfYear + 10))

  // Hour angle at sunrise/sunset — 90.833° accounts for refraction + solar disc
  const cosHA =
    (Math.cos(rad * 90.833) - Math.sin(rad * lat) * Math.sin(rad * declination)) /
    (Math.cos(rad * lat)    * Math.cos(rad * declination))

  if (cosHA > 1)  return { sunrise: 0,  sunset: 0  }  // polar night
  if (cosHA < -1) return { sunrise: 0,  sunset: 24 }  // midnight sun

  const HA = Math.acos(cosHA) / rad  // degrees

  // Equation of time (minutes) — Spencer formula
  const B   = rad * (360 / 365) * (dayOfYear - 81)
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)

  // Solar noon in UTC, adjusted for longitude and equation of time
  const solarNoon = 12 - lon / 15 - eot / 60

  return {
    sunrise: solarNoon - HA / 15,
    sunset:  solarNoon + HA / 15,
  }
}

function isNight(validFor, lat = _DEFAULT_LAT, lon = _DEFAULT_LON) {
  if (!validFor) return false
  const iso = typeof validFor === 'string' && !validFor.endsWith('Z') && !validFor.includes('+')
    ? validFor + 'Z'
    : validFor
  const d = new Date(iso)
  const { sunrise, sunset } = sunTimesUTC(d, lat, lon)
  const utcH = d.getUTCHours() + d.getUTCMinutes() / 60
  return utcH < sunrise || utcH >= sunset
}

/**
 * @param {number|null} temperature        °C
 * @param {number|null} precipProbability  0–100 %
 * @param {number|null} windSpeed          m/s
 * @param {number|null} cloudCover         0–100 %
 * @param {string|null} validFor           ISO timestamp (for day/night)
 * @param {number}      cape               J/kg from radar — optional, enables thunder/hail
 * @param {number}      fogProbability     0–1 ensemble fog signal
 * @param {number}      precipMm           mm/h precipitation amount for intensity
 */
export function getWeatherInfo(temperature, precipProbability, windSpeed, cloudCover, validFor = null, cape = 0, fogProbability = 0, precipMm = 0) {
  const precip = precipProbability ?? 0
  const cloud  = cloudCover ?? 0
  const wind   = windSpeed ?? 0
  const temp   = temperature ?? 5
  const mm     = precipMm ?? 0

  const windy  = wind > 10
  const frozen = temp <= 0
  const sleet  = temp > 0 && temp <= 3   // snöblandat regn-zon
  const night  = isNight(validFor)

  // Hail: very high CAPE + heavy precipitation
  const hail         = cape >= 2000 && precip >= 60
  const possibleHail = cape >= 1000 && precip >= 60 && mm > 5

  // Thunder takes priority when atmosphere is unstable + precipitation likely
  const thunder = !hail && cape >= 500 && precip >= 40

  let symbol, label

  // Fog takes priority when likely (>0.5), shows as possible when borderline (0.3-0.5)
  const fog = fogProbability ?? 0
  if (!thunder && !hail) {
    if (fog > 0.65) {
      symbol = 'FOG'; label = 'Dimma'
      if (windy) { symbol += '💨'; label += ', blåsigt' }
      return { symbol, label }
    }
    if (fog > 0.45 && cloud > 85) {
      symbol = 'FOG_POSSIBLE'; label = 'Möjlig dimma'
      return { symbol, label }
    }
  }

  if (hail) {
    symbol = '🌨'; label = 'Hagel'
  } else if (possibleHail) {
    symbol = '🌨'; label = 'Möjlig hagel'
  } else if (thunder) {
    symbol = '⛈'
    label  = cape >= 1500 ? 'Kraftig åska' : 'Åskväder'
  } else if (precip >= 60) {
    // Heavy rain intensity from precip_mm
    const rainLabel = mm > 10 ? 'Skyfall' : mm > 3 ? 'Kraftigt regn' : 'Regn'
    if (frozen)     { symbol = '🌨'; label = 'Snö' }
    else if (sleet) { symbol = '🌧'; label = 'Snöblandat regn' }
    else            { symbol = '🌧'; label = rainLabel }
  } else if (precip >= 20) {
    if (frozen)     { symbol = '🌨'; label = 'Lätt snö' }
    else if (sleet) { symbol = '🌦'; label = 'Lätt snöblandat regn' }
    else            { symbol = '🌦'; label = 'Lätt regn' }
  } else if (cloud > 75) {
    symbol = '☁️'; label = 'Mulet'
  } else if (cloud > 50) {
    symbol = night ? '☁️' : '⛅'
    label  = 'Halvmulet'
  } else if (cloud > 25) {
    symbol = night ? '🌙' : '🌤'
    label  = 'Mestadels klart'
  } else {
    symbol = night ? '🌙' : '☀️'
    label  = night ? 'Klar natt' : 'Klart'
  }

  if (windy && !thunder) { symbol += '💨'; label += ', blåsigt' }

  return { symbol, label }
}

export function getSymbol(...args) {
  return getWeatherInfo(...args).symbol
}

/**
 * "Känns som"-temperatur.
 * Wind chill (Canadian formula) when T ≤ 10°C and wind > 1.3 m/s.
 * Returns null when the adjustment is negligible (< 1°C difference).
 */
export function feelsLike(tempC, windMs) {
  if (tempC == null) return null
  const v = (windMs ?? 0) * 3.6  // m/s → km/h
  if (tempC <= 10 && v > 4.8) {
    const wc = Math.round(
      13.12 + 0.6215 * tempC
      - 11.37 * Math.pow(v, 0.16)
      + 0.3965 * tempC * Math.pow(v, 0.16)
    )
    return Math.abs(wc - Math.round(tempC)) >= 2 ? wc : null
  }
  return null
}
