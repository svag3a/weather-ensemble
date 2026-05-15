const BASE = '/api/v1'

export async function fetchEnsemble(hoursAhead = 48) {
  const res = await fetch(`${BASE}/forecast?hours_ahead=${hoursAhead}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchSources(hoursAhead = 48) {
  const res = await fetch(`${BASE}/forecast/sources?hours_ahead=${hoursAhead}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchWeights() {
  const res = await fetch(`${BASE}/weights`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchLocalForecast(lat, lon, hoursAhead = 48) {
  const res = await fetch(`${BASE}/forecast/local?lat=${lat}&lon=${lon}&hours_ahead=${hoursAhead}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchRadarNow(lat, lon) {
  const res = await fetch(`${BASE}/radar/now?lat=${lat}&lon=${lon}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerCollect() {
  const res = await fetch(`${BASE}/collect`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
