import { deriveClimateRelation } from './ecosystem-balance'
import { deriveSeason } from './season'
import type {
  Climate,
  ClimateRelation,
  PersistenceAssessment,
  Phase,
  WindowEvidence,
} from './types'
import { PHASES } from './types'

export type { PersistenceAssessment } from './types'

// §4.1 — 14 daily snapshots
export const PERSISTENCE_WINDOW_SIZE = 14

// §4.2/§4.3 — 9 of 14 establishes consistency
export const PERSISTENCE_THRESHOLD = 9

/**
 * Whether a window carries enough *determinate* observations to examine a
 * pattern: a full-size window whose observed days with a derivable relation
 * reach the threshold. Observed days whose relation cannot be derived (no
 * phase, unrecognised phase) are ambiguity, not evidence — they can neither
 * assert nor refute a pattern.
 */
export function hasDeterminateEvidence(persistence: PersistenceAssessment): boolean {
  if (persistence.evidence === 'insufficient') return false
  return (
    persistence.totalSnapshots - persistence.undeterminedCount >= PERSISTENCE_THRESHOLD
  )
}

/**
 * §1.3 — Derive ClimateRelation from a snapshot's stored phase string and the declared climate.
 *
 * Bridges snapshot rows (which store phase as string|null) to the typed climate relation system.
 * Returns undefined if phase is null, undefined, or not a recognized Phase value.
 */
export function deriveSnapshotRelation(
  phase: string | null | undefined,
  climate: Climate,
): ClimateRelation | undefined {
  if (phase == null) return undefined
  if (!(PHASES as readonly string[]).includes(phase)) return undefined

  const seasonDerivation = deriveSeason(phase as Phase)
  if (!seasonDerivation) return undefined

  return deriveClimateRelation(seasonDerivation.season, climate)
}

// ── Calendar-anchored windows ────────────────────────────────────

/** One calendar day inside a window; `snapshot` is undefined when nothing was observed that day. */
export interface CalendarSlot<T> {
  /** UTC calendar day, YYYY-MM-DD */
  day: string
  snapshot: T | undefined
}

/** UTC calendar day (YYYY-MM-DD) of an ISO 8601 timestamp. */
export function toUtcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

/** Shift a UTC calendar day by a number of days. */
export function shiftDay(day: string, deltaDays: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + deltaDays)
  return date.toISOString().slice(0, 10)
}

/**
 * §4.1 — Build a window of `size` consecutive UTC calendar days ending at
 * `endDay` (inclusive), most recent day first.
 *
 * Every day gets exactly one slot. A day with no observation carries
 * `snapshot: undefined` — a missing observation is represented explicitly
 * and is never filled from a neighbouring day. When several snapshots fall
 * on the same day, a contemporaneous observation is preferred over one
 * reconstructed from history (`method: 'history'`), then the most recent.
 */
export function buildCalendarWindow<T extends { observedAt: string; method?: string }>(
  snapshots: ReadonlyArray<T>,
  endDay: string,
  size = PERSISTENCE_WINDOW_SIZE,
): CalendarSlot<T>[] {
  const reconstructed = (s: T) => s.method === 'history'
  const byDay = new Map<string, T>()
  for (const snapshot of snapshots) {
    const day = toUtcDay(snapshot.observedAt)
    const existing = byDay.get(day)
    const preferred =
      !existing ||
      (reconstructed(existing) && !reconstructed(snapshot)) ||
      (reconstructed(existing) === reconstructed(snapshot) &&
        existing.observedAt < snapshot.observedAt)
    if (preferred) byDay.set(day, snapshot)
  }

  const slots: CalendarSlot<T>[] = []
  for (let i = 0; i < Math.max(0, Math.floor(size)); i++) {
    const day = shiftDay(endDay, -i)
    slots.push({ day, snapshot: byDay.get(day) })
  }
  return slots
}

/** Relation of one window slot: observed (with a derived relation, possibly undetermined) or not observed. */
export type SlotRelation =
  | { observed: true; relation: ClimateRelation | undefined }
  | { observed: false }

/** Derive slot relations for a calendar window against the declared climate. */
export function relateCalendarWindow<T extends { phase: string | null | undefined }>(
  slots: ReadonlyArray<CalendarSlot<T>>,
  climate: Climate,
): SlotRelation[] {
  return slots.map((slot) =>
    slot.snapshot
      ? { observed: true, relation: deriveSnapshotRelation(slot.snapshot.phase, climate) }
      : { observed: false },
  )
}

/**
 * §4.2/§4.3 — Assess persistence of climate relations across a window.
 *
 * Accepts either calendar slot relations (preferred — missing days are
 * explicit) or a plain list of relations, each of which is treated as an
 * observed snapshot. Entries are most-recent-first; only the first
 * PERSISTENCE_WINDOW_SIZE are evaluated — the contract defines persistence
 * as "in the last 14 daily snapshots."
 *
 * Persistence requires a full-size window (14 calendar days) AND at least
 * PERSISTENCE_THRESHOLD (9) observed days carrying the relation. Days
 * without an observation count toward neither relation: they lower the
 * evidence, they never assert alignment or divergence.
 */
export function assessPersistence(
  entries: ReadonlyArray<SlotRelation | ClimateRelation | undefined>,
): PersistenceAssessment {
  const window =
    entries.length > PERSISTENCE_WINDOW_SIZE
      ? entries.slice(0, PERSISTENCE_WINDOW_SIZE)
      : entries

  let alignedCount = 0
  let divergentCount = 0
  let orthogonalCount = 0
  let undeterminedCount = 0
  let missingDays = 0

  for (const entry of window) {
    const slot: SlotRelation =
      typeof entry === 'object' && entry !== null
        ? entry
        : { observed: true, relation: entry }

    if (!slot.observed) {
      missingDays++
      continue
    }
    switch (slot.relation) {
      case 'aligned':
        alignedCount++
        break
      case 'divergent':
        divergentCount++
        break
      case 'orthogonal':
        orthogonalCount++
        break
      default:
        undeterminedCount++
        break
    }
  }

  const windowDays = window.length
  const totalSnapshots = windowDays - missingDays
  const fullWindow = windowDays >= PERSISTENCE_WINDOW_SIZE

  let evidence: WindowEvidence
  if (!fullWindow || totalSnapshots < PERSISTENCE_THRESHOLD) {
    evidence = 'insufficient'
  } else if (missingDays === 0) {
    evidence = 'complete'
  } else {
    evidence = 'partial'
  }

  return {
    alignedCount,
    divergentCount,
    orthogonalCount,
    undeterminedCount,
    totalSnapshots,
    windowDays,
    missingDays,
    evidence,
    persistentlyAligned: fullWindow && alignedCount >= PERSISTENCE_THRESHOLD,
    persistentlyDivergent: fullWindow && divergentCount >= PERSISTENCE_THRESHOLD,
  }
}
