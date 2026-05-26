/**
 * Rule-based forecast summary generator (Swedish).
 * Looks for meaningful changes in the next 12 hours and returns 1–2 sentences.
 */

function fmt(isoString) {
  const h = new Date(isoString).getHours()
  return `kl ${String(h).padStart(2, '0')}:00`
}

function timeOfDay(isoString) {
  const h = new Date(isoString).getHours()
  if (h >= 5  && h < 10) return 'på morgonen'
  if (h >= 10 && h < 13) return 'på förmiddagen'
  if (h >= 13 && h < 17) return 'på eftermiddagen'
  if (h >= 17 && h < 21) return 'på kvällen'
  return 'under natten'
}

export function generateSummary(forecasts) {
  if (!forecasts?.length) return null

  const now = new Date()
  const future = forecasts.filter(fc => new Date(fc.valid_for) > now)
  if (future.length === 0) return null

  const next12 = future.slice(0, 12)
  const next6  = future.slice(0, 6)

  const sentences = []

  // ── Rain transitions ─────────────────────────────────────────────────────
  const isRainy  = fc => fc.precip_probability >= 40
  const isDry    = fc => fc.precip_probability < 20
  const currentlyRaining = isRainy(next12[0])

  if (currentlyRaining) {
    // Find when it clears
    const clearIdx = next12.findIndex((fc, i) => i > 0 && isDry(fc))
    if (clearIdx !== -1) {
      sentences.push(`Regnet väntas avta ${fmt(next12[clearIdx].valid_for)}.`)
    } else {
      sentences.push('Regnigt väder de närmaste timmarna.')
    }
  } else {
    // Find when rain starts
    const rainIdx = next12.findIndex(fc => isRainy(fc))
    if (rainIdx !== -1) {
      const peak = Math.round(
        Math.max(...next12.slice(rainIdx, rainIdx + 4).map(f => f.precip_probability))
      )
      sentences.push(
        `Regnchans ökar till ${peak}% ${fmt(next12[rainIdx].valid_for)}.`
      )
      // Does it stop again within the window?
      const clearAfter = next12.findIndex((fc, i) => i > rainIdx && isDry(fc))
      if (clearAfter !== -1) {
        sentences.push(`Uppklarnande väntas ${fmt(next12[clearAfter].valid_for)}.`)
      }
    }
  }

  // ── Wind change ───────────────────────────────────────────────────────────
  const currentWind = next12[0]?.wind_speed ?? 0
  const maxWindFc   = next6.reduce((a, b) => (b.wind_speed ?? 0) > (a.wind_speed ?? 0) ? b : a, next6[0])
  const maxWind     = maxWindFc?.wind_speed ?? 0
  if (maxWind >= 10 && maxWind > currentWind + 3 && sentences.length < 2) {
    sentences.push(
      `Vinden ökar till ${Math.round(maxWind)} m/s ${timeOfDay(maxWindFc.valid_for)}.`
    )
  }

  // ── Temperature trend ─────────────────────────────────────────────────────
  const temps = next6.map(fc => fc.temperature).filter(t => t != null)
  if (temps.length >= 3 && sentences.length < 2) {
    const diff = temps[temps.length - 1] - temps[0]
    if (diff <= -4)
      sentences.push(`Temperaturen sjunker med ${Math.abs(Math.round(diff))} grader under kommande timmar.`)
    else if (diff >= 4)
      sentences.push(`Temperaturen stiger med ${Math.round(diff)} grader under kommande timmar.`)
  }

  // ── Stable fallback ───────────────────────────────────────────────────────
  if (sentences.length === 0) {
    const avgPrecip = next6.reduce((s, f) => s + f.precip_probability, 0) / next6.length
    if (avgPrecip >= 30) {
      sentences.push('Ostabilt med regnchans de närmaste timmarna.')
    } else {
      sentences.push('Vädret förblir stabilt de närmaste 6 timmarna.')
    }
  }

  return sentences.join(' ')
}

/**
 * Overall confidence for a set of forecast rows (0–1 → 'hög'/'medel'/'låg').
 * Uses the average confidence of the first N hours.
 */
export function summariseConfidence(forecasts, hours = 6) {
  const now = new Date()
  const slice = forecasts
    ?.filter(fc => new Date(fc.valid_for) > now)
    .slice(0, hours)
    .map(fc => fc.confidence)
    .filter(c => c != null)

  if (!slice?.length) return null

  const avg = slice.reduce((s, c) => s + c, 0) / slice.length
  if (avg >= 0.70) return { level: 'hög',   color: 'text-green-400',  bg: 'bg-green-900/30',  score: avg }
  if (avg >= 0.45) return { level: 'medel', color: 'text-yellow-400', bg: 'bg-yellow-900/30', score: avg }
  return               { level: 'låg',   color: 'text-red-400',    bg: 'bg-red-900/30',    score: avg }
}
