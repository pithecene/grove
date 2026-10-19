import type { GitHubAnswer, GitHubRepo } from '@grove/github'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { getBindingsForIdentity, getResolution, listResolutions } from '../db/bindings'
import { createDb, type GroveDb } from '../db/client'
import { ecologySnapshots, repositories, repositoryBindings } from '../db/schema'
import { backfillIdentities, type NameResolver } from '../identity-backfill'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

function seedName(fullName: string, snapshotDays: string[]) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt: '2025-01-01T00:00:00.000Z',
    })
    .run()
  for (const day of snapshotDays) {
    db.insert(ecologySnapshots)
      .values({ fullName, observedAt: `${day}T12:00:00.000Z`, classified: false })
      .run()
  }
}

function resolved(
  id: number,
  fullName: string,
  createdAt?: string,
): GitHubAnswer<GitHubRepo> {
  return {
    kind: 'ok',
    status: 200,
    value: {
      id,
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
      default_branch: 'main',
      pushed_at: null,
      created_at: createdAt ?? null,
    },
  }
}

const table: Record<string, GitHubAnswer<GitHubRepo>> = {
  'person/thing': resolved(100, 'org/thing', '2024-01-01T00:00:00.000Z'),
  'org-old/thing': resolved(100, 'org/thing', '2024-01-01T00:00:00.000Z'),
  'org/thing': resolved(100, 'org/thing', '2024-01-01T00:00:00.000Z'),
  'someone/gone': { kind: 'not_found', status: 404 },
  'someone/locked': { kind: 'forbidden', status: 403 },
  'orchard/reused': resolved(300, 'orchard/reused', '2025-01-10T00:00:00.000Z'),
}

const resolver: NameResolver = async (name) =>
  table[name] ?? { kind: 'unavailable', status: 500 }

const clock = () => '2025-02-01T00:00:00.000Z'

describe('backfillIdentities', () => {
  beforeEach(() => {
    seedName('person/thing', ['2024-10-01', '2024-10-02'])
    seedName('org-old/thing', ['2024-11-01'])
    seedName('org/thing', ['2025-01-01'])
    seedName('someone/gone', ['2024-10-01'])
    seedName('someone/locked', ['2024-10-01'])
    seedName('orchard/reused', ['2024-12-01', '2025-01-15'])
  })

  it('dry run resolves everything and writes nothing', async () => {
    const report = await backfillIdentities(db, resolver, { apply: false, now: clock })
    expect(report.entries).toHaveLength(6)
    expect(report.bindingsInserted).toBe(0)
    expect(db.select().from(repositoryBindings).all()).toHaveLength(0)
    expect(listResolutions(db)).toHaveLength(0)
    const chain = report.entries.filter((e) => e.githubId === 100)
    expect(chain).toHaveLength(3)
    expect(chain.every((e) => e.resolvedFullName === 'org/thing')).toBe(true)
  })

  it('apply binds a rename chain to one identity with evidence and bounded spans', async () => {
    const report = await backfillIdentities(db, resolver, { apply: true, now: clock })
    expect(report.bindingsInserted).toBe(4)

    const bindings = getBindingsForIdentity(100, db)
    expect(bindings.map((b) => b.fullName)).toEqual([
      'person/thing',
      'org-old/thing',
      'org/thing',
    ])
    expect(bindings[0].firstObservedAt).toBe('2024-10-01T12:00:00.000Z')
    expect(bindings[0].lastObservedAt).toBe('2024-10-02T12:00:00.000Z')
    expect(bindings[0].method).toBe('github_redirect')
    expect(bindings[0].resolvedAt).toBe(clock())
    expect(JSON.parse(bindings[0].evidence ?? '{}')).toMatchObject({
      resolved_full_name: 'org/thing',
      http_status: 200,
    })
    // original observation rows are untouched
    expect(db.select().from(ecologySnapshots).all()).toHaveLength(8)
  })

  it('records unresolved names as unresolved, not as deleted', async () => {
    await backfillIdentities(db, resolver, { apply: true, now: clock })
    expect(getResolution('someone/gone', db)).toMatchObject({
      outcome: 'not_found',
      httpStatus: 404,
    })
    expect(getResolution('someone/locked', db)).toMatchObject({
      outcome: 'forbidden',
      httpStatus: 403,
    })
    expect(
      db
        .select()
        .from(repositoryBindings)
        .all()
        .some((b) => b.fullName === 'someone/gone'),
    ).toBe(false)
    // the name and its history remain
    expect(
      db
        .select()
        .from(repositories)
        .all()
        .some((r) => r.fullName === 'someone/gone'),
    ).toBe(true)
  })

  it('does not bind observations that predate the resolved repository (name reuse)', async () => {
    const report = await backfillIdentities(db, resolver, { apply: true, now: clock })
    const entry = report.entries.find((e) => e.fullName === 'orchard/reused')!
    expect(entry.outcome).toBe('name_reused')
    expect(entry.boundSpan).toEqual({
      first: '2025-01-10T00:00:00.000Z',
      last: '2025-01-15T12:00:00.000Z',
    })
    expect(entry.unboundSpan).toEqual({
      first: '2024-12-01T12:00:00.000Z',
      last: '2025-01-10T00:00:00.000Z',
    })
    const binding = getBindingsForIdentity(300, db)[0]
    expect(binding.firstObservedAt).toBe('2025-01-10T00:00:00.000Z')
    expect(getResolution('orchard/reused', db)?.outcome).toBe('name_reused')
  })

  it('leaves a reused name entirely unbound when every observation predates creation', async () => {
    seedName('orchard/reused-early', ['2024-05-01'])
    const only: NameResolver = async () =>
      resolved(400, 'orchard/reused-early', '2025-01-01T00:00:00.000Z')
    const report = await backfillIdentities(db, only, {
      apply: true,
      now: clock,
      names: ['orchard/reused-early'],
    })
    expect(report.entries[0].outcome).toBe('name_reused')
    expect(report.entries[0].boundSpan).toBeUndefined()
    expect(getBindingsForIdentity(400, db)).toHaveLength(0)
  })

  it('is idempotent across repeated runs', async () => {
    const first = await backfillIdentities(db, resolver, { apply: true, now: clock })
    const bindingsAfterFirst = db.select().from(repositoryBindings).all()
    const later = () => '2025-03-01T00:00:00.000Z'
    const second = await backfillIdentities(db, resolver, { apply: true, now: later })

    expect(first.bindingsInserted).toBe(4)
    expect(second.bindingsInserted).toBe(0)
    // only the unresolved names are re-attempted
    expect(second.entries.map((e) => e.fullName).sort()).toEqual([
      'someone/gone',
      'someone/locked',
    ])
    expect(db.select().from(repositoryBindings).all()).toEqual(bindingsAfterFirst)
    expect(getResolution('someone/gone', db)?.attemptedAt).toBe(later())
  })

  it('never overwrites a live observed binding', async () => {
    db.insert(repositoryBindings)
      .values({
        githubId: 100,
        fullName: 'org/thing',
        firstObservedAt: '2025-01-01T12:00:00.000Z',
        lastObservedAt: '2025-01-01T12:00:00.000Z',
        method: 'observed',
        resolvedAt: '2025-01-01T12:00:00.000Z',
      })
      .run()
    const report = await backfillIdentities(db, resolver, { apply: true, now: clock })
    expect(report.entries.some((e) => e.fullName === 'org/thing')).toBe(false)
    const live = getBindingsForIdentity(100, db).find((b) => b.fullName === 'org/thing')!
    expect(live.method).toBe('observed')
  })
})
