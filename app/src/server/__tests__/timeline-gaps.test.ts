import { describe, expect, it } from 'vitest'

import type { BindingRow } from '../db/bindings'
import type { declarationChanges, ecologySnapshots } from '../db/schema'
import { buildGapEntries, buildTimeline, OBSERVATION_GAP_DAYS } from '../timeline'

type SnapshotRow = typeof ecologySnapshots.$inferSelect
type DeclarationRow = typeof declarationChanges.$inferSelect

let id = 0
function snapshot(observedAt: string, fullName = 'org/thing'): SnapshotRow {
  return {
    id: ++id,
    fullName,
    observedAt,
    classified: true,
    intent: 'synthetic',
    horizon: 'perennial',
    role: 'library',
    phase: 'consolidating',
    steward: null,
    consolidationIntervalDays: null,
    fileCount: null,
    commitsLast30d: null,
    commitsLast90d: null,
    dependencyManifestsObserved: null,
    ecosystemDependencyCount: null,
    densityTier: 'rooting',
    densityDescription: null,
  }
}

function declaration(observedAt: string, fullName = 'org/thing'): DeclarationRow {
  return {
    id: ++id,
    fullName,
    observedAt,
    classified: true,
    intent: 'synthetic',
    horizon: 'perennial',
    role: 'library',
    phase: 'consolidating',
    steward: null,
    consolidationIntervalDays: null,
  }
}

function binding(fullName: string, first: string, last: string): BindingRow {
  return {
    id: ++id,
    githubId: 100,
    fullName,
    firstObservedAt: first,
    lastObservedAt: last,
    method: 'observed',
    resolvedAt: first,
    evidence: null,
  }
}

describe('buildGapEntries', () => {
  it('emits nothing for closely spaced observations', () => {
    const rows = [
      snapshot('2025-01-03T12:00:00.000Z'),
      snapshot('2025-01-01T12:00:00.000Z'),
    ]
    expect(buildGapEntries(rows)).toEqual([])
  })

  it('emits one entry per span of OBSERVATION_GAP_DAYS or more', () => {
    const rows = [
      snapshot('2025-06-01T12:00:00.000Z'),
      snapshot('2025-01-01T12:00:00.000Z'),
      snapshot('2024-12-31T12:00:00.000Z'),
    ]
    const gaps = buildGapEntries(rows)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      kind: 'observation_gap',
      observedAt: '2025-06-01T12:00:00.000Z',
      lastObservedAt: '2025-01-01T12:00:00.000Z',
      days: 151,
    })
    expect(151).toBeGreaterThanOrEqual(OBSERVATION_GAP_DAYS)
  })

  it('a recorded declaration change bounds a span like any observation', () => {
    const rows = [
      snapshot('2025-01-20T12:00:00.000Z'),
      snapshot('2025-01-01T12:00:00.000Z'),
    ]
    // 19 days between snapshots, but the repository was observed on the 10th
    // (a declaration change recorded inside the snapshot throttle interval).
    const declarations = [declaration('2025-01-10T13:00:00.000Z')]
    expect(buildGapEntries(rows)).toHaveLength(1)
    expect(buildGapEntries(rows, declarations)).toEqual([])
  })

  it('does not read a gap across the edge of a truncated series', () => {
    // Snapshots are truncated (oldest retained: Jun 1) while the complete
    // declaration history still holds a Jan 1 row. The snapshots between
    // were not fetched, so the interval is unknown, not a span without observation.
    const rows = [
      snapshot('2025-06-02T12:00:00.000Z'),
      snapshot('2025-06-01T12:00:00.000Z'),
    ]
    const declarations = [declaration('2025-01-01T12:00:00.000Z')]
    expect(buildGapEntries(rows, declarations)).toHaveLength(1)
    expect(buildGapEntries(rows, declarations, { snapshotsComplete: false })).toEqual([])
    expect(
      buildTimeline(rows, declarations, false, false).some((e) => e.kind === 'observation_gap'),
    ).toBe(false)
    // The converse: a truncated declaration history hides nothing newer than its edge.
    const older = [snapshot('2025-06-02T12:00:00.000Z'), snapshot('2025-01-01T12:00:00.000Z')]
    const recent = [declaration('2025-06-01T12:00:00.000Z')]
    expect(buildGapEntries(older, recent, { declarationsComplete: false })).toEqual([])
    expect(buildTimeline(older, recent, false, true, undefined, false)).not.toContainEqual(
      expect.objectContaining({ kind: 'observation_gap' }),
    )
  })

  it('a declaration observation moves the start of a longer span', () => {
    const rows = [
      snapshot('2025-06-01T12:00:00.000Z'),
      snapshot('2025-01-01T12:00:00.000Z'),
    ]
    const declarations = [declaration('2025-01-01T12:30:00.000Z')]
    const gaps = buildGapEntries(rows, declarations)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({
      lastObservedAt: '2025-01-01T12:30:00.000Z',
      observedAt: '2025-06-01T12:00:00.000Z',
      days: 150,
    })
  })
})

describe('buildTimeline with gaps and name changes', () => {
  it('places the gap between the resumption and the earlier observations', () => {
    const rows = [
      snapshot('2025-06-01T12:00:00.000Z'),
      snapshot('2025-01-01T12:00:00.000Z'),
    ]
    const timeline = buildTimeline(rows, [], false, true)
    const kinds = timeline.map((e) => e.kind)
    const gapIndex = kinds.indexOf('observation_gap')
    expect(gapIndex).toBeGreaterThan(-1)
    // everything above the gap was observed at the resumption or later
    for (const e of timeline.slice(0, gapIndex)) {
      expect(e.observedAt >= '2025-06-01T12:00:00.000Z').toBe(true)
    }
    // everything below it is older
    for (const e of timeline.slice(gapIndex + 1)) {
      expect(e.observedAt < '2025-06-01T12:00:00.000Z').toBe(true)
    }
  })

  it('emits a name change between bindings without claiming a rename date', () => {
    const rows = [
      snapshot('2025-06-01T12:00:00.000Z', 'org/thing'),
      snapshot('2025-01-01T12:00:00.000Z', 'org-old/thing'),
    ]
    const timeline = buildTimeline(rows, [], false, true, {
      bindings: [
        binding('org/thing', '2025-06-01T12:00:00.000Z', '2025-06-01T12:00:00.000Z'),
        binding('org-old/thing', '2025-01-01T12:00:00.000Z', '2025-01-01T12:00:00.000Z'),
      ],
    })
    const change = timeline.find((e) => e.kind === 'name_change')
    expect(change).toMatchObject({
      fromName: 'org-old/thing',
      toName: 'org/thing',
      observedAt: '2025-06-01T12:00:00.000Z',
      lastSeenUnderPrevious: '2025-01-01T12:00:00.000Z',
    })
  })

  it('does not emit a name change for a single binding', () => {
    const rows = [snapshot('2025-06-01T12:00:00.000Z')]
    const timeline = buildTimeline(rows, [], false, true, {
      bindings: [
        binding('org/thing', '2025-06-01T12:00:00.000Z', '2025-06-01T12:00:00.000Z'),
      ],
    })
    expect(timeline.some((e) => e.kind === 'name_change')).toBe(false)
  })
})
