import type { TreeEntry } from '@grove/github'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { backfillHistory, lastBackfillDay, RECONSTRUCTION_ALGORITHM } from '../backfill'
import { getRun, getRunRepositories, getSnapshotHistoryForIdentity, recordObservedBinding } from '../db'
import { createDb, type GroveDb } from '../db/client'
import { declarationChanges, ecologySnapshots, repositories } from '../db/schema'
import type { HistoryCommit, HistorySource } from '../history/source'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

const NOW = () => new Date('2025-02-10T12:00:00.000Z')
const NAME = 'orchard/alpha'

function seedRepository(createdAt: string | null, fullName = NAME, githubId = 100) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt: '2025-02-10T00:00:00.000Z',
      githubId,
      createdAt,
    })
    .run()
}

interface FakeCommit extends HistoryCommit {
  tree: TreeEntry[]
  files: Record<string, string>
}

/** A fabricated first-parent history: commits oldest first, each with its full tree and files. */
class FakeSource implements HistorySource {
  constructor(
    readonly commits: FakeCommit[],
    readonly log: string[] = [],
  ) {}
  async firstParentCommits() {
    return this.commits.map(({ sha, committedAt }) => ({ sha, committedAt }))
  }
  async commitsTouching(path: string) {
    const touching: HistoryCommit[] = []
    let previous: string | undefined
    for (const c of this.commits) {
      const content = c.files[path]
      if (content !== previous) touching.push({ sha: c.sha, committedAt: c.committedAt })
      previous = content
    }
    return touching
  }
  async treeAt(sha: string) {
    this.log.push(`tree ${sha}`)
    const c = this.commits.find((x) => x.sha === sha)
    if (!c) throw new Error(`no commit ${sha}`)
    return c.tree
  }
  async fileAt(sha: string, path: string) {
    const c = this.commits.find((x) => x.sha === sha)
    return c?.files[path]
  }
}

const blob = (path: string): TreeEntry => ({ path, type: 'blob' })
const yaml = (phase: string, extra = '') =>
  `grove:\n  intent: synthetic\n  horizon: perennial\n  role: library\n  phase: ${phase}\n${extra}`

const commit = (
  sha: string,
  committedAt: string,
  files: Record<string, string>,
  tree?: TreeEntry[],
): FakeCommit => ({
  sha,
  committedAt,
  files,
  tree: tree ?? Object.keys(files).map(blob),
})

describe('backfillHistory', () => {
  it('never includes the current day', () => {
    expect(lastBackfillDay(NOW())).toBe('2025-02-09')
  })

  it('fills each past day from the last first-parent commit at or before its end, atomically', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    recordObservedBinding(100, NAME, '2025-02-10T00:00:00.000Z', db)
    const source = new FakeSource([
      commit('c1', '2025-01-03T10:00:00.000Z', { 'README.md': '# a', '.grove.yaml': yaml('expanding') }),
      commit('c2', '2025-01-05T10:00:00.000Z', {
        'README.md': '# a',
        'package.json': '{"dependencies":{"beta":"1"}}',
        '.grove.yaml': yaml('consolidating'),
        'src/index.test.ts': '',
      }),
    ])
    const report = await backfillHistory(db, {
      from: '2025-01-01',
      to: '2025-01-06',
      apply: true,
      sourceFor: async () => source,
      now: NOW,
    })
    const entry = report.entries[0]
    expect(entry).toMatchObject({
      fullName: NAME,
      daysToFill: 6,
      daysFromTree: 4, // Jan 3, 4, 5, 6
      daysEmpty: 2, // Jan 1, 2: created, no commit yet
      daysBeforeCreation: 0,
      declarations: 2,
      commitsInRange: 2,
    })

    const rows = db.select().from(ecologySnapshots).orderBy(ecologySnapshots.observedAt).all()
    expect(rows.map((r) => [r.observedAt.slice(0, 10), r.method, r.githubId, r.classified, r.phase])).toEqual([
      ['2025-01-01', 'history', 100, false, null],
      ['2025-01-02', 'history', 100, false, null],
      ['2025-01-03', 'history', 100, true, 'expanding'],
      ['2025-01-04', 'history', 100, true, 'expanding'],
      ['2025-01-05', 'history', 100, true, 'consolidating'],
      ['2025-01-06', 'history', 100, true, 'consolidating'],
    ])
    expect(rows[0].observedAt).toBe('2025-01-01T23:59:59.999Z')
    const empty = JSON.parse(rows[0].evidence ?? '{}')
    expect(empty).toMatchObject({ state: 'empty', sha: null, branch_state: 'retrospective' })
    const fromTree = JSON.parse(rows[5].evidence ?? '{}')
    expect(fromTree).toMatchObject({
      state: 'tree',
      sha: 'c2',
      committed_at: '2025-01-05T10:00:00.000Z',
      algorithm: RECONSTRUCTION_ALGORITHM,
      // the only binding starts in February: the January rows take its name as the nearest later one
      name_basis: 'later_binding',
    })
    expect(fromTree.divergences.length).toBeGreaterThan(0)
    expect(rows[5]).toMatchObject({
      fileCount: 4,
      commitsLast30d: 2,
      dependencyManifestsObserved: JSON.stringify(['package.json']),
      recordedAt: NOW().toISOString(),
      collectionRunId: report.runId,
    })
    // Signals never credit a day with commits after it.
    expect(rows[2].commitsLast30d).toBe(1)

    const declarations = db.select().from(declarationChanges).orderBy(declarationChanges.observedAt).all()
    expect(declarations.map((d) => [d.observedAt, d.method, d.phase])).toEqual([
      ['2025-01-03T10:00:00.000Z', 'history', 'expanding'],
      ['2025-01-05T10:00:00.000Z', 'history', 'consolidating'],
    ])
    expect(JSON.parse(declarations[0].evidence ?? '{}')).toMatchObject({ sha: 'c1', path: '.grove.yaml' })

    expect(getRun(report.runId as number, db)).toMatchObject({ method: 'backfill', fullPortfolio: true, complete: true })
    expect(getRunRepositories(report.runId as number, db).map((r) => r.outcome)).toEqual(['observed'])
    // Identity-keyed history sees the reconstructed rows.
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(6)
  })

  it('leaves days before creation empty and skips days that already have a snapshot', async () => {
    seedRepository('2025-01-03T00:00:00.000Z')
    db.insert(ecologySnapshots)
      .values({ fullName: NAME, githubId: 100, observedAt: '2025-01-04T09:00:00.000Z', classified: true })
      .run()
    const source = new FakeSource([commit('c1', '2025-01-03T10:00:00.000Z', { 'README.md': '' })])
    const report = await backfillHistory(db, {
      from: '2025-01-01',
      to: '2025-01-05',
      apply: true,
      sourceFor: async () => source,
      now: NOW,
    })
    expect(report.entries[0]).toMatchObject({ daysBeforeCreation: 2, daysToFill: 2, daysFromTree: 2 })
    const days = db
      .select()
      .from(ecologySnapshots)
      .all()
      .map((r) => [r.observedAt.slice(0, 10), r.method])
      .sort()
    expect(days).toEqual([
      ['2025-01-03', 'history'],
      ['2025-01-04', 'observed'],
      ['2025-01-05', 'history'],
    ])
  })

  it('dates decide the day’s commit and creation bounds every day, whatever the history order says', async () => {
    // Imported history: a commit dated before creation, and traversal order
    // that is not chronological.
    seedRepository('2025-01-02T00:00:00.000Z')
    const source = new FakeSource([
      commit('old', '2024-12-20T10:00:00.000Z', { 'README.md': 'imported' }),
      commit('late', '2025-01-04T10:00:00.000Z', { 'README.md': 'late' }),
      commit('mid', '2025-01-03T10:00:00.000Z', { 'README.md': 'mid' }),
    ])
    const report = await backfillHistory(db, {
      from: '2025-01-01',
      to: '2025-01-04',
      apply: true,
      sourceFor: async () => source,
      now: NOW,
    })
    expect(report.entries[0]).toMatchObject({ daysBeforeCreation: 1, daysFromTree: 3 })
    const rows = db.select().from(ecologySnapshots).orderBy(ecologySnapshots.observedAt).all()
    expect(rows.map((r) => [r.observedAt.slice(0, 10), JSON.parse(r.evidence ?? '{}').sha])).toEqual([
      ['2025-01-02', 'old'],
      ['2025-01-03', 'mid'],
      ['2025-01-04', 'late'],
    ])
  })

  it('a renamed repository is one target, under its most recently observed name', async () => {
    seedRepository('2024-06-01T00:00:00.000Z', 'orchard/old', 100)
    db.update(repositories).set({ lastObservedAt: '2024-12-01T00:00:00.000Z' }).run()
    seedRepository('2024-06-01T00:00:00.000Z', 'orchard/new', 100)
    const opened: string[] = []
    const source = new FakeSource([commit('c1', '2024-12-01T10:00:00.000Z', { 'README.md': '' })])
    const report = await backfillHistory(db, {
      from: '2025-01-01',
      to: '2025-01-02',
      apply: false,
      sourceFor: async (t) => {
        opened.push(t.fullName)
        return source
      },
      now: NOW,
    })
    expect(report.entries.map((e) => e.fullName)).toEqual(['orchard/new'])
    expect(opened).toEqual(['orchard/new'])
  })

  it('ecosystem membership on a day comes from repositories known to exist by then, or is unknown', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    seedRepository('2024-06-01T00:00:00.000Z', 'orchard/beta', 200)
    seedRepository('2025-01-03T00:00:00.000Z', 'orchard/gamma', 300)
    const pkg = '{"dependencies":{"beta":"1","gamma":"1"}}'
    const source = new FakeSource([commit('c1', '2025-01-01T10:00:00.000Z', { 'package.json': pkg })])
    await backfillHistory(db, { from: '2025-01-02', to: '2025-01-03', apply: true, sourceFor: async () => source, now: NOW })
    const rows = db
      .select()
      .from(ecologySnapshots)
      .orderBy(ecologySnapshots.observedAt)
      .all()
      .filter((r) => r.githubId === 100)
    // Jan 2: beta exists, gamma not yet → 1. Jan 3: both → 2.
    expect(rows.map((r) => [r.observedAt.slice(0, 10), r.ecosystemDependencyCount])).toEqual([
      ['2025-01-02', 1],
      ['2025-01-03', 2],
    ])

    // A repository with no known creation date makes membership unknown.
    db.insert(repositories)
      .values({ fullName: 'orchard/delta', htmlUrl: 'https://github.com/orchard/delta', defaultBranch: 'main', lastObservedAt: '2025-01-01T00:00:00.000Z', githubId: 400 })
      .run()
    await backfillHistory(db, { from: '2025-01-04', to: '2025-01-04', apply: true, sourceFor: async () => source, now: NOW })
    const jan4 = db
      .select()
      .from(ecologySnapshots)
      .all()
      .find((r) => r.githubId === 100 && r.observedAt.startsWith('2025-01-04'))
    expect(jan4?.ecosystemDependencyCount).toBeNull()
  })

  it('a repository known only through a binding is a target', async () => {
    // Upgraded database: the repository row has no id, but the identity
    // backfill bound the name.
    db.insert(repositories)
      .values({ fullName: NAME, htmlUrl: `https://github.com/${NAME}`, defaultBranch: 'main', lastObservedAt: '2025-01-01T00:00:00.000Z' })
      .run()
    recordObservedBinding(100, NAME, '2025-01-01T00:00:00.000Z', db)
    const source = new FakeSource([commit('c1', '2024-12-01T10:00:00.000Z', { 'README.md': '' })])
    const report = await backfillHistory(db, { from: '2025-01-02', to: '2025-01-02', apply: false, sourceFor: async () => source, now: NOW })
    expect(report.entries.map((e) => [e.fullName, e.githubId, e.daysToFill])).toEqual([[NAME, 100, 1]])
  })

  it('a range already covered never opens the history', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    for (const d of ['02', '03']) {
      db.insert(ecologySnapshots)
        .values({ fullName: NAME, githubId: 100, observedAt: `2025-01-${d}T12:00:00.000Z`, classified: true })
        .run()
    }
    const report = await backfillHistory(db, {
      from: '2025-01-02',
      to: '2025-01-03',
      apply: true,
      sourceFor: async () => {
        throw new Error('history must not be opened')
      },
      now: NOW,
    })
    expect(report.entries[0].message).toBeUndefined()
    expect(getRunRepositories(report.runId as number, db).map((r) => r.outcome)).toEqual(['unchanged'])
  })

  it('a dry run plans and reads no tree; re-running after apply writes nothing', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    const source = new FakeSource([commit('c1', '2025-01-01T10:00:00.000Z', { 'README.md': '' })])
    const dry = await backfillHistory(db, { from: '2025-01-01', to: '2025-01-03', apply: false, sourceFor: async () => source, now: NOW })
    expect(dry.entries[0]).toMatchObject({ daysToFill: 3, daysFromTree: 3 })
    expect(dry.runId).toBeUndefined()
    expect(source.log).toEqual([])
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(0)

    await backfillHistory(db, { from: '2025-01-01', to: '2025-01-03', apply: true, sourceFor: async () => source, now: NOW })
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(3)
    const again = await backfillHistory(db, { from: '2025-01-01', to: '2025-01-03', apply: true, sourceFor: async () => source, now: NOW })
    expect(again.entries[0]).toMatchObject({ daysToFill: 0 })
    expect(getRunRepositories(again.runId as number, db).map((r) => r.outcome)).toEqual(['unchanged'])
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(3)
  })

  it('several declaration changes on one day each get a row; an unchanged file does not', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    const source = new FakeSource([
      commit('c1', '2025-01-02T08:00:00.000Z', { '.grove.yaml': yaml('emerging') }),
      commit('c2', '2025-01-02T12:00:00.000Z', { '.grove.yaml': yaml('expanding') }),
      commit('c3', '2025-01-02T16:00:00.000Z', { '.grove.yaml': yaml('expanding'), 'README.md': '' }),
      commit('c4', '2025-01-02T20:00:00.000Z', { '.grove.yaml': yaml('consolidating'), 'README.md': '' }),
    ])
    await backfillHistory(db, { from: '2025-01-02', to: '2025-01-02', apply: true, sourceFor: async () => source, now: NOW })
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(1)
    expect(db.select().from(declarationChanges).all().map((d) => d.phase)).toEqual([
      'emerging',
      'expanding',
      'consolidating',
    ])
  })

  it('a declaration equal to the one last observed under a former name is not a change', async () => {
    seedRepository('2024-06-01T00:00:00.000Z', 'orchard/new', 100)
    db.insert(repositories)
      .values({ fullName: 'orchard/old', htmlUrl: 'https://github.com/orchard/old', defaultBranch: 'main', lastObservedAt: '2024-12-01T00:00:00.000Z' })
      .run()
    // Observed live under the old name (no id on the row), bound to the identity.
    db.insert(declarationChanges)
      .values({
        fullName: 'orchard/old',
        observedAt: '2024-12-01T12:00:00.000Z',
        classified: true,
        intent: 'synthetic',
        horizon: 'perennial',
        role: 'library',
        phase: 'expanding',
      })
      .run()
    recordObservedBinding(100, 'orchard/old', '2024-12-01T12:00:00.000Z', db)
    const source = new FakeSource([
      commit('c1', '2024-11-20T10:00:00.000Z', { '.grove.yaml': yaml('expanding') }),
      commit('c2', '2025-01-02T10:00:00.000Z', { '.grove.yaml': yaml('expanding'), 'README.md': '' }),
      commit('c3', '2025-01-03T10:00:00.000Z', { '.grove.yaml': yaml('consolidating'), 'README.md': '' }),
    ])
    await backfillHistory(db, { from: '2025-01-01', to: '2025-01-03', apply: true, sourceFor: async () => source, now: NOW })
    const added = db.select().from(declarationChanges).all().filter((d) => d.method === 'history')
    expect(added.map((d) => d.phase)).toEqual(['consolidating'])
  })

  it('rows land under the name the identity held that day, or the nearest later binding', async () => {
    seedRepository('2024-06-01T00:00:00.000Z', 'orchard/new', 100)
    db.insert(repositories)
      .values({ fullName: 'orchard/old', htmlUrl: 'https://github.com/orchard/old', defaultBranch: 'main', lastObservedAt: '2025-01-01T00:00:00.000Z' })
      .run()
    recordObservedBinding(100, 'orchard/old', '2025-01-02T12:00:00.000Z', db)
    recordObservedBinding(100, 'orchard/new', '2025-01-05T12:00:00.000Z', db)
    const source = new FakeSource([commit('c1', '2024-12-01T10:00:00.000Z', { 'README.md': '' })])
    await backfillHistory(db, { from: '2025-01-01', to: '2025-01-06', apply: true, sourceFor: async () => source, now: NOW })
    const rows = db.select().from(ecologySnapshots).orderBy(ecologySnapshots.observedAt).all()
    expect(rows.map((r) => [r.observedAt.slice(0, 10), r.fullName, JSON.parse(r.evidence ?? '{}').name_basis])).toEqual([
      ['2025-01-01', 'orchard/old', 'later_binding'],
      ['2025-01-02', 'orchard/old', 'binding'],
      ['2025-01-03', 'orchard/new', 'later_binding'],
      ['2025-01-04', 'orchard/new', 'later_binding'],
      ['2025-01-05', 'orchard/new', 'binding'],
      ['2025-01-06', 'orchard/new', 'current_name'],
    ])
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(6)
  })

  it('a day whose write fails leaves nothing of that day behind', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    const source = new FakeSource([
      commit('c1', '2025-01-01T10:00:00.000Z', { '.grove.yaml': yaml('expanding') }),
      commit('c2', '2025-01-02T10:00:00.000Z', { '.grove.yaml': yaml('consolidating') }),
    ])
    // Second day's declaration read fails after its snapshot would be prepared.
    source.fileAt = async (sha, path) => {
      if (sha === 'c2' && path === '.grove.yaml') throw new Error('synthetic read failure')
      return source.commits.find((c) => c.sha === sha)?.files[path]
    }
    const report = await backfillHistory(db, {
      from: '2025-01-01',
      to: '2025-01-02',
      apply: true,
      sourceFor: async () => source,
      now: NOW,
    })
    // Reported on the target and the run; the completed day stands, the failed
    // one is absent — and only the committed day is counted.
    expect(report.entries[0].message).toContain('synthetic read failure')
    expect(report.entries[0]).toMatchObject({ daysToFill: 1, daysFromTree: 1, declarations: 1 })
    expect(getRunRepositories(report.runId as number, db).map((r) => [r.outcome, r.answer])).toEqual([
      ['unavailable', 'history'],
    ])
    expect(getRun(report.runId as number, db)?.complete).toBe(true)
    expect(db.select().from(ecologySnapshots).all().map((r) => r.observedAt.slice(0, 10))).toEqual(['2025-01-01'])
    expect(db.select().from(declarationChanges).all()).toHaveLength(1)
  })

  it('a day with no commit and no creation evidence is unknown, not "before creation"', async () => {
    seedRepository(null)
    const source = new FakeSource([commit('c1', '2025-01-03T10:00:00.000Z', { 'README.md': '' })])
    const report = await backfillHistory(db, { from: '2025-01-01', to: '2025-01-03', apply: true, sourceFor: async () => source, now: NOW })
    expect(report.entries[0]).toMatchObject({ daysUnknown: 2, daysBeforeCreation: 0, daysEmpty: 0, daysFromTree: 1 })
    expect(db.select().from(ecologySnapshots).all().map((r) => r.observedAt.slice(0, 10))).toEqual(['2025-01-03'])
  })

  it('a .grove.yaml commit before the range is the baseline for the first change inside it', async () => {
    seedRepository('2024-01-01T00:00:00.000Z')
    const source = new FakeSource([
      commit('c0', '2024-12-01T10:00:00.000Z', { '.grove.yaml': yaml('expanding') }),
      // Formatting-only change: the declaration reads the same.
      commit('c1', '2025-01-02T10:00:00.000Z', { '.grove.yaml': `${yaml('expanding')}\n# note\n` }),
      commit('c2', '2025-01-03T10:00:00.000Z', { '.grove.yaml': yaml('consolidating') }),
    ])
    const report = await backfillHistory(db, { from: '2025-01-02', to: '2025-01-03', apply: true, sourceFor: async () => source, now: NOW })
    expect(report.entries[0].declarations).toBe(1)
    expect(db.select().from(declarationChanges).all().map((d) => d.phase)).toEqual(['consolidating'])
  })

  it('a dry run counts the declaration rows apply would write — unchanged declarations excluded', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    const source = new FakeSource([
      commit('c1', '2025-01-01T08:00:00.000Z', { '.grove.yaml': yaml('expanding') }),
      commit('c2', '2025-01-02T08:00:00.000Z', { '.grove.yaml': yaml('expanding'), 'README.md': 'x' }),
      commit('c3', '2025-01-02T12:00:00.000Z', { '.grove.yaml': yaml('expanding', '  steward: someone\n'), 'README.md': 'x' }),
      commit('c4', '2025-01-03T08:00:00.000Z', { '.grove.yaml': yaml('expanding', '  steward: someone\n'), 'README.md': 'xy' }),
    ])
    const opts = { from: '2025-01-01', to: '2025-01-03', sourceFor: async () => source, now: NOW }
    const dry = await backfillHistory(db, { ...opts, apply: false })
    const applied = await backfillHistory(db, { ...opts, apply: true })
    expect(dry.entries[0].declarations).toBe(2)
    expect(applied.entries[0].declarations).toBe(2)
    expect(db.select().from(declarationChanges).all().map((d) => [d.observedAt.slice(0, 10), d.steward])).toEqual([
      ['2025-01-01', null],
      ['2025-01-02', 'someone'],
    ])
  })

  it('a target whose history cannot be opened is reported, not guessed', async () => {
    seedRepository('2025-01-01T00:00:00.000Z')
    const report = await backfillHistory(db, {
      from: '2025-01-01',
      to: '2025-01-02',
      apply: true,
      sourceFor: async () => {
        throw new Error('clone refused')
      },
      now: NOW,
    })
    expect(report.entries[0].message).toContain('clone refused')
    expect(getRunRepositories(report.runId as number, db).map((r) => [r.outcome, r.answer])).toEqual([
      ['unavailable', 'history'],
    ])
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(0)
  })
})
