// Göteborg coordinates for sunrise/sunset calculation
const LAT = 57.706
const LON = 11.967

/**
 * Compute sunrise and sunset times (fractional UTC hours) for a given date
 * using the Spencer equation-of-time + declination approximation.
 * Accurate to within ~5 minutes for mid-latitudes.
 */
function sunTimesUTC(date) {
  const rad = Math.PI / 180

  // Day of year (1–366)
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0)
  const dayOfYear = Math.floor((date - startOfYear) / 86_400_000)

  // Solar declination (degrees)
  const declination = -23.45 * Math.cos(rad * (360 / 365) * (dayOfYear + 10))

  // Hour angle at sunrise/sunset — 90.833° accounts for refraction + solar disc
  const cosHA =
    (Math.cos(rad * 90.833) - Math.sin(rad * LAT) * Math.sin(rad * declination)) /
    (Math.cos(rad * LAT) * Math.cos(rad * declination))

  if (cosHA > 1)  return { sunrise: 0,  sunset: 0  }  // polar night  → always dark
  if (cosHA < -1) return { sunrise: 0,  sunset: 24 }  // midnight sun → always light

  const HA = Math.acos(cosHA) / rad  // degrees

  // Equation of time (minutes) — Spencer formula
  const B   = rad * (360 / 365) * (dayOfYear - 81)
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)

  // Solar noon in UTC, adjusted for longitude and equation of time
  const solarNoon = 12 - LON / 15 - eot / 60

  return {
    sunrise: solarNoon - HA / 15,
    sunset:  solarNoon + HA / 15,
  }
}

function isNight(validFor) {
  if (!validFor) return false
  // API returns naive UTC strings — append 'Z' so the browser parses them as
  // UTC rather than local time, which would shift the day/night boundary by 2h.
  const iso = typeof validFor === 'string' && !validFor.endsWith('Z') && !validFor.includes('+')
    ? validFor + 'Z'
    : validFor
  const d = new Date(iso)
  const { sunrise, sunset } = sunTimesUTC(d)
  const utcH = d.getUTCHours() + d.getUTCMinutes() / 60
  return utcH < sunrise || utcH >= sunset
}

export function getWeatherInfo(temperature, precipProbability, windSpeed, cloudCover, validFor = null) {
  const precip = precipProbability ?? 0
  const cloud  = cloudCover ?? 0
  const wind   = windSpeed ?? 0
  const temp   = temperature ?? 5

  const windy  = wind > 10
  const frozen = temp <= 0
  const night  = isNight(validFor)

  let symbol, label
  if (precip >= 60) {
    symbol = frozen ? '🌨' : '🌧'
    label  = frozen ? 'Snö' : 'Regn'
  } else if (precip >= 20) {
    symbol = frozen ? '🌨' : '🌦'
    label  = frozen ? 'Lätt snö' : 'Lätt regn'
  } else if (cloud > 75) {
    symbol = '☁️'; label = 'Mulet'
  } else if (cloud > 50) {
    // At night the sun isn't peeking through — use plain cloud
    symbol = night ? '☁️' : '⛅'
    label  = 'Halvmulet'
  } else if (cloud > 25) {
    symbol = night ? '🌙' : '🌤'
    label  = 'Mestadels klart'
  } else {
    symbol = night ? '🌙' : '☀️'
    label  = night ? 'Klar natt' : 'Klart'
  }

  if (windy) { symbol += '💨'; label += ', blåsigt' }

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
