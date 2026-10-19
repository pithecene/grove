import type { HistoryProvenance, TimelineEntry } from '../server/timeline'

interface StructuralTimelineProps {
  timeline: TimelineEntry[]
  provenance?: HistoryProvenance
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

/** UTC days, as "Oct 19, 2026" / "Oct 19 and Oct 21, 2026" / "a, b and c". */
/** Date-only values are UTC days; render them as such in every time zone. */
const utcDayFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

function formatDays(days: string[]): string {
  const names = days.map((d) => utcDayFormat.format(new Date(`${d}T00:00:00.000Z`)))
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function StructuralTimeline({ timeline, provenance }: StructuralTimelineProps) {
  if (timeline.length === 0 && !provenance) return null

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

        {provenance && (
          <div
            className="py-2 text-xs"
            style={{ color: 'var(--grove-text-muted)', opacity: 0.5 }}
          >
            {provenance.days} {provenance.days === 1 ? 'day' : 'days'} in this series
            {provenance.days === 1
              ? ` (${formatDays([provenance.from])})`
              : `, ${formatDays([provenance.from])} through ${formatDays([provenance.through])},`}{' '}
            recorded from the repository&rsquo;s history
            {provenance.recordedOn.length > 0 ? ` on ${formatDays(provenance.recordedOn)}` : ''}
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
  }
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
        {formatDate(entry.observedAt)} ({entry.days} days without observation
        {entry.recordedFromHistory
          ? `; ${entry.recordedFromHistory.days} of them recorded from history${
              entry.recordedFromHistory.recordedOn.length > 0
                ? ` on ${formatDays(entry.recordedFromHistory.recordedOn)}`
                : ''
            }`
          : ''}
        )
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
          ? `Structural character first recorded as ${formatTierName(entry.toTier)}`
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
        {formatTierName(entry.tier)} &mdash; {formatDate(entry.observedAt)} through{' '}
        {formatDate(entry.spanEnd)} ({entry.days} {entry.days === 1 ? 'day' : 'days'})
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
    </div>
  )
}
