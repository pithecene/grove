import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { createDb } from '../client'
import { climateProposals, repositories, repositoryBindings } from '../schema'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../drizzle')

/** Apply migration files by hand up to (and including) `upTo`, as an older Grove would have. */
function applyUpTo(sqlite: Database.Database, upTo: string) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    for (const statement of readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) sqlite.exec(statement)
    }
    if (file.startsWith(upTo)) break
  }
}

describe('identity migrations on a populated 0002-shaped database', () => {
  it('add identity tables and columns while keeping existing rows intact', () => {
    const sqlite = new Database(':memory:')
    applyUpTo(sqlite, '0002')

    // Synthetic rows shaped like the pre-identity schema
    sqlite
      .prepare(
        `INSERT INTO repositories (full_name, html_url, default_branch, last_observed_at) VALUES (?, ?, ?, ?)`,
      )
      .run(
        'org-old/thing',
        'https://github.com/org-old/thing',
        'main',
        '2025-01-01T00:00:00.000Z',
      )
    sqlite
      .prepare(
        `INSERT INTO ecology_snapshots (full_name, observed_at, classified, phase) VALUES (?, ?, 1, ?)`,
      )
      .run('org-old/thing', '2025-01-01T12:00:00.000Z', 'expanding')
    sqlite
      .prepare(
        `INSERT INTO climate_proposals (climate, basis, trigger_type, observation, status, proposed_at, steward_id) VALUES (?, ?, ?, ?, 'active', ?, 1)`,
      )
      .run(
        'expansion',
        'sustained_core_divergence',
        'core_divergence',
        'synthetic',
        '2025-01-01T00:00:00.000Z',
      )

    // Drizzle's migrator skips what the journal says was applied; it tracks
    // that in __drizzle_migrations, which a hand-applied 0000–0002 lacks.
    // Seed the journal entries for those so only 0003 runs.
    const journal = JSON.parse(
      readFileSync(resolve(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf-8'),
    ) as { entries: Array<{ tag: string; when: number }> }
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
    )
    const insert = sqlite.prepare(
      `INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`,
    )
    for (const entry of journal.entries) {
      if (entry.tag >= '0003') continue
      const sql = readFileSync(resolve(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf-8')
      insert.run(sha256(sql), entry.when)
    }

    const db = createDb(sqlite)

    expect(db.select().from(repositories).all()).toMatchObject([
      { fullName: 'org-old/thing', githubId: null },
    ])
    expect(db.select().from(repositoryBindings).all()).toEqual([])
    expect(db.select().from(climateProposals).all()).toMatchObject([
      { climate: 'expansion', lastSupportedAt: null },
    ])
    const applied = sqlite
      .prepare(`SELECT count(*) AS n FROM __drizzle_migrations`)
      .get() as {
      n: number
    }
    expect(applied.n).toBe(journal.entries.length)
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toContain('repository_bindings')
    expect(tables).toContain('identity_resolutions')
  })
})

function sha256(text: string): string {
  // drizzle hashes the migration file content to detect what was applied
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(text).digest('hex')
}
