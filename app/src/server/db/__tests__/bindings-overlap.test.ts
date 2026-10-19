import type { GitHubAnswer, GitHubRepo } from '@grove/github'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { backfillIdentities } from '../../identity-backfill'
import {
  findOverlappingBinding,
  getBindingsForIdentity,
  recordObservedBinding,
  recordResolvedBinding,
} from '../bindings'
import { createDb, type GroveDb } from '../client'
import { ecologySnapshots, repositories, repositoryBindings } from '../schema'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
  db.insert(repositories)
    .values({
      fullName: 'orchard/alpha',
      htmlUrl: 'https://github.com/orchard/alpha',
      defaultBranch: 'main',
      lastObservedAt: '2025-01-01T00:00:00.000Z',
    })
    .run()
  for (const day of ['2025-01-05', '2025-01-20']) {
    db.insert(ecologySnapshots)
      .values({
        fullName: 'orchard/alpha',
        observedAt: `${day}T12:00:00.000Z`,
        classified: false,
      })
      .run()
  }
  // identity 100 holds the name Jan 10–15 (observed live)
  recordObservedBinding(100, 'orchard/alpha', '2025-01-10T12:00:00.000Z', db)
  recordObservedBinding(100, 'orchard/alpha', '2025-01-15T12:00:00.000Z', db)
})

const segment = (githubId: number, first: string, last: string) => ({
  githubId,
  fullName: 'orchard/alpha',
  firstObservedAt: `${first}T12:00:00.000Z`,
  lastObservedAt: `${last}T12:00:00.000Z`,
  resolvedAt: '2025-02-01T00:00:00.000Z',
  evidence: {},
})

describe('overlapping segments are refused', () => {
  it('detects an overlap with another identity, not with the same one', () => {
    expect(
      findOverlappingBinding(
        'orchard/alpha',
        200,
        '2025-01-12T12:00:00.000Z',
        '2025-01-13T12:00:00.000Z',
        db,
      ),
    ).toBeDefined()
    expect(
      findOverlappingBinding(
        'orchard/alpha',
        100,
        '2025-01-12T12:00:00.000Z',
        '2025-01-13T12:00:00.000Z',
        db,
      ),
    ).toBeUndefined()
    expect(
      findOverlappingBinding(
        'orchard/alpha',
        200,
        '2025-01-16T12:00:00.000Z',
        '2025-01-20T12:00:00.000Z',
        db,
      ),
    ).toBeUndefined()
  })

  it('a resolved segment overlapping another identity is not inserted', () => {
    expect(recordResolvedBinding(segment(200, '2025-01-05', '2025-01-20'), db)).toBe(
      false,
    )
    expect(getBindingsForIdentity(200, db)).toHaveLength(0)
    // a non-overlapping reuse before the live segment is fine (identity 100's
    // segment adopted the Jan 5 row, so it reaches back to Jan 5)
    expect(recordResolvedBinding(segment(200, '2025-01-01', '2025-01-04'), db)).toBe(true)
    expect(db.select().from(repositoryBindings).all()).toHaveLength(2)
  })

  it('the backfill reports the conflict and writes nothing', async () => {
    const resolver = async (): Promise<GitHubAnswer<GitHubRepo>> => ({
      kind: 'ok',
      status: 200,
      value: {
        id: 200,
        full_name: 'orchard/alpha',
        html_url: 'https://github.com/orchard/alpha',
        default_branch: 'main',
        pushed_at: null,
        created_at: '2024-01-01T00:00:00.000Z',
      },
    })
    const report = await backfillIdentities(db, resolver, {
      apply: true,
      names: ['orchard/alpha'],
      now: () => '2025-02-01T00:00:00.000Z',
    })
    expect(report.entries[0].outcome).toBe('overlap')
    expect(report.entries[0].message).toContain('identity 100')
    expect(report.bindingsInserted).toBe(0)
    expect(getBindingsForIdentity(200, db)).toHaveLength(0)
  })
})
