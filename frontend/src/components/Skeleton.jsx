const GLASS = 'bg-black/20 backdrop-blur-sm border border-white/10'

function Sk({ className = '' }) {
  return <div className={`skeleton rounded ${className}`} />
}

export function TerraceListSkeleton({ count = 3 }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`${GLASS} rounded-2xl p-4 space-y-3`}>
          <div className="flex items-start gap-2">
            <Sk className="w-12 h-12 rounded-full shrink-0" />
            <div className="flex-1 space-y-2 pt-1">
              <Sk className="h-4 w-2/3 rounded" />
              <Sk className="h-3 w-1/2 rounded" />
            </div>
            <Sk className="w-5 h-5 rounded-full shrink-0" />
          </div>
          <div className="flex gap-2">
            <Sk className="h-5 w-16 rounded-full" />
            <Sk className="h-5 w-14 rounded-full" />
          </div>
          <Sk className="h-8 w-full rounded-xl" />
        </div>
      ))}
    </div>
  )
}

export function WeekForecastSkeleton({ count = 5 }) {
  return (
    <div className={`${GLASS} rounded-2xl overflow-hidden`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-700/50 last:border-0">
          <div className="w-24 space-y-1.5 shrink-0">
            <Sk className="h-3.5 w-16 rounded" />
            <Sk className="h-3 w-10 rounded" />
          </div>
          <Sk className="w-8 h-8 rounded-full shrink-0" />
          <div className="flex-1">
            <Sk className="h-2 w-full rounded-full" />
          </div>
          <div className="flex gap-2 shrink-0">
            <Sk className="h-4 w-7 rounded" />
            <Sk className="h-4 w-7 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function SummaryCardSkeleton() {
  return (
    <div className="space-y-3">
      <div className={`${GLASS} rounded-2xl p-5 space-y-3`}>
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-2">
            <Sk className="h-5 w-3/4 rounded" />
            <Sk className="h-5 w-1/2 rounded" />
          </div>
          <Sk className="h-6 w-20 rounded-full shrink-0" />
        </div>
        <Sk className="h-3 w-full rounded" />
        <Sk className="h-3 w-5/6 rounded" />
        <Sk className="h-3 w-2/3 rounded" />
      </div>
      <div className={`${GLASS} rounded-2xl p-4 space-y-2.5`}>
        <Sk className="h-3.5 w-1/3 rounded" />
        <Sk className="h-3 w-full rounded" />
        <Sk className="h-3 w-4/5 rounded" />
      </div>
      <div className={`${GLASS} rounded-2xl p-4 space-y-2.5`}>
        <Sk className="h-3.5 w-1/4 rounded" />
        <Sk className="h-3 w-full rounded" />
        <Sk className="h-3 w-3/4 rounded" />
      </div>
    </div>
  )
}

export function AnalysViewSkeleton() {
  return (
    <div className={`${GLASS} rounded-2xl p-4 space-y-4`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Sk className="h-3.5 w-24 rounded shrink-0" />
          <div className="flex-1">
            <Sk className="h-2.5 rounded-full" style={{ width: `${55 + i * 8}%` }} />
          </div>
          <Sk className="h-3.5 w-8 rounded shrink-0" />
        </div>
      ))}
    </div>
  )
}
