import type { BindingRow } from './db/bindings'
import type { declarationChanges, ecologySnapshots } from './db/schema'

type SnapshotRow = typeof ecologySnapshots.$inferSelect
type DeclarationRow = typeof declarationChanges.$inferSelect

/**
 * Consecutive observations further apart than this are shown as a span
 * that was not observed. Matches one persistence window (§4.1).
 */
export const OBSERVATION_GAP_DAYS = 14

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type TimelineEntry =
  | {
      kind: 'density_transition'
      observedAt: string
      fromTier: string | null
      toTier: string
      freshlyRecorded?: boolean
      /** Method of the row the transition was read from: `observed` or `history` */
      method: string
    }
  | {
      kind: 'density_span'
      observedAt: string
      tier: string
      spanEnd: string
      observationCount: number
      /** Distinct UTC days in the run (a day may hold more than one row) */
      days: number
      freshlyRecorded?: boolean
      /** `observed`, `history`, or `mixed` when the run spans both methods */
      method: 'observed' | 'history' | 'mixed'
    }
  | {
      kind: 'declaration_change'
      observedAt: string
      changes: Array<{ field: string; from: string | null; to: string | null }>
      /** `observed` at that moment, or `history` (a commit; `recordedAt` says when it was read) */
      method: string
      recordedAt: string | null
    }
  | {
      /** No observation between `lastObservedAt` and `observedAt` (the resumption). */
      kind: 'observation_gap'
      observedAt: string
      lastObservedAt: string
      days: number
      /** Days inside the span recorded from the repository's history, and the UTC days they were recorded on */
      recordedFromHistory?: { days: number; recordedOn: string[] }
    }
  | {
      /**
       * The identity was observed under a new name. The rename happened
       * somewhere between `lastSeenUnderPrevious` and `observedAt`; the
       * exact moment is not observed.
       */
      kind: 'name_change'
      observedAt: string
      fromName: string
      toName: string
      lastSeenUnderPrevious: string
    }

export interface TimelineIdentity {
  /** Bindings of the identity, any order */
  bindings: BindingRow[]
}

/**
 * Build a structural timeline from snapshot and declaration history.
 *
 * Both inputs are expected in DESC order (most recent first) as returned
 * by the DB query functions. The output is also DESC (most recent first).
 *
 * @param historyComplete - true when the fetched window contains the full
 *   history for this repo (i.e. rows returned < limit). When false, the
 *   earliest entry in the window is not necessarily the first-ever
 *   observation, so "first observed" framing is suppressed.
 * @param identity - when given, name changes between bindings are emitted.
 * @param declarationsComplete - true when the fetched declaration rows are
 *   the full declaration history (rows returned < limit).
 * @param series - optional separately fetched series: `observed` snapshots
 *   (with their own truncation state) bound the spans without observation,
 *   and `historyDays` (dates only, all of them) say how much of each such
 *   span was recorded from history. Without them both are derived from
 *   `snapshotsDesc`, which a long reconstructed run would crowd out of a
 *   bounded window.
 */
export function buildTimeline(
  snapshotsDesc: SnapshotRow[],
  declarationsDesc: DeclarationRow[],
  freshSnapshotRecorded: boolean,
  historyComplete: boolean,
  identity?: TimelineIdentity,
  declarationsComplete = true,
  series?: {
    observed: {
      snapshots: SnapshotRow[]
      complete: boolean
      declarations: DeclarationRow[]
      declarationsComplete: boolean
    }
    historyDays: Array<{ observedAt: string; recordedAt: string | null }>
  },
): TimelineEntry[] {
  const densityEntries = buildDensityEntries(snapshotsDesc, historyComplete)

  // Mark the most recent density entry as freshly recorded.
  // This is the last entry in ascending build order (last element in the array).
  if (freshSnapshotRecorded && densityEntries.length > 0) {
    const last = densityEntries[densityEntries.length - 1]
    if (last.kind === 'density_transition' || last.kind === 'density_span') {
      last.freshlyRecorded = true
    }
  }

  const declarationEntries = buildDeclarationEntries(declarationsDesc)
  const gapEntries = series
    ? buildGapEntries(series.observed.snapshots, series.observed.declarations, {
        snapshotsComplete: series.observed.complete,
        declarationsComplete: series.observed.declarationsComplete,
      })
    : buildGapEntries(snapshotsDesc, declarationsDesc, {
        snapshotsComplete: historyComplete,
        declarationsComplete,
      })
  const nameEntries = identity ? buildNameChangeEntries(identity.bindings) : []
  const historyDays = series
    ? series.historyDays
    : snapshotsDesc.filter((s) => s.method === 'history')
  for (const gap of gapEntries) {
    if (gap.kind === 'observation_gap') annotateGapWithHistory(gap, historyDays)
  }

  // Merge chronologically DESC (most recent first). On equal timestamps a
  // gap sorts after (older than) the observation that ended it.
  const merged = [
    ...densityEntries,
    ...declarationEntries,
    ...gapEntries,
    ...nameEntries,
  ].sort((a, b) => {
    const byTime = b.observedAt.localeCompare(a.observedAt)
    if (byTime !== 0) return byTime
    return rank(a) - rank(b)
  })

  return merged
}

function rank(entry: TimelineEntry): number {
  switch (entry.kind) {
    case 'observation_gap':
      return 2
    case 'name_change':
      return 1
    default:
      return 0
  }
}

// ── Observation gaps ──────────────────────────────────────────────

/**
 * Emit one entry per span of OBSERVATION_GAP_DAYS or more between
 * consecutive observations. A span without observation is reported as
 * exactly that — not as inactivity, not as stability.
 *
 * A recorded declaration change is an observation too (it is written when
 * the repository was looked at, whether or not a snapshot was throttled),
 * so both histories bound the spans.
 *
 * A truncated series has no lower edge: its oldest retained row is not the
 * start of observation, and rows omitted beyond it may fill any interval
 * older than it. Nothing older than the oldest retained row of a truncated
 * series is read as a span without observation.
 */
export interface GapBounds {
  /** false when older snapshots exist beyond the fetched rows */
  snapshotsComplete?: boolean
  /** false when older declaration rows exist beyond the fetched rows */
  declarationsComplete?: boolean
}

export function buildGapEntries(
  snapshotsDesc: SnapshotRow[],
  declarationsDesc: DeclarationRow[] = [],
  bounds: GapBounds = {},
): TimelineEntry[] {
  // Only contemporaneous observations bound a span: a row recorded from
  // history says what the repository was, not that Grove looked.
  const observedSnapshots = snapshotsDesc.filter((s) => s.method !== 'history')
  const observedDeclarations = declarationsDesc.filter((d) => d.method !== 'history')
  const edges: string[] = []
  if (bounds.snapshotsComplete === false && observedSnapshots.length > 0) {
    edges.push(observedSnapshots[observedSnapshots.length - 1].observedAt)
  }
  if (bounds.declarationsComplete === false && observedDeclarations.length > 0) {
    edges.push(observedDeclarations[observedDeclarations.length - 1].observedAt)
  }
  const edge = edges.length > 0 ? edges.reduce((a, b) => (a > b ? a : b)) : undefined
  const instants = [
    ...new Set([
      ...observedSnapshots.map((s) => s.observedAt),
      ...observedDeclarations.map((d) => d.observedAt),
    ]),
  ]
    .filter((t) => edge === undefined || t >= edge)
    .sort()
  const entries: TimelineEntry[] = []
  for (let i = 1; i < instants.length; i++) {
    const prev = instants[i - 1]
    const curr = instants[i]
    const ms = new Date(curr).getTime() - new Date(prev).getTime()
    const days = Math.floor(ms / MS_PER_DAY)
    if (days >= OBSERVATION_GAP_DAYS) {
      entries.push({
        kind: 'observation_gap',
        observedAt: curr,
        lastObservedAt: prev,
        days,
      })
    }
  }
  return entries
}

// ── Days recorded from history ────────────────────────────────────

type HistoryDay = { observedAt: string; recordedAt: string | null }

/** The distinct UTC days a set of history rows were recorded on, ascending. */
function recordingDays(historyDays: HistoryDay[]): string[] {
  return [
    ...new Set(historyDays.flatMap((d) => (d.recordedAt ? [d.recordedAt.slice(0, 10)] : []))),
  ].sort()
}

/**
 * Say, on a span without observation, how many of its days were recorded
 * from the repository's history and when. Provenance is stated where
 * presence is the subject; the days themselves take their place in the
 * series like any other day.
 */
function annotateGapWithHistory(
  gap: Extract<TimelineEntry, { kind: 'observation_gap' }>,
  historyDays: HistoryDay[],
): void {
  const lastDay = gap.lastObservedAt.slice(0, 10)
  const resumeDay = gap.observedAt.slice(0, 10)
  const inside = historyDays.filter((d) => {
    const day = d.observedAt.slice(0, 10)
    return day > lastDay && day < resumeDay
  })
  const days = new Set(inside.map((d) => d.observedAt.slice(0, 10)))
  if (days.size > 0) {
    gap.recordedFromHistory = { days: days.size, recordedOn: recordingDays(inside) }
  }
}

export interface HistoryProvenance {
  /** Distinct UTC days in the series recorded from the repository's history */
  days: number
  /** The first and last of those days (UTC) */
  from: string
  through: string
  /** The UTC days those recordings were made on, ascending */
  recordedOn: string[]
}

/**
 * The series' provenance in one statement: how many of its days were
 * recorded from history, and when — whether or not they fall inside a span
 * without observation. Every row keeps its own method.
 */
export function historyProvenance(historyDays: HistoryDay[]): HistoryProvenance | undefined {
  if (historyDays.length === 0) return undefined
  const days = [...new Set(historyDays.map((d) => d.observedAt.slice(0, 10)))].sort()
  return {
    days: days.length,
    from: days[0],
    through: days[days.length - 1],
    recordedOn: recordingDays(historyDays),
  }
}

// ── Name changes ──────────────────────────────────────────────────

function buildNameChangeEntries(bindings: BindingRow[]): TimelineEntry[] {
  const ordered = [...bindings].sort((a, b) =>
    a.firstObservedAt.localeCompare(b.firstObservedAt),
  )
  const entries: TimelineEntry[] = []
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const curr = ordered[i]
    if (prev.fullName === curr.fullName) continue
    entries.push({
      kind: 'name_change',
      observedAt: curr.firstObservedAt,
      fromName: prev.fullName,
      toName: curr.fullName,
      lastSeenUnderPrevious: prev.lastObservedAt,
    })
  }
  return entries
}

// ── Density entries ──────────────────────────────────────────────

function buildDensityEntries(
  snapshotsDesc: SnapshotRow[],
  historyComplete: boolean,
): TimelineEntry[] {
  // Reverse to ascending order for walk
  const asc = [...snapshotsDesc].reverse()

  // Filter out snapshots with null density tier
  const withTier = asc.filter(
    (s): s is SnapshotRow & { densityTier: string } => s.densityTier != null,
  )

  if (withTier.length === 0) return []

  const entries: TimelineEntry[] = []

  // Walk ascending — detect transitions and compress spans
  let runStart = withTier[0]
  let runCount = 1
  let runDays = new Set<string>([withTier[0].observedAt.slice(0, 10)])
  let runMethods = new Set<string>([withTier[0].method])
  let prevTier: string | null = null
  const spanMethod = (methods: Set<string>): 'observed' | 'history' | 'mixed' =>
    methods.size > 1 ? 'mixed' : methods.has('history') ? 'history' : 'observed'

  // Only emit "first observed" (fromTier: null) when the history window
  // contains the complete record. When truncated, the earliest snapshot
  // in the window is not the first-ever observation.
  if (historyComplete) {
    entries.push({
      kind: 'density_transition',
      observedAt: withTier[0].observedAt,
      fromTier: null,
      toTier: withTier[0].densityTier,
      method: withTier[0].method,
    })
  }
  prevTier = withTier[0].densityTier

  for (let i = 1; i < withTier.length; i++) {
    const snap = withTier[i]

    if (snap.densityTier === prevTier) {
      // Continue the run
      runCount++
      runDays.add(snap.observedAt.slice(0, 10))
      runMethods.add(snap.method)
    } else {
      // Emit span for the completed run (only if run >= 2)
      if (runCount >= 2) {
        entries.push({
          kind: 'density_span',
          observedAt: runStart.observedAt,
          tier: prevTier!,
          spanEnd: withTier[i - 1].observedAt,
          observationCount: runCount,
          days: runDays.size,
          method: spanMethod(runMethods),
        })
      }

      // Emit transition
      entries.push({
        kind: 'density_transition',
        observedAt: snap.observedAt,
        fromTier: prevTier,
        toTier: snap.densityTier,
        method: snap.method,
      })

      prevTier = snap.densityTier
      runStart = snap
      runCount = 1
      runDays = new Set([snap.observedAt.slice(0, 10)])
      runMethods = new Set([snap.method])
    }
  }

  // Emit trailing span if run >= 2
  if (runCount >= 2) {
    entries.push({
      kind: 'density_span',
      observedAt: runStart.observedAt,
      tier: prevTier!,
      spanEnd: withTier[withTier.length - 1].observedAt,
      observationCount: runCount,
      days: runDays.size,
      method: spanMethod(runMethods),
    })
  }

  return entries
}

// ── Declaration entries ──────────────────────────────────────────

const TRACKED_FIELDS = [
  'phase',
  'intent',
  'horizon',
  'role',
  'steward',
  'consolidationIntervalDays',
] as const

function buildDeclarationEntries(declarationsDesc: DeclarationRow[]): TimelineEntry[] {
  // Reverse to ascending order for walk
  const asc = [...declarationsDesc].reverse()

  if (asc.length === 0) return []

  const entries: TimelineEntry[] = []

  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1]
    const curr = asc[i]
    const changes: Array<{ field: string; from: string | null; to: string | null }> = []

    for (const field of TRACKED_FIELDS) {
      const fromVal = fieldToString(prev[field])
      const toVal = fieldToString(curr[field])
      if (fromVal !== toVal) {
        changes.push({ field, from: fromVal, to: toVal })
      }
    }

    if (changes.length > 0) {
      entries.push({
        kind: 'declaration_change',
        observedAt: curr.observedAt,
        changes,
        method: curr.method,
        recordedAt: curr.recordedAt,
      })
    }
  }

  return entries
}

function fieldToString(
  value: string | number | boolean | null | undefined,
): string | null {
  if (value == null) return null
  return String(value)
}
