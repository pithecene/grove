import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  finishRun,
  latestReference,
  listReferences,
  recordObservedBinding,
  recordRunRepository,
  saveReference,
  startRun,
} from '../db'
import { createDb, type GroveDb } from '../db/client'
import {
  climateDeclarations,
  climateProposals,
  declarationChanges,
  ecologySnapshots,
  repositories,
  repositoryBindings,
} from '../db/schema'
import { computeSince, defaultReference, usableReference } from '../since'

let db: GroveDb
const STEWARD = 7
const NOW = () => new Date('2025-10-19T12:00:00.000Z')

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

function repo(
  fullName: string,
  githubId: number,
  createdAt: string | null = '2024-01-01T00:00:00.000Z',
  lastObservedAt = '2024-01-01T00:00:00.000Z',
) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt,
      githubId,
      createdAt,
    })
    .run()
}

function snap(
  fullName: string,
  githubId: number,
  observedAt: string,
  extra: Partial<typeof ecologySnapshots.$inferInsert> = {},
) {
  db.insert(ecologySnapshots)
    .values({
      fullName,
      githubId,
      observedAt,
      classified: true,
      phase: 'consolidating',
      ...extra,
    })
    .run()
}

function decl(
  fullName: string,
  githubId: number,
  observedAt: string,
  phase: string,
  method = 'observed',
) {
  db.insert(declarationChanges)
    .values({
      fullName,
      githubId,
      observedAt,
      classified: true,
      intent: 'synthetic',
      phase,
      method,
    })
    .run()
}

describe('defaultReference', () => {
  it('is the last observation before the most recent long gap, else the earliest observation', () => {
    expect(
      defaultReference([
        '2025-01-01T12:00:00.000Z',
        '2025-01-02T12:00:00.000Z',
        '2025-05-01T12:00:00.000Z',
        '2025-10-18T12:00:00.000Z',
        '2025-10-19T12:00:00.000Z',
      ]),
    ).toEqual({ at: '2025-05-01T12:00:00.000Z', basis: 'absence' })
    expect(
      defaultReference(['2025-01-01T12:00:00.000Z', '2025-01-05T12:00:00.000Z']),
    ).toEqual({
      at: '2025-01-01T12:00:00.000Z',
      basis: 'earliest',
    })
    expect(defaultReference([])).toBeUndefined()
  })
})

describe('computeSince', () => {
  it('states newly observed vs created, name changes, declaration changes with their sources, and structure pairs', () => {
    // Observed under a former name until May, under the current one since October.
    repo('orchard/alpha', 100, '2024-01-01T00:00:00.000Z', '2025-10-18T12:00:00.000Z')
    db.insert(repositories)
      .values({
        fullName: 'orchard-old/alpha',
        htmlUrl: 'https://github.com/orchard-old/alpha',
        defaultBranch: 'main',
        lastObservedAt: '2025-05-01T12:00:00.000Z',
      })
      .run()
    snap('orchard-old/alpha', 100, '2025-01-01T12:00:00.000Z', { densityTier: 'rooting' })
    snap('orchard-old/alpha', 100, '2025-05-01T12:00:00.000Z', { densityTier: 'rooting' })
    decl('orchard-old/alpha', 100, '2025-01-01T12:00:00.000Z', 'expanding')
    recordObservedBinding(100, 'orchard-old/alpha', '2025-01-01T12:00:00.000Z', db)
    recordObservedBinding(100, 'orchard-old/alpha', '2025-05-01T12:00:00.000Z', db)
    recordObservedBinding(100, 'orchard/alpha', '2025-10-18T12:00:00.000Z', db)
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z', {
      densityTier: 'thickening',
      ecosystemDependencyCount: 2,
    })
    // Read from history later, under the name the identity holds now; found by its id.
    decl('orchard/alpha', 100, '2025-10-07T13:00:00.000Z', 'emerging', 'history')
    // Discovered after the reference but created long before; and one created after.
    repo('orchard/beta', 200, '2024-06-01T00:00:00.000Z')
    snap('orchard/beta', 200, '2025-10-18T13:00:00.000Z')
    repo('orchard/gamma', 300, '2025-10-18T20:00:00.000Z')
    snap('orchard/gamma', 300, '2025-10-18T13:00:00.000Z')

    const report = computeSince(db, { stewardId: STEWARD, now: NOW })
    // The default spans the absence: what Grove last saw before it.
    expect(report?.reference).toEqual({
      at: '2025-05-01T12:00:00.000Z',
      basis: 'absence',
      label: null,
    })
    expect(
      report?.repositories.newlyObserved.map((n) => [
        n.fullName,
        n.createdAfterReference,
      ]),
    ).toEqual([
      ['orchard/beta', false],
      ['orchard/gamma', true],
    ])
    expect(report?.repositories.nameChanges).toEqual([
      {
        githubId: 100,
        fromName: 'orchard-old/alpha',
        toName: 'orchard/alpha',
        observedAt: '2025-10-18T12:00:00.000Z',
        source: 'observed',
      },
    ])
    expect(report?.repositories.declarationChanges).toEqual([
      {
        fullName: 'orchard/alpha',
        githubId: 100,
        observedAt: '2025-10-07T13:00:00.000Z',
        source: 'reconstructed',
        changes: [{ field: 'phase', from: 'expanding', to: 'emerging' }],
      },
    ])
    const alpha = report?.repositories.structure.find((s) => s.githubId === 100)
    expect(alpha?.atReference).toMatchObject({
      observedAt: '2025-05-01T12:00:00.000Z',
      densityTier: 'rooting',
      source: 'observed',
    })
    expect(alpha?.now).toMatchObject({
      densityTier: 'thickening',
      ecosystemDependencyCount: 2,
    })
    expect(report?.now).toBe('2025-10-18T13:00:00.000Z')
  })

  it('a chosen reference selects the latest row at or before it — never a later one', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-01-01T12:00:00.000Z', { densityTier: 'rooting' })
    snap('orchard/alpha', 100, '2025-03-01T23:59:59.999Z', {
      densityTier: 'thickening',
      method: 'history',
    })
    snap('orchard/alpha', 100, '2025-03-01T09:00:00.000Z', { densityTier: 'rooting' })
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z', { densityTier: 'canopy' })
    decl('orchard/alpha', 100, '2025-01-01T12:00:00.000Z', 'expanding')
    decl('orchard/alpha', 100, '2025-06-01T12:00:00.000Z', 'consolidating', 'history')
    decl('orchard/alpha', 100, '2025-10-18T12:00:00.000Z', 'resting')

    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-03-02T00:00:00.000Z',
      now: NOW,
    })
    const alpha = report?.repositories.structure[0]
    // Same day: the observed row wins over the reconstructed one.
    expect(alpha?.atReference).toMatchObject({
      observedAt: '2025-03-01T09:00:00.000Z',
      source: 'observed',
      densityTier: 'rooting',
    })
    expect(alpha?.now).toMatchObject({ densityTier: 'canopy' })
    expect(
      report?.repositories.declarationChanges.map((d) => [
        d.observedAt.slice(0, 10),
        d.source,
        d.changes[0],
      ]),
    ).toEqual([
      [
        '2025-06-01',
        'reconstructed',
        { field: 'phase', from: 'expanding', to: 'consolidating' },
      ],
      [
        '2025-10-18',
        'declared',
        { field: 'phase', from: 'consolidating', to: 'resting' },
      ],
    ])
    // The reference itself was chosen, not saved.
    expect(listReferences(STEWARD, db)).toHaveLength(0)
  })

  it('infers absence only from a complete full live run after the reference', () => {
    repo('orchard/alpha', 100)
    repo('orchard/gone', 200)
    snap('orchard/alpha', 100, '2025-01-01T12:00:00.000Z')
    snap('orchard/gone', 200, '2025-01-01T12:00:00.000Z')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    const ref = '2025-06-01T00:00:00.000Z'

    // No run after the reference: nothing is inferred.
    expect(
      computeSince(db, { stewardId: STEWARD, referenceAt: ref, now: NOW })?.repositories
        .notPresent,
    ).toEqual([])

    // A targeted run says nothing about the rest either.
    const targeted = startRun(
      {
        method: 'visit',
        stewardId: STEWARD,
        fullPortfolio: false,
        startedAt: '2025-10-18T12:00:00.000Z',
      },
      db,
    )
    recordRunRepository(
      targeted,
      { githubId: 100, fullName: 'orchard/alpha', outcome: 'observed' },
      db,
    )
    finishRun(targeted, { complete: true }, db)
    expect(
      computeSince(db, { stewardId: STEWARD, referenceAt: ref, now: NOW })?.repositories
        .notPresent,
    ).toEqual([])

    // A complete full live run that did not include `gone` does.
    const full = startRun(
      {
        method: 'cli',
        stewardId: STEWARD,
        fullPortfolio: true,
        startedAt: '2025-10-19T09:00:00.000Z',
      },
      db,
    )
    recordRunRepository(
      full,
      { githubId: 100, fullName: 'orchard/alpha', outcome: 'unchanged' },
      db,
    )
    finishRun(full, { complete: true }, db)
    const report = computeSince(db, { stewardId: STEWARD, referenceAt: ref, now: NOW })
    expect(report?.repositories.notPresent).toEqual([
      {
        fullName: 'orchard/gone',
        githubId: 200,
        lastAt: '2025-01-01T12:00:00.000Z',
        outcome: null,
        answer: null,
      },
    ])
    expect(report?.evidence.latestFullRun).toEqual({
      id: full,
      startedAt: '2025-10-19T09:00:00.000Z',
    })
    expect(report?.evidence.partialRuns.map((r) => r.id)).toEqual([targeted])
  })

  it('evidence: gaps from observed rows only, days read from history, repositories without any row', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-05-01T12:00:00.000Z')
    for (let d = 2; d <= 20; d++) {
      snap('orchard/alpha', 100, `2025-05-${String(d).padStart(2, '0')}T23:59:59.999Z`, {
        method: 'history',
      })
    }
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    repo('orchard/quiet', 200)
    snap('orchard/quiet', 200, '2025-01-01T12:00:00.000Z')

    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-04-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.reference.basis).toBe('chosen')
    expect(report?.evidence.gaps).toEqual([
      {
        fullName: 'orchard/alpha',
        githubId: 100,
        lastObservedAt: '2025-05-01T12:00:00.000Z',
        from: '2025-05-01T12:00:00.000Z',
        observedAt: '2025-10-18T12:00:00.000Z',
        days: 170,
      },
    ])
    expect(report?.evidence.historyDays).toEqual([
      { fullName: 'orchard/alpha', githubId: 100, days: 19 },
    ])
    expect(report?.evidence.unobserved).toEqual([
      { fullName: 'orchard/quiet', githubId: 200 },
    ])
  })

  it('a declaration change is reported only against a baseline; the first one after the reference compares with the declaration standing then', () => {
    // alpha: no declaration row at the reference, but the snapshot there carries the declaration.
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-05-01T12:00:00.000Z', {
      phase: 'expanding',
      intent: 'synthetic',
    })
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z', {
      phase: 'consolidating',
      intent: 'synthetic',
    })
    decl('orchard/alpha', 100, '2025-10-18T12:00:00.000Z', 'consolidating')
    // beta: first observed after the reference — newly observed, not "changed from nothing".
    repo('orchard/beta', 200)
    snap('orchard/beta', 200, '2025-10-18T12:00:00.000Z')
    decl('orchard/beta', 200, '2025-10-18T12:00:00.000Z', 'emerging')
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-06-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.repositories.declarationChanges).toEqual([
      {
        fullName: 'orchard/alpha',
        githubId: 100,
        observedAt: '2025-10-18T12:00:00.000Z',
        source: 'declared',
        changes: [{ field: 'phase', from: 'expanding', to: 'consolidating' }],
      },
    ])
    expect(report?.repositories.newlyObserved.map((n) => n.fullName)).toEqual([
      'orchard/beta',
    ])
  })

  it('absence and partial-run evidence come only from this steward’s runs over this scope', () => {
    process.env.GROVE_SCOPE_OWNERS = 'orchard'
    const scope = { owners: new Set(['orchard']), exclude: new Set<string>() }
    repo('orchard/alpha', 100)
    repo('orchard/gone', 200)
    snap('orchard/alpha', 100, '2025-01-01T12:00:00.000Z')
    snap('orchard/gone', 200, '2025-01-01T12:00:00.000Z')
    const ref = '2025-06-01T00:00:00.000Z'
    // A complete full run over a different scope, and one by another steward: neither speaks for this scope.
    const other = startRun(
      {
        method: 'cli',
        stewardId: STEWARD,
        fullPortfolio: true,
        scope: { owners: new Set(['elsewhere']), exclude: new Set() },
        startedAt: '2025-10-19T08:00:00.000Z',
      },
      db,
    )
    finishRun(other, { complete: true }, db)
    const theirs = startRun(
      {
        method: 'cli',
        stewardId: 99,
        fullPortfolio: true,
        scope,
        startedAt: '2025-10-19T08:30:00.000Z',
      },
      db,
    )
    finishRun(theirs, { complete: false, answer: 'throttled' }, db)
    let report = computeSince(db, {
      stewardId: STEWARD,
      scope,
      referenceAt: ref,
      now: NOW,
    })
    expect(report?.repositories.notPresent).toEqual([])
    expect(report?.evidence.latestFullRun).toBeNull()
    expect(report?.evidence.partialRuns).toEqual([])

    // This steward, this scope.
    const mine = startRun(
      {
        method: 'cli',
        stewardId: STEWARD,
        fullPortfolio: true,
        scope,
        startedAt: '2025-10-19T09:00:00.000Z',
      },
      db,
    )
    recordRunRepository(
      mine,
      { githubId: 100, fullName: 'orchard/alpha', outcome: 'unchanged' },
      db,
    )
    finishRun(mine, { complete: true }, db)
    const backfill = startRun(
      {
        method: 'backfill',
        fullPortfolio: false,
        scope,
        startedAt: '2025-10-19T09:30:00.000Z',
      },
      db,
    )
    finishRun(backfill, { complete: true }, db)
    report = computeSince(db, { stewardId: STEWARD, scope, referenceAt: ref, now: NOW })
    expect(report?.repositories.notPresent.map((n) => n.fullName)).toEqual([
      'orchard/gone',
    ])
    expect(report?.evidence.partialRuns.map((r) => r.id)).toEqual([backfill])
    delete process.env.GROVE_SCOPE_OWNERS
  })

  it('a usable reference is a well-formed instant not after now', () => {
    const now = '2025-10-19T12:00:00.000Z'
    expect(usableReference('2025-10-19T12:00:00.000Z', now)).toBe(true)
    expect(usableReference('2025-10-19T12:00:00.001Z', now)).toBe(false)
    expect(usableReference('yesterday', now)).toBe(false)
  })

  it('a partial run after the latest row is a read the comparison reaches', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    const targeted = startRun(
      {
        method: 'visit',
        stewardId: STEWARD,
        fullPortfolio: false,
        startedAt: '2025-10-19T08:00:00.000Z',
      },
      db,
    )
    finishRun(targeted, { complete: true, finishedAt: '2025-10-19T08:00:03.000Z' }, db)
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-10-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.evidence.partialRuns.map((r) => r.id)).toEqual([targeted])
    expect(report?.now).toBe('2025-10-19T08:00:03.000Z')
  })

  it('a repository not present was last seen at its latest contemporaneous row, or its own read instant', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-05-01T12:00:00.000Z')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    repo('orchard/gone', 200)
    snap('orchard/gone', 200, '2025-01-01T12:00:00.000Z')
    // A visit whose snapshot was throttled still recorded the declaration.
    decl('orchard/gone', 200, '2025-03-01T12:00:00.000Z', 'expanding')
    const full = startRun(
      {
        method: 'cli',
        stewardId: STEWARD,
        fullPortfolio: true,
        startedAt: '2025-10-19T09:00:00.000Z',
      },
      db,
    )
    recordRunRepository(
      full,
      { githubId: 100, fullName: 'orchard/alpha', outcome: 'unchanged' },
      db,
    )
    finishRun(full, { complete: true }, db)
    const ref = '2025-06-01T00:00:00.000Z'
    expect(
      computeSince(db, {
        stewardId: STEWARD,
        referenceAt: ref,
        now: NOW,
      })?.repositories.notPresent.map((n) => n.lastAt),
    ).toEqual(['2025-03-01T12:00:00.000Z'])
    // A later read that wrote no row.
    db.update(repositories)
      .set({ lastObservedAt: '2025-04-01T12:00:00.000Z' })
      .where(eq(repositories.fullName, 'orchard/gone'))
      .run()
    expect(
      computeSince(db, {
        stewardId: STEWARD,
        referenceAt: ref,
        now: NOW,
      })?.repositories.notPresent.map((n) => n.lastAt),
    ).toEqual(['2025-04-01T12:00:00.000Z'])
  })

  it('a reference after now, or malformed, is refused', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    expect(() =>
      computeSince(db, {
        stewardId: STEWARD,
        referenceAt: '2025-10-20T00:00:00.000Z',
        now: NOW,
      }),
    ).toThrow(RangeError)
    expect(() =>
      computeSince(db, { stewardId: STEWARD, referenceAt: 'yesterday', now: NOW }),
    ).toThrow(RangeError)
  })

  it('the comparison ends at the latest read, not only the latest row', () => {
    // A collection that found nothing changed wrote no row but read the repository.
    repo('orchard/alpha', 100, '2024-01-01T00:00:00.000Z', '2025-10-19T09:00:00.000Z')
    snap('orchard/alpha', 100, '2025-05-01T12:00:00.000Z')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-04-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.now).toBe('2025-10-19T09:00:00.000Z')
    // A complete full run after that is a read as well.
    const run = startRun(
      {
        method: 'cli',
        stewardId: STEWARD,
        fullPortfolio: true,
        startedAt: '2025-10-19T10:00:00.000Z',
      },
      db,
    )
    recordRunRepository(
      run,
      { githubId: 100, fullName: 'orchard/alpha', outcome: 'unchanged' },
      db,
    )
    finishRun(run, { complete: true, finishedAt: '2025-10-19T10:00:05.000Z' }, db)
    const later = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-04-01T00:00:00.000Z',
      now: NOW,
    })
    expect(later?.now).toBe('2025-10-19T10:00:05.000Z')
  })

  it('a rename learned later from a redirect is not presented as observed', () => {
    repo('orchard/alpha', 100, '2024-01-01T00:00:00.000Z', '2025-10-18T12:00:00.000Z')
    repo('orchard-old/alpha', 100, '2024-01-01T00:00:00.000Z', '2025-05-01T12:00:00.000Z')
    snap('orchard-old/alpha', 100, '2025-05-01T12:00:00.000Z')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    recordObservedBinding(100, 'orchard-old/alpha', '2025-05-01T12:00:00.000Z', db)
    db.insert(repositoryBindings)
      .values({
        githubId: 100,
        fullName: 'orchard/alpha',
        firstObservedAt: '2025-10-18T12:00:00.000Z',
        lastObservedAt: '2025-10-18T12:00:00.000Z',
        method: 'github_redirect',
        resolvedAt: '2025-10-19T00:00:00.000Z',
      })
      .run()
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-06-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.repositories.nameChanges.map((c) => [c.toName, c.source])).toEqual([
      ['orchard/alpha', 'reconstructed'],
    ])
  })

  it('an observed declaration is an observation for the default reference', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-01-01T12:00:00.000Z')
    snap('orchard/alpha', 100, '2025-05-01T12:00:00.000Z')
    // A visit whose snapshot was throttled still recorded the declaration.
    decl('orchard/alpha', 100, '2025-09-01T12:00:00.000Z', 'expanding')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    const report = computeSince(db, { stewardId: STEWARD, now: NOW })
    expect(report?.reference).toEqual({
      at: '2025-09-01T12:00:00.000Z',
      basis: 'absence',
      label: null,
    })
  })

  it('a reference inside a gap counts only the days after it; the gap keeps its whole length as the threshold', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-05-01T12:00:00.000Z')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-07-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.evidence.gaps).toEqual([
      {
        fullName: 'orchard/alpha',
        githubId: 100,
        lastObservedAt: '2025-05-01T12:00:00.000Z',
        from: '2025-07-01T00:00:00.000Z',
        observedAt: '2025-10-18T12:00:00.000Z',
        days: 109,
      },
    ])
    // Ten days inside a 170-day gap: still reported, as the part of the absence the interval covers.
    const late = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-10-08T12:00:00.000Z',
      now: NOW,
    })
    expect(late?.evidence.gaps.map((g) => g.days)).toEqual([10])
  })

  it('the declaration baseline as of the reference prefers an observed row over a reconstructed one on the same day', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-03-01T12:00:00.000Z')
    decl('orchard/alpha', 100, '2025-03-01T12:00:00.000Z', 'expanding')
    decl('orchard/alpha', 100, '2025-03-01T23:59:59.999Z', 'consolidating', 'history')
    decl('orchard/alpha', 100, '2025-10-10T12:00:00.000Z', 'expanding')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-04-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.repositories.declarationChanges).toEqual([])
  })

  it('an identity with no row of any kind is unobserved; an observed declaration bounds a gap', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-05-01T12:00:00.000Z')
    decl('orchard/alpha', 100, '2025-10-10T12:00:00.000Z', 'consolidating')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    repo('orchard/empty', 200)
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-04-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.evidence.unobserved).toEqual([
      { fullName: 'orchard/empty', githubId: 200 },
    ])
    // The gap ends at the declaration observation on Oct 10, not at the Oct 18 snapshot.
    expect(report?.evidence.gaps.map((g) => [g.observedAt.slice(0, 10), g.days])).toEqual(
      [['2025-10-10', 162]],
    )
  })

  it('climate declarations and proposals inside the interval are listed', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    db.insert(climateDeclarations)
      .values({
        climate: 'consolidation',
        declaredAt: '2025-07-01T12:00:00.000Z',
        declaredBy: 'x',
        declaredById: STEWARD,
      })
      .run()
    db.insert(climateProposals)
      .values({
        climate: 'dormancy',
        basis: 'synthetic',
        triggerType: 'core_divergence',
        observation: 'synthetic',
        status: 'withdrawn',
        proposedAt: '2025-03-01T12:00:00.000Z',
        respondedAt: '2025-08-01T12:00:00.000Z',
        stewardId: STEWARD,
      })
      .run()
    const report = computeSince(db, {
      stewardId: STEWARD,
      referenceAt: '2025-06-01T00:00:00.000Z',
      now: NOW,
    })
    expect(report?.climate.declarations).toEqual([
      { climate: 'consolidation', declaredAt: '2025-07-01T12:00:00.000Z' },
    ])
    expect(report?.climate.proposals.map((p) => [p.climate, p.status])).toEqual([
      ['dormancy', 'withdrawn'],
    ])
  })

  it('a kept reference is used when none is chosen, and keeping one is explicit and append-only', () => {
    repo('orchard/alpha', 100)
    snap('orchard/alpha', 100, '2025-01-01T12:00:00.000Z')
    snap('orchard/alpha', 100, '2025-10-18T12:00:00.000Z')
    saveReference(
      {
        stewardId: STEWARD,
        referenceAt: '2025-09-01T00:00:00.000Z',
        label: 'before the autumn',
        savedAt: '2025-10-19T10:00:00.000Z',
      },
      db,
    )
    saveReference(
      {
        stewardId: STEWARD,
        referenceAt: '2025-08-01T00:00:00.000Z',
        savedAt: '2025-10-19T11:00:00.000Z',
      },
      db,
    )
    expect(latestReference(STEWARD, db)?.referenceAt).toBe('2025-08-01T00:00:00.000Z')
    expect(listReferences(STEWARD, db)).toHaveLength(2)
    const report = computeSince(db, { stewardId: STEWARD, now: NOW })
    expect(report?.reference).toEqual({
      at: '2025-08-01T00:00:00.000Z',
      basis: 'saved',
      label: null,
    })
    // Computing saved nothing.
    expect(listReferences(STEWARD, db)).toHaveLength(2)
  })

  it('nothing in scope observed: no report', () => {
    expect(computeSince(db, { stewardId: STEWARD, now: NOW })).toBeUndefined()
  })
})
