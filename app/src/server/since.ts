import { toUtcDay } from '@grove/core'
import { and, asc, eq, gt, or } from 'drizzle-orm'

import type { GroveDb, RunRow } from './db'
import {
  getBindingsForIdentity,
  getDb,
  getDeclarationHistoryForIdentity,
  getLatestCompleteFullRun,
  getRunRepositories,
  getSnapshotHistoryForIdentity,
  latestReference,
  scopeMatches,
} from './db'
import { climateDeclarations, climateProposals, collectionRuns } from './db/schema'
import { listIdentities } from './identities'
import type { PortfolioScope } from './scope'
import { OBSERVATION_GAP_DAYS } from './timeline'

/** How Grove knows a line of the comparison. */
export type SinceSource = 'observed' | 'declared' | 'reconstructed' | 'proposed'

type SnapshotRow = ReturnType<typeof getSnapshotHistoryForIdentity>[number]
type DeclarationRow = ReturnType<typeof getDeclarationHistoryForIdentity>[number]

export interface StructureAt {
  observedAt: string
  source: 'observed' | 'reconstructed'
  densityTier: string | null
  manifests: string[]
  ecosystemDependencyCount: number | null
}

export interface SinceReport {
  reference: {
    at: string
    /** `chosen`: supplied for this read, not kept; `saved`: a kept reference; `absence`: the last observation before the most recent long gap; `earliest`: the first observation */
    basis: 'chosen' | 'saved' | 'absence' | 'earliest'
    label: string | null
  }
  /** The latest instant anything in scope was observed or read; the comparison's far side */
  now: string
  repositories: {
    /** Identities whose first row is after the reference */
    newlyObserved: Array<{
      fullName: string
      githubId: number
      firstAt: string
      source: 'observed' | 'reconstructed'
      createdAt: string | null
      /** `created_at` is after the reference: created, not merely discovered */
      createdAfterReference: boolean
    }>
    /** Present at the reference but not present in the latest complete full live run after it */
    notPresent: Array<{
      fullName: string
      githubId: number
      lastAt: string
      /** The run's own word for it when it was attempted: `unavailable` with GitHub's answer kind */
      outcome: string | null
      answer: string | null
    }>
    nameChanges: Array<{
      githubId: number
      fromName: string
      toName: string
      observedAt: string
      /** `observed` when the new name was seen as it began; `reconstructed` when it was learned later from a redirect */
      source: 'observed' | 'reconstructed'
    }>
    declarationChanges: Array<{
      fullName: string
      githubId: number
      observedAt: string
      source: 'declared' | 'reconstructed'
      changes: Array<{ field: string; from: string | null; to: string | null }>
    }>
    /** Plain pairs, no deltas: what was recorded at the reference and what is recorded now */
    structure: Array<{
      fullName: string
      githubId: number
      atReference: StructureAt | null
      now: StructureAt | null
    }>
  }
  evidence: {
    /** A span without observation ending in the interval; `from` is its start clipped to the reference, `days` counted from `from` */
    gaps: Array<{
      fullName: string
      githubId: number
      lastObservedAt: string
      from: string
      observedAt: string
      days: number
    }>
    historyDays: Array<{ fullName: string; githubId: number; days: number }>
    /** No row of any kind in the interval */
    unobserved: Array<{ fullName: string; githubId: number }>
    /** Runs in the interval that did not cover the whole scope or did not complete */
    partialRuns: Array<{
      id: number
      startedAt: string
      method: string
      fullPortfolio: boolean
      complete: boolean
      answer: string | null
    }>
    /** The run absences are inferred from, when there is one after the reference */
    latestFullRun: { id: number; startedAt: string } | null
  }
  climate: {
    declarations: Array<{ climate: string; declaredAt: string }>
    proposals: Array<{
      id: number
      climate: string
      status: string
      proposedAt: string
      respondedAt: string | null
      lastSupportedAt: string | null
    }>
  }
}

export interface SinceInput {
  stewardId: number
  scope?: PortfolioScope
  /** A chosen instant; when absent the steward's latest saved reference, else the default */
  referenceAt?: string
  now?: () => Date
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const sourceOf = (method: string): 'observed' | 'reconstructed' =>
  method === 'history' ? 'reconstructed' : 'observed'

/** Among rows at or before `instant`, the latest; on the same day an observed row over a reconstructed one. */
function latestAtOrBefore<T extends { observedAt: string; method: string }>(
  rowsDesc: T[],
  instant: string,
): T | undefined {
  const candidates = rowsDesc.filter((r) => r.observedAt <= instant)
  const first = candidates[0]
  if (!first) return undefined
  const day = toUtcDay(first.observedAt)
  const observedSameDay = candidates.find(
    (r) => toUtcDay(r.observedAt) === day && r.method !== 'history',
  )
  return observedSameDay ?? first
}

const TRACKED_FIELDS = [
  'phase',
  'intent',
  'horizon',
  'role',
  'steward',
  'consolidationIntervalDays',
] as const

function fieldToString(
  value: string | number | boolean | null | undefined,
): string | null {
  return value == null ? null : String(value)
}

/** The declaration fields a row carries, whether a declaration row or a snapshot. */
type DeclarationLike = Pick<
  DeclarationRow,
  | 'classified'
  | 'intent'
  | 'horizon'
  | 'role'
  | 'phase'
  | 'steward'
  | 'consolidationIntervalDays'
>

function declarationDiff(prev: DeclarationLike, curr: DeclarationLike) {
  const changes: Array<{ field: string; from: string | null; to: string | null }> = []
  for (const field of TRACKED_FIELDS) {
    const from = fieldToString(prev[field])
    const to = fieldToString(curr[field])
    if (from !== to) changes.push({ field, from, to })
  }
  return changes
}

function structureOf(row: SnapshotRow | undefined): StructureAt | null {
  if (!row) return null
  let manifests: string[] = []
  try {
    manifests = row.dependencyManifestsObserved
      ? JSON.parse(row.dependencyManifestsObserved)
      : []
  } catch {
    manifests = []
  }
  return {
    observedAt: row.observedAt,
    source: sourceOf(row.method),
    densityTier: row.densityTier,
    manifests,
    ecosystemDependencyCount: row.ecosystemDependencyCount,
  }
}

/**
 * The default reference: the last observation before the most recent span
 * of `OBSERVATION_GAP_DAYS` or more without observation across the whole
 * scope — what Grove last saw before the absence, so the comparison spans
 * the absence and everything since — else the earliest observation.
 */
export function defaultReference(
  observedInstantsAsc: string[],
): { at: string; basis: 'absence' | 'earliest' } | undefined {
  if (observedInstantsAsc.length === 0) return undefined
  for (let i = observedInstantsAsc.length - 1; i >= 1; i--) {
    const gap =
      (new Date(observedInstantsAsc[i]).getTime() -
        new Date(observedInstantsAsc[i - 1]).getTime()) /
      MS_PER_DAY
    if (gap >= OBSERVATION_GAP_DAYS)
      return { at: observedInstantsAsc[i - 1], basis: 'absence' }
  }
  return { at: observedInstantsAsc[0], basis: 'earliest' }
}

/**
 * What changed since a reference instant — deterministic, each line saying
 * how Grove knows it. Opening the page saves nothing; a reference is kept
 * only by an explicit act. "At the reference" is, per identity, the latest
 * row at or before it (observed over reconstructed on the same day); a
 * later row is never selected. Absence is inferred only from a complete
 * full live run after the reference.
 */
/**
 * A reference is an instant that has been: nothing is recorded past now, so
 * a later one would read every row as before it. The same rule governs
 * reading from and keeping a reference.
 */
export function usableReference(referenceAt: string, nowIso: string): boolean {
  return !Number.isNaN(Date.parse(referenceAt)) && referenceAt <= nowIso
}

export function computeSince(
  db: GroveDb = getDb(),
  input: SinceInput,
): SinceReport | undefined {
  const identities = listIdentities(db, input.scope)
  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  if (input.referenceAt !== undefined && !usableReference(input.referenceAt, nowIso)) {
    throw new RangeError(
      `reference must be an instant not after ${nowIso}: ${input.referenceAt}`,
    )
  }

  const histories = identities.map((identity) => ({
    identity,
    snapshots: getSnapshotHistoryForIdentity(identity.githubId, {}, db),
    declarations: getDeclarationHistoryForIdentity(identity.githubId, 100_000, db),
    bindings: getBindingsForIdentity(identity.githubId, db),
  }))

  // Reference: chosen, else kept, else the default.
  let reference: SinceReport['reference']
  if (input.referenceAt) {
    reference = { at: input.referenceAt, basis: 'chosen', label: null }
  } else {
    const kept = latestReference(input.stewardId, db)
    if (kept) {
      reference = { at: kept.referenceAt, basis: 'saved', label: kept.label }
    } else {
      // Every contemporaneous observation counts — a declaration recorded
      // on a visit whose snapshot was throttled is one — as the timeline
      // reads it.
      const observed = histories
        .flatMap((h) => [
          ...h.snapshots.filter((s) => s.method !== 'history').map((s) => s.observedAt),
          ...h.declarations
            .filter((d) => d.method !== 'history')
            .map((d) => d.observedAt),
        ])
        .sort()
      const fallback = defaultReference(observed)
      if (!fallback) return undefined
      reference = { ...fallback, label: null }
    }
  }
  const ref = reference.at

  let farthest = ref
  const latestFullRun = getLatestCompleteFullRun(input.stewardId, db, input.scope)
  if (latestFullRun) {
    const readAt = latestFullRun.finishedAt ?? latestFullRun.startedAt
    if (readAt > farthest) farthest = readAt
  }
  const runAfterReference =
    latestFullRun && latestFullRun.startedAt > ref ? latestFullRun : undefined
  const runMembers = runAfterReference
    ? new Map(getRunRepositories(runAfterReference.id, db).map((r) => [r.githubId, r]))
    : undefined

  const newlyObserved: SinceReport['repositories']['newlyObserved'] = []
  const notPresent: SinceReport['repositories']['notPresent'] = []
  const nameChanges: SinceReport['repositories']['nameChanges'] = []
  const declarationChanges: SinceReport['repositories']['declarationChanges'] = []
  const structure: SinceReport['repositories']['structure'] = []
  const gaps: SinceReport['evidence']['gaps'] = []
  const historyDays: SinceReport['evidence']['historyDays'] = []
  const unobserved: SinceReport['evidence']['unobserved'] = []

  for (const { identity, snapshots, declarations, bindings } of histories) {
    const { fullName, githubId } = identity
    const allRows = [
      ...snapshots.map((s) => ({ observedAt: s.observedAt, method: s.method })),
      ...declarations.map((d) => ({ observedAt: d.observedAt, method: d.method })),
    ].sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    const first = allRows[0]
    const last = allRows[allRows.length - 1]
    if (last && last.observedAt > farthest) farthest = last.observedAt
    // A read that wrote no row (a collection that found nothing changed) is
    // still a read; the repository row keeps its instant.
    if (identity.lastObservedAt > farthest) farthest = identity.lastObservedAt

    if (!first) {
      // In scope, never a row of any kind: exactly what "unobserved" names.
      unobserved.push({ fullName, githubId })
      continue
    }

    if (first.observedAt > ref) {
      newlyObserved.push({
        fullName,
        githubId,
        firstAt: first.observedAt,
        source: sourceOf(first.method),
        createdAt: identity.createdAt,
        createdAfterReference: identity.createdAt !== null && identity.createdAt > ref,
      })
    }

    const presentAtReference = first.observedAt <= ref
    if (presentAtReference && runMembers) {
      const member = runMembers.get(githubId)
      if (!member || member.outcome === 'unavailable') {
        // Last seen: the latest contemporaneous row of either kind, or the
        // repository's own read instant when a read wrote no row.
        const lastRow =
          [...allRows]
            .reverse()
            .find((r) => r.method !== 'history' && r.observedAt <= nowIso)?.observedAt ??
          first.observedAt
        notPresent.push({
          fullName,
          githubId,
          lastAt: identity.lastObservedAt > lastRow ? identity.lastObservedAt : lastRow,
          outcome: member?.outcome ?? null,
          answer: member?.answer ?? null,
        })
      }
    }

    // Name changes between bindings that began after the reference.
    const ordered = [...bindings].sort((a, b) =>
      a.firstObservedAt.localeCompare(b.firstObservedAt),
    )
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]
      const curr = ordered[i]
      if (curr.fullName !== prev.fullName && curr.firstObservedAt > ref) {
        nameChanges.push({
          githubId,
          fromName: prev.fullName,
          toName: curr.fullName,
          observedAt: curr.firstObservedAt,
          source: curr.method === 'observed' ? 'observed' : 'reconstructed',
        })
      }
    }

    // Structure: plain pairs at the reference and now.
    const atReference = latestAtOrBefore(snapshots, ref)
    const nowRow = latestAtOrBefore(snapshots, nowIso)

    // Declaration changes after the reference, each against what preceded
    // it. The first one is compared with the declaration standing at the
    // reference — the last declaration row at or before it, else the
    // declaration the snapshot at the reference carried. With no baseline
    // there is no transition to report: a repository first observed after
    // the reference is listed as newly observed, not as having changed.
    const declarationsAsc = [...declarations].sort((a, b) =>
      a.observedAt.localeCompare(b.observedAt),
    )
    // The baseline is the declaration as of the reference, under the same
    // same-day precedence as everything else read as-of an instant.
    let baseline: DeclarationLike | undefined =
      latestAtOrBefore([...declarationsAsc].reverse(), ref) ??
      (atReference
        ? {
            classified: atReference.classified,
            intent: atReference.intent,
            horizon: atReference.horizon,
            role: atReference.role,
            phase: atReference.phase,
            steward: atReference.steward,
            consolidationIntervalDays: atReference.consolidationIntervalDays,
          }
        : undefined)
    for (const curr of declarationsAsc) {
      if (curr.observedAt <= ref) continue
      if (baseline) {
        const changes = declarationDiff(baseline, curr)
        if (changes.length > 0) {
          declarationChanges.push({
            fullName,
            githubId,
            observedAt: curr.observedAt,
            source: curr.method === 'history' ? 'reconstructed' : 'declared',
            changes,
          })
        }
      }
      baseline = curr
    }
    if (atReference || nowRow) {
      structure.push({
        fullName,
        githubId,
        atReference: structureOf(atReference),
        now: structureOf(nowRow),
      })
    }

    // Evidence: spans without observation that end inside the interval, from
    // observed rows only — snapshots and declaration changes alike, as the
    // timeline reads them.
    const observedAsc = [
      ...new Set([
        ...snapshots.filter((s) => s.method !== 'history').map((s) => s.observedAt),
        ...declarations.filter((d) => d.method !== 'history').map((d) => d.observedAt),
      ]),
    ].sort()
    for (let i = 1; i < observedAsc.length; i++) {
      if (observedAsc[i] <= ref) continue
      const spanDays = Math.floor(
        (new Date(observedAsc[i]).getTime() - new Date(observedAsc[i - 1]).getTime()) /
          MS_PER_DAY,
      )
      if (spanDays < OBSERVATION_GAP_DAYS) continue
      // The span is a gap by its whole length; only the part inside the
      // interval is counted, so a reference inside it does not report
      // days before the comparison began.
      const from = observedAsc[i - 1] > ref ? observedAsc[i - 1] : ref
      const days = Math.floor(
        (new Date(observedAsc[i]).getTime() - new Date(from).getTime()) / MS_PER_DAY,
      )
      gaps.push({
        fullName,
        githubId,
        lastObservedAt: observedAsc[i - 1],
        from,
        observedAt: observedAsc[i],
        days,
      })
    }
    const historyInInterval = new Set(
      snapshots
        .filter((s) => s.method === 'history' && s.observedAt > ref)
        .map((s) => toUtcDay(s.observedAt)),
    )
    if (historyInInterval.size > 0)
      historyDays.push({ fullName, githubId, days: historyInInterval.size })
    if (!allRows.some((r) => r.observedAt > ref)) unobserved.push({ fullName, githubId })
  }

  // Runs in the interval that could not speak for the whole scope: this
  // steward's (another steward's run describes another portfolio) and
  // backfills, which carry no steward — over this scope only.
  const partialRunRows = db
    .select()
    .from(collectionRuns)
    .where(
      and(
        gt(collectionRuns.startedAt, ref),
        or(
          eq(collectionRuns.stewardId, input.stewardId),
          eq(collectionRuns.method, 'backfill'),
        ),
        or(eq(collectionRuns.fullPortfolio, false), eq(collectionRuns.complete, false)),
      ),
    )
    .orderBy(asc(collectionRuns.startedAt))
    .all()
    .filter((r: RunRow) => scopeMatches(r.scope, input.scope))
  // A run that wrote no row is still a read; the far side reaches it.
  for (const r of partialRunRows) {
    const readAt = r.finishedAt ?? r.startedAt
    if (readAt > farthest) farthest = readAt
  }
  const partialRuns = partialRunRows.map((r: RunRow) => ({
    id: r.id,
    startedAt: r.startedAt,
    method: r.method,
    fullPortfolio: r.fullPortfolio,
    complete: r.complete,
    answer: r.answer,
  }))

  const declarationsInInterval = db
    .select()
    .from(climateDeclarations)
    .where(
      and(
        eq(climateDeclarations.declaredById, input.stewardId),
        gt(climateDeclarations.declaredAt, ref),
      ),
    )
    .orderBy(asc(climateDeclarations.declaredAt))
    .all()
    .map((d) => ({ climate: d.climate, declaredAt: d.declaredAt }))

  const proposalsInInterval = db
    .select()
    .from(climateProposals)
    .where(
      and(
        eq(climateProposals.stewardId, input.stewardId),
        or(
          gt(climateProposals.proposedAt, ref),
          gt(climateProposals.respondedAt, ref),
          gt(climateProposals.lastSupportedAt, ref),
        ),
      ),
    )
    .orderBy(asc(climateProposals.proposedAt))
    .all()
    .map((p) => ({
      id: p.id,
      climate: p.climate,
      status: p.status,
      proposedAt: p.proposedAt,
      respondedAt: p.respondedAt,
      lastSupportedAt: p.lastSupportedAt,
    }))

  return {
    reference,
    now: farthest,
    repositories: {
      newlyObserved,
      notPresent,
      nameChanges,
      declarationChanges,
      structure,
    },
    evidence: {
      gaps,
      historyDays,
      unobserved,
      partialRuns,
      latestFullRun: runAfterReference
        ? { id: runAfterReference.id, startedAt: runAfterReference.startedAt }
        : null,
    },
    climate: { declarations: declarationsInInterval, proposals: proposalsInInterval },
  }
}
