import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { GroveDeclaration, RepositoryEcology } from '@grove/core'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  getBindingsForIdentity,
  getDeclarationHistoryForIdentity,
  getSnapshotHistoryForIdentity,
} from '../bindings'
import { createDb, type GroveDb } from '../client'
import { recordDeclarationIfChanged } from '../declarations'
import { declarationChanges, ecologySnapshots, repositories } from '../schema'
import { getPortfolioCalendarWindow, recordSnapshot, upsertRepository } from '../snapshots'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

const NAME = 'orchard/alpha'
const declaration: GroveDeclaration = { intent: 'synthetic', phase: 'consolidating' }
const ecology: RepositoryEcology = {
  fullName: NAME,
  htmlUrl: `https://github.com/${NAME}`,
  classified: true,
  declaration,
}

function observeAs(githubId: number) {
  upsertRepository(
    { fullName: NAME, htmlUrl: `https://github.com/${NAME}`, defaultBranch: 'main', githubId },
    db,
  )
}

describe('rows recorded with their identity', () => {
  it('a snapshot and a declaration carry github_id when it is known', () => {
    observeAs(100)
    expect(recordSnapshot({ ...ecology, githubId: 100 }, undefined, undefined, db)).toBe(true)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db, 100)).toBe(true)
    expect(db.select().from(ecologySnapshots).all().map((r) => r.githubId)).toEqual([100])
    expect(db.select().from(declarationChanges).all().map((r) => r.githubId)).toEqual([100])
  })

  it('a row with an id is the identity’s even where no binding covers it', () => {
    // Row written with the id under the name, then the binding's bounds are
    // narrowed away from it — the row still belongs to 100 by its id.
    observeAs(100)
    recordSnapshot({ ...ecology, githubId: 100 }, undefined, undefined, db)
    const binding = getBindingsForIdentity(100, db)[0]
    db.run(
      `update repository_bindings set first_observed_at = '2030-01-01T00:00:00.000Z', last_observed_at = '2030-01-01T00:00:00.000Z' where id = ${binding.id}`,
    )
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(1)
  })

  it('a reused name never lends rows across identities, with or without bindings', () => {
    observeAs(100)
    recordSnapshot({ ...ecology, githubId: 100 }, undefined, undefined, db)
    recordDeclarationIfChanged(NAME, declaration, true, db, 100)
    observeAs(200)
    recordSnapshot({ ...ecology, githubId: 200 }, undefined, undefined, db)
    recordDeclarationIfChanged(NAME, declaration, true, db, 200)

    expect(getSnapshotHistoryForIdentity(100, {}, db).map((r) => r.githubId)).toEqual([100])
    expect(getSnapshotHistoryForIdentity(200, {}, db).map((r) => r.githubId)).toEqual([200])
    expect(getDeclarationHistoryForIdentity(100, 10, db).map((r) => r.githubId)).toEqual([100])
    expect(getDeclarationHistoryForIdentity(200, 10, db).map((r) => r.githubId)).toEqual([200])
  })

  it('the throttle and the dedupe compare against the identity’s own rows', () => {
    observeAs(100)
    expect(recordSnapshot({ ...ecology, githubId: 100 }, undefined, undefined, db)).toBe(true)
    expect(recordSnapshot({ ...ecology, githubId: 100 }, undefined, undefined, db)).toBe(false)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db, 100)).toBe(true)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db, 100)).toBe(false)
    observeAs(200)
    expect(recordSnapshot({ ...ecology, githubId: 200 }, undefined, undefined, db)).toBe(true)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db, 200)).toBe(true)
  })

  it('a repository observed under a new name within the hour records its first row there', () => {
    observeAs(100)
    expect(recordSnapshot({ ...ecology, githubId: 100 }, undefined, undefined, db)).toBe(true)
    expect(recordDeclarationIfChanged(NAME, declaration, true, db, 100)).toBe(true)

    const renamed = 'orchard/beta'
    upsertRepository(
      { fullName: renamed, htmlUrl: `https://github.com/${renamed}`, defaultBranch: 'main', githubId: 100 },
      db,
    )
    expect(
      recordSnapshot({ ...ecology, fullName: renamed, githubId: 100 }, undefined, undefined, db),
    ).toBe(true)
    expect(recordDeclarationIfChanged(renamed, declaration, true, db, 100)).toBe(true)
    // Still one identity, now with history under both names.
    expect(getSnapshotHistoryForIdentity(100, {}, db).map((r) => r.fullName)).toEqual([
      renamed,
      NAME,
    ])
  })

  it('historical rows without an id still resolve through bindings alongside id rows', () => {
    // A pre-row-identity row under the name, adopted by the binding on first observation.
    db.insert(repositories)
      .values({
        fullName: NAME,
        htmlUrl: `https://github.com/${NAME}`,
        defaultBranch: 'main',
        lastObservedAt: '2025-01-01T00:00:00.000Z',
      })
      .run()
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    db.insert(ecologySnapshots)
      .values({ fullName: NAME, observedAt: thirtyDaysAgo, classified: true })
      .run()
    observeAs(100)
    recordSnapshot({ ...ecology, githubId: 100 }, undefined, undefined, db)
    const rows = getSnapshotHistoryForIdentity(100, {}, db)
    expect(rows.map((r) => r.githubId)).toEqual([100, null])
    const windows = getPortfolioCalendarWindow(
      [{ fullName: NAME, githubId: 100 }],
      new Date().toISOString().slice(0, 10),
      60,
      db,
    )
    expect(windows.get(NAME)?.filter((s) => s.snapshot !== undefined).length).toBe(2)
  })
})

describe('migration 0005 on a populated 0004-shaped database', () => {
  const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../drizzle')

  it('adds nullable github_id to both history tables and leaves rows intact', () => {
    const sqlite = new Database(':memory:')
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const apply = (file: string) => {
      for (const statement of readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8').split(
        '--> statement-breakpoint',
      )) {
        if (statement.trim()) sqlite.exec(statement)
      }
    }
    for (const file of files) {
      if (file.startsWith('0005')) break
      apply(file)
    }
    sqlite
      .prepare(
        `INSERT INTO repositories (full_name, html_url, default_branch, last_observed_at) VALUES (?, ?, ?, ?)`,
      )
      .run('orchard/alpha', 'https://github.com/orchard/alpha', 'main', '2025-01-01T00:00:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO ecology_snapshots (full_name, observed_at, classified) VALUES (?, ?, 1)`,
      )
      .run('orchard/alpha', '2025-01-01T12:00:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO declaration_changes (full_name, observed_at, classified) VALUES (?, ?, 1)`,
      )
      .run('orchard/alpha', '2025-01-01T12:00:00.000Z')

    apply(files.find((f) => f.startsWith('0005')) as string)

    const snapshotCols = sqlite.prepare(`PRAGMA table_info(ecology_snapshots)`).all() as Array<{
      name: string
    }>
    const declarationCols = sqlite
      .prepare(`PRAGMA table_info(declaration_changes)`)
      .all() as Array<{ name: string }>
    expect(snapshotCols.some((c) => c.name === 'github_id')).toBe(true)
    expect(declarationCols.some((c) => c.name === 'github_id')).toBe(true)
    expect(
      sqlite.prepare(`SELECT github_id FROM ecology_snapshots`).all(),
    ).toEqual([{ github_id: null }])
    expect(
      sqlite.prepare(`SELECT github_id FROM declaration_changes`).all(),
    ).toEqual([{ github_id: null }])
  })
})
