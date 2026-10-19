import type { TimelineEntry } from '../server/timeline'

interface StructuralTimelineProps {
  timeline: TimelineEntry[]
}

const MAX_DISPLAY = 20

const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso))
}

const TIER_EMOJI: Record<string, string> = {
  sparse: '🌱',
  rooting: '🌿',
  thickening: '🌳',
  dense_canopy: '🌲',
  tangled_thicket: '🪴',
}

function formatTierName(tier: string): string {
  const emoji = TIER_EMOJI[tier] ?? ''
  const label = tier.replace(/_/g, ' ')
  return emoji ? `${emoji} ${label}` : label
}

function describeDeclarationChange(change: {
  field: string
  from: string | null
  to: string | null
}): string {
  const value = change.to
  const cleared = value == null

  switch (change.field) {
    case 'phase':
      return cleared ? 'Phase undeclared' : `Phase transitioned to ${value}`
    case 'intent':
      return cleared ? 'Intent cleared' : 'Intent re-declared'
    case 'horizon':
      return cleared ? 'Horizon undeclared' : `Horizon shifted to ${value}`
    case 'role':
      return cleared ? 'Role undeclared' : `Role changed to ${value}`
    case 'steward':
      return cleared ? 'Steward undeclared' : `Stewardship transferred to ${value}`
    case 'consolidationIntervalDays':
      return cleared
        ? 'Consolidation interval removed'
        : `Consolidation interval adjusted to ${value} days`
    default:
      return `${change.field} changed to ${value ?? 'undeclared'}`
  }
}

export function StructuralTimeline({ timeline }: StructuralTimelineProps) {
  if (timeline.length === 0) return null

  const visible = timeline.slice(0, MAX_DISPLAY)
  const hiddenCount = timeline.length - visible.length

  return (
    <div>
      <h3
        className="text-sm mb-4 tracking-wide uppercase opacity-60"
        style={{ color: 'var(--grove-text-muted)' }}
      >
        Structural Timeline
      </h3>

      <div
        className="border-l pl-4"
        style={{ borderColor: 'var(--grove-border)' }}
      >
        {visible.map((entry, i) => (
          <div key={i} className="py-2">
            <TimelineEntryView entry={entry} />
          </div>
        ))}

        {hiddenCount > 0 && (
          <div
            className="py-2 text-xs"
            style={{ color: 'var(--grove-text-muted)', opacity: 0.5 }}
          >
            {hiddenCount} earlier observation{hiddenCount !== 1 ? 's' : ''} not
            shown
          </div>
        )}
      </div>
    </div>
  )
}

function TimelineEntryView({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case 'density_transition':
      return <DensityTransitionView entry={entry} />
    case 'density_span':
      return <DensitySpanView entry={entry} />
    case 'declaration_change':
      return <DeclarationChangeView entry={entry} />
    case 'observation_gap':
      return <ObservationGapView entry={entry} />
    case 'name_change':
      return <NameChangeView entry={entry} />
    case 'history_span':
      return <HistorySpanView entry={entry} />
  }
}

function HistorySpanView({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: 'history_span' }>
}) {
  return (
    <div>
      <div
        className="text-xs"
        style={{ color: 'var(--grove-text-muted)', opacity: 0.7 }}
      >
        Recorded from history as the default branch now records it &mdash;{' '}
        {formatDate(entry.observedAt)} through {formatDate(entry.spanEnd)} ({entry.days}{' '}
        {entry.days === 1 ? 'day' : 'days'}
        {entry.recordedAt ? `, recorded ${formatDate(entry.recordedAt)}` : ''})
      </div>
    </div>
  )
}

function ObservationGapView({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: 'observation_gap' }>
}) {
  return (
    <div>
      <div
        className="text-xs"
        style={{ color: 'var(--grove-text-muted)', opacity: 0.7 }}
      >
        Not observed &mdash; {formatDate(entry.lastObservedAt)} through{' '}
        {formatDate(entry.observedAt)} ({entry.days} days without observation)
      </div>
    </div>
  )
}

function NameChangeView({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: 'name_change' }>
}) {
  return (
    <div>
      <div
        className="text-xs opacity-60"
        style={{ color: 'var(--grove-text-muted)' }}
      >
        {formatDate(entry.observedAt)}
      </div>
      <div className="text-sm" style={{ color: 'var(--grove-text)' }}>
        Observed under a new name: {entry.toName}
      </div>
      <div className="text-xs" style={{ color: 'var(--grove-text-muted)' }}>
        previously {entry.fromName}, last seen under that name{' '}
        {formatDate(entry.lastSeenUnderPrevious)}
      </div>
    </div>
  )
}

function DensityTransitionView({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: 'density_transition' }>
}) {
  const isFirst = entry.fromTier === null

  return (
    <div>
      <div
        className="text-xs opacity-60"
        style={{ color: 'var(--grove-text-muted)' }}
      >
        {formatDate(entry.observedAt)}
      </div>
      <div className="text-sm" style={{ color: 'var(--grove-text)' }}>
        {isFirst
          ? entry.method === 'history'
            ? `Structural character first read from history as ${formatTierName(entry.toTier)}`
            : `Structural character first observed as ${formatTierName(entry.toTier)}`
          : 'Structural character shifted'}
      </div>
      {!isFirst && (
        <div
          className="text-xs"
          style={{ color: 'var(--grove-text-muted)' }}
        >
          from {formatTierName(entry.fromTier!)} to{' '}
          {formatTierName(entry.toTier)}
        </div>
      )}
      {entry.method === 'history' && (
        <div className="text-xs" style={{ opacity: 0.7, color: 'var(--grove-text-muted)' }}>
          read from history, not observed that day
        </div>
      )}
      {entry.freshlyRecorded && (
        <div className="text-xs" style={{ opacity: 0.5, color: 'var(--grove-text-muted)' }}>
          Structural state recorded
        </div>
      )}
    </div>
  )
}

function DensitySpanView({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: 'density_span' }>
}) {
  return (
    <div>
      <div
        className="text-xs"
        style={{ color: 'var(--grove-text-muted)' }}
      >
        {entry.method === 'history'
          ? 'Read from history as'
          : entry.method === 'mixed'
            ? 'Observed and read from history as'
            : 'Observed as'}{' '}
        {formatTierName(entry.tier)} &mdash;{' '}
        {formatDate(entry.observedAt)} through {formatDate(entry.spanEnd)} (
        {entry.observationCount} {entry.method === 'history' ? 'days' : 'observations'})
      </div>
      {entry.freshlyRecorded && (
        <div className="text-xs" style={{ opacity: 0.5, color: 'var(--grove-text-muted)' }}>
          Structural state recorded
        </div>
      )}
    </div>
  )
}

function DeclarationChangeView({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: 'declaration_change' }>
}) {
  return (
    <div>
      <div
        className="text-xs opacity-60"
        style={{ color: 'var(--grove-text-muted)' }}
      >
        {formatDate(entry.observedAt)}
      </div>
      {entry.changes.map((change, i) => (
        <div
          key={i}
          className="text-sm"
          style={{ color: 'var(--grove-text)' }}
        >
          {describeDeclarationChange(change)}
        </div>
      ))}
      {entry.method === 'history' && (
        <div
          className="text-xs"
          style={{ color: 'var(--grove-text-muted)', opacity: 0.7 }}
        >
          Declared in repository on {formatDate(entry.observedAt)} &mdash; recorded from history
          {entry.recordedAt ? ` on ${formatDate(entry.recordedAt)}` : ''}
        </div>
      )}
    </div>
  )
}
