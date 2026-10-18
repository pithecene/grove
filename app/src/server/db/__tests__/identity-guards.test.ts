import type { GroveDeclaration, RepositoryEcology } from '@grove/core'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { getDeclarationHistoryForIdentity, getSnapshotHistoryForIdentity } from '../bindings'
import { createDb, type GroveDb } from '../client'
import { recordDeclarationIfChanged } from '../declarations'
import { recordSnapshot, recordSnapshotBatch, upsertRepository } from '../snapshots'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

const NAME = 'orchard/alpha'

const declaration: GroveDeclaration = {
  intent: 'synthetic',
  horizon: 'perennial',
  role: 'library',
  phase: 'consolidating',
}

const ecology: RepositoryEcology = {
  fullName: NAME,
  htmlUrl: `https://github.com/${NAME}`,
  classified: true,
  declaration,
}

function observeAs(githubId: number) {
  upsertRepository(
    {
      fullName: NAME,
      htmlUrl: `https://github.com/${NAME}`,
      defaultBranch: 'main',
      githubId,
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    db,
  )
}

describe('per-identity guards when a name is reused within the interval', () => {
  it('the snapshot throttle does not skip the new identity’s first snapshot', () => {
    observeAs(100)
    expect(recordSnapshot(ecology, undefined, undefined, db)).toBe(true)
    expect(recordSnapshot(ecology, undefined, undefined, db)).toBe(false)

    observeAs(200) // same name, different repository, moments later
    expect(recordSnapshot(ecology, undefined, undefined, db)).toBe(true)
    expect(recordSnapshot(ecology, undefined, undefined, db)).toBe(false)

    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(1)
    expect(getSnapshotHistoryForIdentity(200, {}, db)).toHaveLength(1)
  })

  it('the batch throttle behaves the same', () => {
    observeAs(100)
    recordSnapshotBatch([{ ecology }], db)
    observeAs(200)
    recordSnapshotBatch([{ ecology }], db)
    recordSnapshotBatch([{ ecology }], db)
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(1)
    expect(getSnapshotHistoryForIdentity(200, {}, db)).toHaveLength(1)
  })

  it('an identical declaration under the new identity starts its own history', () => {
    observeAs(100)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db)).toBe(true)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db)).toBe(false)

    observeAs(200)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db)).toBe(true)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db)).toBe(false)

    expect(getDeclarationHistoryForIdentity(100, 10, db)).toHaveLength(1)
    expect(getDeclarationHistoryForIdentity(200, 10, db)).toHaveLength(1)
  })

  it('a name without any binding keeps the name-keyed behaviour', () => {
    upsertRepository(
      { fullName: NAME, htmlUrl: `https://github.com/${NAME}`, defaultBranch: 'main' },
      db,
    )
    expect(recordSnapshot(ecology, undefined, undefined, db)).toBe(true)
    expect(recordSnapshot(ecology, undefined, undefined, db)).toBe(false)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db)).toBe(true)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db)).toBe(false)
  })
})
