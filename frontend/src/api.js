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

export async function fetchWeightsHistory(days = 30) {
  const res = await fetch(`${BASE}/weights/history?days=${days}`)
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

export async function fetchWarnings() {
  const res = await fetch(`${BASE}/warnings`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchSummary(period = 'today') {
  const res = await fetch(`${BASE}/summary?period=${period}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerCollect() {
  const res = await fetch(`${BASE}/collect`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchStatus() {
  const res = await fetch(`${BASE}/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchCityImages() {
  const res = await fetch(`${BASE}/city-images`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function uploadCityImage(formData) {
  const res = await fetch(`${BASE}/city-images`, { method: 'POST', body: formData })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function updateCityImage(id, { label, lat, lon }) {
  const res = await fetch(`${BASE}/city-images/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, lat, lon }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deleteCityImage(id) {
  const res = await fetch(`${BASE}/city-images/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}
