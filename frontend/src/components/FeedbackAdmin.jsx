import { useState, useEffect } from 'react'
import { fetchReportsAdmin, updateReportStatus } from '../api'

const STATUSES = [
  { value: 'pending',     label: 'Väntar',    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-600' },
  { value: 'in_progress', label: 'Pågående',  color: 'bg-blue-500/20 text-blue-400 border-blue-600' },
  { value: 'resolved',    label: 'Klar',       color: 'bg-green-500/20 text-green-400 border-green-600' },
  { value: 'dismissed',   label: 'Avvisad',   color: 'bg-slate-600/40 text-slate-400 border-slate-600' },
]

const ISSUE_LABELS = {
  no_outdoor:     'Ingen uteplats',
  has_outdoor:    'Har uteplats (felaktigt utan)',
  wrong_sun:      'Felaktigt solläge',
  wrong_forecast: 'Felaktig solprognos',
  wrong_name:     'Felaktigt namn',
  wrong_address:  'Fel adress',
  wrong_location: 'Fel position',
  wrong_type:     'Fel typ',
  closed:         'Stängt / finns inte',
}

function StatusBadge({ status }) {
  const s = STATUSES.find(x => x.value === status) ?? STATUSES[0]
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${s.color}`}>
      {s.label}
    </span>
  )
}

function StatusSelector({ current, onChange, disabled }) {
  return (
    <select
      value={current}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className="bg-slate-700 text-slate-200 text-xs rounded px-2 py-1 border border-slate-600 focus:outline-none focus:border-blue-500"
    >
      {STATUSES.map(s => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  )
}

function FeedbackRow({ item, onStatusChange }) {
  const [saving, setSaving] = useState(false)

  async function handleStatus(newStatus) {
    setSaving(true)
    try {
      await updateReportStatus(item.id, newStatus)
      onStatusChange(item.id, newStatus)
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  const date = item.reported_at
    ? new Date(item.reported_at).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
    : '—'

  return (
    <div className="border border-slate-700 rounded-xl p-4 space-y-3 bg-slate-800/40">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <span className="text-white font-medium text-sm">{item.terrace_name}</span>
          {item.terrace_address && (
            <span className="text-slate-500 text-xs ml-2">{item.terrace_address}</span>
          )}
          <div className="text-slate-500 text-xs mt-0.5">{date}</div>
        </div>
        <StatusBadge status={item.status}/>
      </div>

      {/* Issues */}
      {item.issues?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.issues.map(id => (
            <span key={id}
              className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-800">
              {ISSUE_LABELS[id] ?? id}
            </span>
          ))}
        </div>
      )}

      {/* Comment */}
      {item.comment && (
        <p className="text-slate-300 text-sm italic bg-slate-700/40 rounded-lg px-3 py-2">
          "{item.comment}"
        </p>
      )}

      {/* Status change */}
      <div className="flex items-center gap-2">
        <span className="text-slate-500 text-xs">Ändra status:</span>
        <StatusSelector current={item.status} onChange={handleStatus} disabled={saving}/>
        {saving && <span className="text-slate-500 text-xs">Sparar…</span>}
      </div>
    </div>
  )
}

export default function FeedbackAdmin() {
  const [items, setItems]     = useState(null)
  const [filter, setFilter]   = useState('pending')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetchReportsAdmin(filter)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [filter])

  function handleStatusChange(id, newStatus) {
    setItems(prev => prev.map(x => x.id === id ? { ...x, status: newStatus } : x))
  }

  const counts = { all: 0, pending: 0, in_progress: 0, resolved: 0, dismissed: 0 }
  if (items) {
    items.forEach(x => { counts[x.status] = (counts[x.status] ?? 0) + 1 })
    counts.all = items.length
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold">Inkommande feedback</h2>
        <span className="text-slate-400 text-xs">{items?.length ?? '…'} ärenden</span>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {[
          { value: 'all',         label: 'Alla' },
          { value: 'pending',     label: 'Väntar' },
          { value: 'in_progress', label: 'Pågående' },
          { value: 'resolved',    label: 'Klara' },
          { value: 'dismissed',   label: 'Avvisade' },
        ].map(f => (
          <button key={f.value} onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              filter === f.value
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-slate-400 text-sm text-center py-8">Hämtar feedback…</div>
      )}

      {!loading && items?.length === 0 && (
        <div className="text-slate-500 text-sm text-center py-8 border border-slate-700 rounded-xl">
          Inga ärenden med status "{filter === 'all' ? 'alla' : STATUSES.find(s => s.value === filter)?.label}".
        </div>
      )}

      {!loading && items && items.length > 0 && (
        <div className="space-y-3">
          {items.map(item => (
            <FeedbackRow key={item.id} item={item} onStatusChange={handleStatusChange}/>
          ))}
        </div>
      )}
    </div>
  )
}
