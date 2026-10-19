import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type GroveDb } from '../client'
import {
  finishRun,
  getLatestCompleteFullRun,
  getRun,
  getRunRepositories,
  recordRunRepository,
  startRun,
} from '../runs'
import { collectionRuns } from '../schema'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

describe('collection runs', () => {
  it('records a run, what it was about, and how it ended', () => {
    const id = startRun(
      {
        method: 'cli',
        stewardId: 7,
        fullPortfolio: true,
        scope: { owners: new Set(['orchard']), exclude: new Set(['orchard/hidden']) },
        startedAt: '2025-01-01T12:00:00.000Z',
      },
      db,
    )
    recordRunRepository(id, { githubId: 100, fullName: 'orchard/alpha', outcome: 'observed' }, db)
    recordRunRepository(id, { githubId: 200, fullName: 'orchard/beta', outcome: 'unchanged' }, db)
    recordRunRepository(
      id,
      { githubId: 300, fullName: 'orchard/gamma', outcome: 'unavailable', answer: 'forbidden' },
      db,
    )
    finishRun(id, { complete: true, finishedAt: '2025-01-01T12:00:05.000Z' }, db)

    expect(getRun(id, db)).toMatchObject({
      method: 'cli',
      stewardId: 7,
      fullPortfolio: true,
      complete: true,
      answer: null,
      scope: JSON.stringify({ owners: ['orchard'], exclude: ['orchard/hidden'] }),
      finishedAt: '2025-01-01T12:00:05.000Z',
    })
    expect(getRunRepositories(id, db).map((r) => [r.fullName, r.outcome, r.answer])).toEqual([
      ['orchard/alpha', 'observed', null],
      ['orchard/beta', 'unchanged', null],
      ['orchard/gamma', 'unavailable', 'forbidden'],
    ])
  })

  it('only a complete live run over the whole scope by this steward counts as the latest full run', () => {
    const full = startRun(
      { method: 'cli', stewardId: 7, fullPortfolio: true, startedAt: '2025-01-01T12:00:00.000Z' },
      db,
    )
    finishRun(full, { complete: true }, db)
    const targeted = startRun(
      { method: 'visit', stewardId: 7, fullPortfolio: false, startedAt: '2025-01-02T12:00:00.000Z' },
      db,
    )
    finishRun(targeted, { complete: true }, db)
    const interrupted = startRun(
      { method: 'cli', stewardId: 7, fullPortfolio: true, startedAt: '2025-01-03T12:00:00.000Z' },
      db,
    )
    finishRun(interrupted, { complete: false, answer: 'throttled' }, db)
    const backfill = startRun(
      { method: 'backfill', stewardId: 7, fullPortfolio: true, startedAt: '2025-01-04T12:00:00.000Z' },
      db,
    )
    finishRun(backfill, { complete: true }, db)
    const someoneElse = startRun(
      { method: 'cli', stewardId: 8, fullPortfolio: true, startedAt: '2025-01-05T12:00:00.000Z' },
      db,
    )
    finishRun(someoneElse, { complete: true }, db)

    expect(getLatestCompleteFullRun(7, db)?.id).toBe(full)
    expect(getLatestCompleteFullRun(9, db)).toBeUndefined()
  })

  it('the same scope listed in another order matches the run that recorded it', () => {
    const id = startRun(
      {
        method: 'cli',
        stewardId: 7,
        fullPortfolio: true,
        scope: { owners: new Set(['pear', 'orchard']), exclude: new Set(['orchard/b', 'orchard/a']) },
      },
      db,
    )
    finishRun(id, { complete: true }, db)
    const reordered = { owners: new Set(['orchard', 'pear']), exclude: new Set(['orchard/a', 'orchard/b']) }
    expect(getLatestCompleteFullRun(7, db, reordered)?.id).toBe(id)
  })

  it('a run recorded before members were sorted still matches its scope', () => {
    const id = startRun(
      { method: 'cli', stewardId: 7, fullPortfolio: true, startedAt: '2025-01-01T12:00:00.000Z' },
      db,
    )
    finishRun(id, { complete: true }, db)
    db.update(collectionRuns)
      .set({ scope: JSON.stringify({ owners: ['z', 'a'], exclude: [] }) })
      .where(eq(collectionRuns.id, id))
      .run()
    expect(getLatestCompleteFullRun(7, db, { owners: new Set(['a', 'z']), exclude: new Set() })?.id).toBe(id)
    expect(getLatestCompleteFullRun(7, db, { owners: new Set(['a']), exclude: new Set() })).toBeUndefined()
    expect(getLatestCompleteFullRun(7, db)).toBeUndefined()
  })

  it('a run with no scope records none', () => {
    const id = startRun({ method: 'visit', fullPortfolio: false }, db)
    expect(getRun(id, db)?.scope).toBeNull()
    expect(getRun(id, db)?.finishedAt).toBeNull()
  })
})
