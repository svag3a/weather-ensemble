import { useState } from 'react'
import { overrideTerrace } from '../api'

const ORIENTATIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'UNKNOWN']

function EditForm({ terrace, onSave, onCancel }) {
  const [orientation, setOrientation] = useState(terrace.street_orientation || 'UNKNOWN')
  const [confidence, setConfidence] = useState(terrace.orientation_confidence ?? 0.3)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await overrideTerrace(terrace.id, {
        orientation,
        orientation_confidence: parseFloat(confidence),
      })
      onSave()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="bg-slate-700/50">
      <td colSpan={8} className="px-4 py-3">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-slate-400 text-xs">Orientering</label>
            <select
              value={orientation}
              onChange={e => setOrientation(e.target.value)}
              className="bg-slate-600 text-slate-200 text-sm rounded px-2 py-1 border border-slate-500"
            >
              {ORIENTATIONS.map(o => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-slate-400 text-xs">Säkerhet (0–1)</label>
            <input
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={confidence}
              onChange={e => setConfidence(e.target.value)}
              className="bg-slate-600 text-slate-200 text-sm rounded px-2 py-1 border border-slate-500 w-20"
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
            >
              {saving ? 'Sparar…' : 'Spara'}
            </button>
            <button
              onClick={onCancel}
              className="bg-slate-600 hover:bg-slate-500 text-slate-200 text-xs px-3 py-1.5 rounded transition-colors"
            >
              Avbryt
            </button>
          </div>
          {error && <span className="text-red-400 text-xs">{error}</span>}
        </div>
      </td>
    </tr>
  )
}

export default function SunTerraceAdmin({ data, onOverride, onReload }) {
  const [editingId, setEditingId] = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [activeFilter, setActiveFilter] = useState('active')

  if (!data) {
    return (
      <div className="text-slate-400 text-sm text-center py-8">
        Hämtar uteserveringar…
      </div>
    )
  }

  const active = data.filter(t => t.active)
  const inactive = data.filter(t => !t.active)

  let filtered = data
  if (typeFilter !== 'all') filtered = filtered.filter(t => t.amenity_type === typeFilter)
  if (activeFilter === 'active') filtered = filtered.filter(t => t.active)
  if (activeFilter === 'inactive') filtered = filtered.filter(t => !t.active)

  async function handleSaved() {
    setEditingId(null)
    onReload?.()
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4">
        <div className="bg-slate-700 rounded-lg px-4 py-2 text-center">
          <div className="text-white font-semibold text-lg">{active.length}</div>
          <div className="text-slate-400 text-xs">Aktiva</div>
        </div>
        <div className="bg-slate-700 rounded-lg px-4 py-2 text-center">
          <div className="text-white font-semibold text-lg">{inactive.length}</div>
          <div className="text-slate-400 text-xs">Inaktiva</div>
        </div>
        <div className="bg-slate-700 rounded-lg px-4 py-2 text-center">
          <div className="text-white font-semibold text-lg">{data.filter(t => t.street_orientation && t.street_orientation !== 'UNKNOWN').length}</div>
          <div className="text-slate-400 text-xs">Med orientering</div>
        </div>
        <button
          onClick={onReload}
          className="ml-auto bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs px-3 py-2 rounded-lg border border-slate-600 transition-colors"
        >
          Ladda om
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {[['all', 'Alla typer'], ['cafe', 'Café'], ['bar', 'Bar'], ['restaurant', 'Restaurang'], ['pub', 'Pub']].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setTypeFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              typeFilter === v
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'
            }`}
          >
            {l}
          </button>
        ))}
        <div className="w-px bg-slate-600 self-stretch" />
        {[['active', 'Aktiva'], ['inactive', 'Inaktiva'], ['all_status', 'Alla']].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setActiveFilter(v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              activeFilter === v
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      <p className="text-slate-500 text-xs">{filtered.length} uteserveringar</p>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-slate-400 text-xs">
              <th className="text-left px-4 py-3">Namn</th>
              <th className="text-left px-4 py-3">Typ</th>
              <th className="text-left px-4 py-3">Orientering</th>
              <th className="text-left px-4 py-3">Säkerhet</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Senast sedd</th>
              <th className="text-left px-4 py-3">Adress</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <>
                <tr key={t.id} className={`border-t border-slate-700 ${t.active ? '' : 'opacity-50'} hover:bg-slate-700/30 transition-colors`}>
                  <td className="px-4 py-3 text-white font-medium max-w-[200px] truncate">
                    {t.name}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{t.amenity_type}</td>
                  <td className="px-4 py-3">
                    <span className={`font-mono text-xs ${
                      !t.street_orientation || t.street_orientation === 'UNKNOWN'
                        ? 'text-slate-500'
                        : 'text-green-400'
                    }`}>
                      {t.street_orientation || 'UNKNOWN'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs ${
                      t.orientation_confidence > 0.6 ? 'text-green-400'
                      : t.orientation_confidence > 0.4 ? 'text-yellow-400'
                      : 'text-slate-500'
                    }`}>
                      {(t.orientation_confidence * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      t.active
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-slate-600 text-slate-400'
                    }`}>
                      {t.active ? 'Aktiv' : 'Inaktiv'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {t.last_seen_at ? new Date(t.last_seen_at).toLocaleDateString('sv-SE') : '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs max-w-[150px] truncate">
                    {t.address || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setEditingId(editingId === t.id ? null : t.id)}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Redigera
                    </button>
                  </td>
                </tr>
                {editingId === t.id && (
                  <EditForm
                    key={`edit-${t.id}`}
                    terrace={t}
                    onSave={handleSaved}
                    onCancel={() => setEditingId(null)}
                  />
                )}
              </>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-slate-500 text-sm text-center py-8">Inga uteserveringar.</div>
        )}
      </div>
    </div>
  )
}
