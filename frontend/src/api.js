const BASE = '/api/v1'

export async function fetchUV({ lat, lon } = {}) {
  const params = new URLSearchParams()
  if (lat != null) params.set('lat', lat)
  if (lon != null) params.set('lon', lon)
  const res = await fetch(`${BASE}/uv?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

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

export async function fetchRainNowcast(lat, lon) {
  const res = await fetch(`${BASE}/radar/nowcast?lat=${lat}&lon=${lon}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchWarnings() {
  const res = await fetch(`${BASE}/warnings`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

const _SUM_TTL = 30 * 60 * 1000
function _loadCachedSummary(period) {
  try { const { ts, d } = JSON.parse(localStorage.getItem(`summary_v1_${period}`) || '{}'); if (d && Date.now() - ts < _SUM_TTL) return d } catch {}
  return null
}
function _saveSummaryCache(period, data) {
  try { localStorage.setItem(`summary_v1_${period}`, JSON.stringify({ ts: Date.now(), d: data })) } catch {}
}

export async function fetchSummary(period = 'today') {
  const cached = _loadCachedSummary(period)
  if (cached) return cached
  const res = await fetch(`${BASE}/summary?period=${period}`)
  if (!res.ok) throw new Error(await res.text())
  const data = await res.json()
  _saveSummaryCache(period, data)
  return data
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

const _CI_KEY = 'city_images_v1'
const _CI_TTL = 30 * 60 * 1000
function _loadCachedCityImages() {
  try { const { ts, d } = JSON.parse(localStorage.getItem(_CI_KEY) || '{}'); if (d && Date.now() - ts < _CI_TTL) return d } catch {}
  return null
}
function _saveCityImagesCache(data) {
  try { localStorage.setItem(_CI_KEY, JSON.stringify({ ts: Date.now(), d: data })) } catch {}
}

let _cityImagesPromise = null
export async function fetchCityImages() {
  if (_cityImagesPromise) return _cityImagesPromise
  const cached = _loadCachedCityImages()
  if (cached) return cached
  _cityImagesPromise = fetch(`${BASE}/city-images`)
    .then(res => { if (!res.ok) throw new Error(); return res.json() })
    .then(data => { _saveCityImagesCache(data); return data })
    .catch(err => { _cityImagesPromise = null; throw err })
  return _cityImagesPromise
}

export async function uploadCityImage(formData) {
  const res = await fetch(`${BASE}/city-images`, { method: 'POST', body: formData })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function replaceCityImage(id, formData) {
  const res = await fetch(`${BASE}/city-images/${id}/replace`, { method: 'POST', body: formData })
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

export async function askPlanner({ q, lat, lon, radius = 5.0 } = {}) {
  const res = await fetch(`${BASE}/planner/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, lat, lon, radius }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchPlanner({ lat, lon, radius = 5.0, date, fromHour, toHour, type = 'all', tags = '' } = {}) {
  const params = new URLSearchParams({ lat, lon, radius, from_hour: fromHour, to_hour: toHour, type })
  if (date) params.set('date', date)
  if (tags) params.set('tags', tags)
  const res = await fetch(`${BASE}/planner?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchTopTerraces({ lat, lon, radius = 3.0, limit = 3 } = {}) {
  const params = new URLSearchParams({ lat, lon, radius, limit })
  const res = await fetch(`${BASE}/sun-terraces/top?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchSunTerraces({ lat, lon, radius = 2.0, type = 'all', minScore = 0, name = '', tags = '' } = {}) {
  const params = new URLSearchParams({ lat, lon, radius, type, min_score: minScore })
  if (name) params.set('name', name)
  if (tags) params.set('tags', tags)
  const res = await fetch(`${BASE}/sun-terraces?${params}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchHashtags() {
  const res = await fetch(`${BASE}/hashtags`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function addHashtag(terraceId, hashtagId) {
  const res = await fetch(`${BASE}/sun-terraces/${terraceId}/hashtags/${hashtagId}`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function removeHashtag(terraceId, hashtagId) {
  const res = await fetch(`${BASE}/sun-terraces/${terraceId}/hashtags/${hashtagId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function createHashtag(name) {
  const res = await fetch(`${BASE}/admin/hashtags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deleteHashtag(id) {
  const res = await fetch(`${BASE}/admin/hashtags/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

export async function createTerrace(fields) {
  const res = await fetch(`${BASE}/sun-terraces/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function reportTerrace(id, userLat, userLon, feedback = null) {
  const res = await fetch(`${BASE}/sun-terraces/${id}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_lat: userLat ?? null,
      user_lon: userLon ?? null,
      feedback: feedback ? JSON.stringify(feedback) : null,
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchReportsAdmin(statusFilter = 'all') {
  const res = await fetch(`${BASE}/votes/admin?status_filter=${statusFilter}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function updateReportStatus(id, status) {
  const res = await fetch(`${BASE}/reports/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function autoArcTerraces() {
  const res = await fetch(`${BASE}/sun-terraces/auto-arc`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fixTerraceAddresses() {
  const res = await fetch(`${BASE}/sun-terraces/fix-addresses`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerEnrichOsm() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/osm`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function fetchEnrichOsmStatus() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/osm/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function triggerEnrichAi() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/ai`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function fetchEnrichAiStatus() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/ai/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerGeocodeTerraces() {
  const res = await fetch(`${BASE}/sun-terraces/geocode`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchGeocodeStatus() {
  const res = await fetch(`${BASE}/sun-terraces/geocode/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerAutoTag() {
  const res = await fetch(`${BASE}/sun-terraces/auto-tag`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchAutoTagStatus() {
  const res = await fetch(`${BASE}/sun-terraces/auto-tag/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerAreaTag() {
  const res = await fetch(`${BASE}/sun-terraces/area-tag`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchAreaTagStatus() {
  const res = await fetch(`${BASE}/sun-terraces/area-tag/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerEnrichShadow() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/shadow`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchEnrichShadowStatus() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/shadow/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerEnrichOpeningHours() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/opening-hours`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchEnrichOpeningHoursStatus() {
  const res = await fetch(`${BASE}/sun-terraces/enrich/opening-hours/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchSunTerracesAdmin() {
  const res = await fetch(`${BASE}/sun-terraces/admin`, { cache: 'no-store' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchSunTerracesStats() {
  const res = await fetch(`${BASE}/sun-terraces/stats`, { cache: 'no-store' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerOsmRefresh() {
  const res = await fetch(`${BASE}/sun-terraces/refresh`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchOsmRefreshStatus() {
  const res = await fetch(`${BASE}/sun-terraces/refresh/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function triggerGoogleImport() {
  const res = await fetch(`${BASE}/sun-terraces/import/google`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchGoogleImportStatus() {
  const res = await fetch(`${BASE}/sun-terraces/import/google/status`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function overrideTerrace(id, { orientation, orientation_confidence, amenity_type, active, outdoor_type, polygon_coords, name, address, sun_arc_from, sun_arc_to }) {
  const res = await fetch(`${BASE}/sun-terraces/${id}/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orientation, orientation_confidence, amenity_type, active, outdoor_type, polygon_coords, name, address, sun_arc_from, sun_arc_to }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deleteTerrace(id) {
  const res = await fetch(`${BASE}/sun-terraces/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function askWeatherChat({ q, lat, lon } = {}) {
  const token = localStorage.getItem('gbgsol_app_token') || ''
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ q, lat: lat ?? 57.7089, lon: lon ?? 11.9746 }),
  })
  if (res.status === 401 || res.status === 403) throw new Error('premium_required')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deriveArcFromPolygon(id) {
  const res = await fetch(`${BASE}/sun-terraces/${id}/derive-arc`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchEnsembleTrend(days = 14) {
  const res = await fetch(`${BASE}/ensemble/trend?days=${days}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function fetchEnsembleHealth() {
  const res = await fetch(`${BASE}/ensemble/health`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function excludeSource(source) {
  const res = await fetch(`${BASE}/ensemble/sources/${encodeURIComponent(source)}/exclude`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function includeSource(source) {
  const res = await fetch(`${BASE}/ensemble/sources/${encodeURIComponent(source)}/include`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
