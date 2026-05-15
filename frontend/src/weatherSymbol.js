export function getWeatherInfo(temperature, precipProbability, windSpeed, cloudCover) {
  const precip = precipProbability ?? 0
  const cloud  = cloudCover ?? 0
  const wind   = windSpeed ?? 0
  const temp   = temperature ?? 5

  const windy  = wind > 10
  const frozen = temp <= 0

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
    symbol = '⛅'; label = 'Halvmulet'
  } else if (cloud > 25) {
    symbol = '🌤'; label = 'Mestadels klart'
  } else {
    symbol = '☀️'; label = 'Klart'
  }

  if (windy) { symbol += '💨'; label += ', blåsigt' }

  return { symbol, label }
}

export function getSymbol(...args) {
  return getWeatherInfo(...args).symbol
}
