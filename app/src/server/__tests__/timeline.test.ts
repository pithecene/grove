import { describe, expect, it } from 'vitest'

import type { declarationChanges, ecologySnapshots } from '../db/schema'
import { buildTimeline, type TimelineEntry } from '../timeline'

type SnapshotRow = typeof ecologySnapshots.$inferSelect
type DeclarationRow = typeof declarationChanges.$inferSelect

// ── Helpers ──────────────────────────────────────────────────────

let idCounter = 0

function makeSnapshot(overrides: {
  observedAt: string
  densityTier?: string | null
  fullName?: string
}): SnapshotRow {
  return {
    id: ++idCounter,
    fullName: overrides.fullName ?? 'owner/repo',
    githubId: null,
    method: 'observed',
    recordedAt: null,
    collectionRunId: null,
    evidence: null,
    observedAt: overrides.observedAt,
    classified: true,
    intent: 'test',
    horizon: 'perennial',
    role: 'library',
    phase: 'consolidating',
    steward: 'alice',
    consolidationIntervalDays: 90,
    fileCount: 10,
    commitsLast30d: 5,
    commitsLast90d: 15,
    dependencyManifestsObserved: null,
    ecosystemDependencyCount: null,
    densityTier: overrides.densityTier !== undefined ? overrides.densityTier : 'thickening',
    densityDescription: 'test description',
  }
}

function makeDeclaration(overrides: {
  observedAt: string
  phase?: string | null
  intent?: string | null
  horizon?: string | null
  role?: string | null
  steward?: string | null
  consolidationIntervalDays?: number | null
  fullName?: string
  classified?: boolean
}): DeclarationRow {
  return {
    id: ++idCounter,
    fullName: overrides.fullName ?? 'owner/repo',
    githubId: null,
    method: 'observed',
    recordedAt: null,
    collectionRunId: null,
    evidence: null,
    observedAt: overrides.observedAt,
    classified: overrides.classified ?? true,
    intent: overrides.intent !== undefined ? overrides.intent : 'test',
    horizon: overrides.horizon !== undefined ? overrides.horizon : 'perennial',
    role: overrides.role !== undefined ? overrides.role : 'library',
    phase: overrides.phase !== undefined ? overrides.phase : 'consolidating',
    steward: overrides.steward !== undefined ? overrides.steward : 'alice',
    consolidationIntervalDays:
      overrides.consolidationIntervalDays !== undefined
        ? overrides.consolidationIntervalDays
        : 90,
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('buildTimeline', () => {
  it('returns empty array for empty inputs', () => {
    const result = buildTimeline([], [], false, true)
    expect(result).toEqual([])
  })

  describe('density transitions and spans', () => {
    it('emits "first observed" transition when history is complete', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      // DB returns DESC
      const result = buildTimeline(snapshots, [], false, true)

      const transitions = result.filter((e) => e.kind === 'density_transition')
      expect(transitions).toHaveLength(1)
      expect(transitions[0]).toMatchObject({
        kind: 'density_transition',
        fromTier: null,
        toTier: 'rooting',
      })
    })

    it('suppresses "first observed" when history is truncated', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      const result = buildTimeline(snapshots, [], false, false)

      const transitions = result.filter((e) => e.kind === 'density_transition')
      expect(transitions).toHaveLength(0)
    })

    it('still emits mid-window transitions when history is truncated', () => {
      // DESC order: most recent first
      const snapshots = [
        makeSnapshot({ observedAt: '2026-03-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-02-01T00:00:00Z', densityTier: 'rooting' }),
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      const result = buildTimeline(snapshots, [], false, false)

      const transitions = result.filter(
        (e) => e.kind === 'density_transition',
      ) as Extract<TimelineEntry, { kind: 'density_transition' }>[]
      expect(transitions).toHaveLength(1)
      expect(transitions[0]).toMatchObject({
        fromTier: 'rooting',
        toTier: 'thickening',
      })
    })

    it('compresses consecutive identical tiers into a span', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-03-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-02-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'thickening' }),
      ]
      const result = buildTimeline(snapshots, [], false, true)

      const spans = result.filter(
        (e) => e.kind === 'density_span',
      ) as Extract<TimelineEntry, { kind: 'density_span' }>[]
      expect(spans).toHaveLength(1)
      expect(spans[0]).toMatchObject({
        tier: 'thickening',
        observedAt: '2026-01-01T00:00:00Z',
        spanEnd: '2026-03-01T00:00:00Z',
        observationCount: 3,
      })
    })

    it('does not emit span for a single observation run', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      const result = buildTimeline(snapshots, [], false, true)

      const spans = result.filter((e) => e.kind === 'density_span')
      expect(spans).toHaveLength(0)
    })

    it('skips snapshots with null density tier', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-02-01T00:00:00Z', densityTier: null }),
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      const result = buildTimeline(snapshots, [], false, true)

      const transitions = result.filter((e) => e.kind === 'density_transition')
      expect(transitions).toHaveLength(1)
    })
  })

  describe('freshlyRecorded flag', () => {
    it('marks the most recent density transition', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-02-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      const result = buildTimeline(snapshots, [], true, true)

      const transition = result.find(
        (e) => e.kind === 'density_transition' && e.toTier === 'thickening',
      ) as Extract<TimelineEntry, { kind: 'density_transition' }>
      expect(transition.freshlyRecorded).toBe(true)
    })

    it('marks a trailing span when tier is unchanged', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-03-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-02-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'thickening' }),
      ]
      const result = buildTimeline(snapshots, [], true, true)

      const spans = result.filter(
        (e) => e.kind === 'density_span',
      ) as Extract<TimelineEntry, { kind: 'density_span' }>[]
      expect(spans).toHaveLength(1)
      expect(spans[0].freshlyRecorded).toBe(true)
    })

    it('does not mark anything when freshSnapshotRecorded is false', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-02-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      const result = buildTimeline(snapshots, [], false, true)

      const withFresh = result.filter(
        (e) => (e.kind === 'density_transition' || e.kind === 'density_span') && e.freshlyRecorded,
      )
      expect(withFresh).toHaveLength(0)
    })
  })

  describe('declaration changes', () => {
    it('diffs consecutive declarations and emits changes', () => {
      // DESC order
      const declarations = [
        makeDeclaration({ observedAt: '2026-02-01T00:00:00Z', phase: 'pruning' }),
        makeDeclaration({ observedAt: '2026-01-01T00:00:00Z', phase: 'consolidating' }),
      ]
      const result = buildTimeline([], declarations, false, true)

      const changes = result.filter(
        (e) => e.kind === 'declaration_change',
      ) as Extract<TimelineEntry, { kind: 'declaration_change' }>[]
      expect(changes).toHaveLength(1)
      expect(changes[0].changes).toEqual([
        { field: 'phase', from: 'consolidating', to: 'pruning' },
      ])
    })

    it('records null values when fields become undeclared', () => {
      const declarations = [
        makeDeclaration({ observedAt: '2026-02-01T00:00:00Z', steward: null }),
        makeDeclaration({ observedAt: '2026-01-01T00:00:00Z', steward: 'alice' }),
      ]
      const result = buildTimeline([], declarations, false, true)

      const changes = result.filter(
        (e) => e.kind === 'declaration_change',
      ) as Extract<TimelineEntry, { kind: 'declaration_change' }>[]
      expect(changes).toHaveLength(1)
      expect(changes[0].changes).toEqual([
        { field: 'steward', from: 'alice', to: null },
      ])
    })

    it('emits multiple field changes in a single entry', () => {
      const declarations = [
        makeDeclaration({
          observedAt: '2026-02-01T00:00:00Z',
          phase: 'pruning',
          steward: 'bob',
        }),
        makeDeclaration({
          observedAt: '2026-01-01T00:00:00Z',
          phase: 'consolidating',
          steward: 'alice',
        }),
      ]
      const result = buildTimeline([], declarations, false, true)

      const changes = result.filter(
        (e) => e.kind === 'declaration_change',
      ) as Extract<TimelineEntry, { kind: 'declaration_change' }>[]
      expect(changes).toHaveLength(1)
      expect(changes[0].changes).toHaveLength(2)
    })

    it('does not emit entry when declarations are identical', () => {
      const declarations = [
        makeDeclaration({ observedAt: '2026-02-01T00:00:00Z' }),
        makeDeclaration({ observedAt: '2026-01-01T00:00:00Z' }),
      ]
      const result = buildTimeline([], declarations, false, true)

      const changes = result.filter((e) => e.kind === 'declaration_change')
      expect(changes).toHaveLength(0)
    })
  })

  describe('merge ordering', () => {
    it('interleaves density and declaration entries chronologically DESC', () => {
      const snapshots = [
        makeSnapshot({ observedAt: '2026-03-01T00:00:00Z', densityTier: 'thickening' }),
        makeSnapshot({ observedAt: '2026-01-01T00:00:00Z', densityTier: 'rooting' }),
      ]
      const declarations = [
        makeDeclaration({ observedAt: '2026-02-15T00:00:00Z', phase: 'pruning' }),
        makeDeclaration({ observedAt: '2026-01-15T00:00:00Z', phase: 'consolidating' }),
      ]
      const result = buildTimeline(snapshots, declarations, false, true)

      // Verify DESC ordering
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].observedAt >= result[i].observedAt).toBe(true)
      }
    })
  })
})
