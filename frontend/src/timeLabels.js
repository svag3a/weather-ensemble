export function addTimeLabels(data) {
  let lastDate = null
  return data.map(d => {
    const dt = new Date(d.time ?? d.valid_for ?? d)
    const date = `${dt.getMonth() + 1}/${dt.getDate()}`
    const hour = `${String(dt.getHours()).padStart(2, '0')}:00`
    const label = date !== lastDate ? `${date} ${hour}` : hour
    lastDate = date
    return { ...d, time: label }
  })
}

export function formatIso(iso) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`
}
