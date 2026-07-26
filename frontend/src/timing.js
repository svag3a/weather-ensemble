const STORAGE_KEY = 'startup_timing_v1'
const MAX_SESSIONS = 30

let _t0 = performance.now()
let _marks = []

export function timingMark(label) {
  const ms = Math.round(performance.now() - _t0)
  _marks.push({ label, ms })
  console.log(`[timing] +${ms}ms ${label}`)
}

export function timingReset() {
  _t0 = performance.now()
  _marks = []
}

export function timingSave() {
  try {
    const sessions = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    sessions.push({ at: Date.now(), marks: [..._marks] })
    if (sessions.length > MAX_SESSIONS) sessions.splice(0, sessions.length - MAX_SESSIONS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  } catch {}
}

export function timingGetSessions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}

export function timingClearSessions() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}
