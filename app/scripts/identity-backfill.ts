/**
 * Attach identity bindings to historical repository names.
 *
 *   pnpm --filter @grove/app identity:backfill            # dry run: resolve and report, write nothing
 *   pnpm --filter @grove/app identity:backfill -- --apply # write bindings and resolutions
 *
 * Reads GROVE_DB_PATH (default data/grove.db, relative to app/) and
 * GROVE_GITHUB_TOKEN. Run against a copy first. Never prints the token.
 */
import { resolve } from 'node:path'

import { resolveRepositoryByName } from '@grove/github'

import { getDb } from '../src/server/db'
import { backfillIdentities } from '../src/server/identity-backfill'
import { parseScope } from '../src/server/scope'

const apply = process.argv.includes('--apply')
const token = process.env.GROVE_GITHUB_TOKEN

if (!token) {
  console.error('GROVE_GITHUB_TOKEN is not set; historical names cannot be resolved.')
  process.exit(2)
}

const dbPath = resolve(process.env.GROVE_DB_PATH ?? 'data/grove.db')
console.log(`database: ${dbPath}`)
console.log(apply ? 'mode: apply' : 'mode: dry run (nothing will be written)')
const scope = parseScope()
console.log(
  scope
    ? `scope: owners [${[...scope.owners].join(', ')}] exclude [${[...scope.exclude].join(', ')}]`
    : 'scope: none configured (every reachable repository)',
)

const db = getDb()
const report = await backfillIdentities(
  db,
  (name) => resolveRepositoryByName(token, name),
  { apply, scope },
)

const pad = (s: string, n: number) => s.padEnd(n)
console.log('')
console.log(`${pad('name', 40)} ${pad('outcome', 14)} ${pad('id', 12)} resolves to`)
for (const e of report.entries) {
  const detail =
    e.resolvedFullName && e.resolvedFullName !== e.fullName
      ? `${e.resolvedFullName}`
      : (e.resolvedFullName ?? (e.httpStatus ? `http ${e.httpStatus}` : ''))
  const span = e.boundSpan
    ? `  bound ${e.boundSpan.first.slice(0, 10)}..${e.boundSpan.last.slice(0, 10)}`
    : ''
  const unbound = e.unboundSpan
    ? `  unbound ${e.unboundSpan.first.slice(0, 10)}..${e.unboundSpan.last.slice(0, 10)}`
    : ''
  console.log(
    `${pad(e.fullName, 40)} ${pad(e.outcome, 14)} ${pad(e.githubId ? String(e.githubId) : '', 12)} ${detail}${span}${unbound}`,
  )
}

const counts = new Map<string, number>()
for (const e of report.entries) counts.set(e.outcome, (counts.get(e.outcome) ?? 0) + 1)
console.log('')
console.log(
  `names processed: ${report.entries.length}; ` +
    [...counts.entries()].map(([k, v]) => `${k}: ${v}`).join(', '),
)
console.log(
  apply
    ? `bindings inserted: ${report.bindingsInserted}`
    : 'dry run — no bindings or resolutions were written',
)
