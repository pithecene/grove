/**
 * Observe the configured portfolio once — an explicit act with a record.
 *
 *   pnpm --filter @grove/app collect
 *
 * Reads GROVE_GITHUB_TOKEN, GROVE_SCOPE_* and GROVE_DB_PATH (default
 * data/grove.db, relative to app/). Same pipeline and same hourly snapshot
 * throttle as a page visit; the run and what it did about each repository
 * are recorded. Never prints the token. No scheduler is implied.
 *
 * Exit status: 0 complete; 1 run recorded but incomplete; 2 nothing attempted.
 */
import { resolve } from 'node:path'

import { getDb, getRun, getRunRepositories } from '../src/server/db'
import { resolveStewardIdentity } from '../src/server/identity'
import { observePortfolio } from '../src/server/observe'
import { parseScope } from '../src/server/scope'

const dbPath = resolve(process.env.GROVE_DB_PATH ?? 'data/grove.db')
console.log(`database: ${dbPath}`)
const scope = parseScope()
console.log(
  scope
    ? `scope: owners [${[...scope.owners].join(', ')}] exclude [${[...scope.exclude].join(', ')}]`
    : 'scope: none configured (every reachable repository)',
)

const resolution = await resolveStewardIdentity()
if (resolution.kind === 'unavailable') {
  console.error(`no steward identity (${resolution.reason}); nothing attempted.`)
  process.exit(2)
}
console.log(`steward: ${resolution.identity.login}`)

const db = getDb()
const { lookup, runId } = await observePortfolio(resolution.identity, { method: 'cli', db })
const run = getRun(runId, db)
const rows = getRunRepositories(runId, db)

const pad = (s: string, n: number) => s.padEnd(n)
console.log('')
console.log(`${pad('repository', 40)} ${pad('outcome', 12)} answer`)
for (const r of rows) {
  console.log(`${pad(r.fullName, 40)} ${pad(r.outcome, 12)} ${r.answer ?? ''}`)
}
const counts = new Map<string, number>()
for (const r of rows) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1)
console.log('')
console.log(
  `run ${runId} (${run?.method}): ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ') || 'no repositories'}; ${run?.complete ? 'complete' : 'incomplete'}${run?.answer ? ` (${run.answer})` : ''}`,
)
// Exit status: 0 when the whole scope received an outcome, 1 when the run
// is recorded but incomplete (GitHub gave no usable answer somewhere),
// 2 when nothing could be attempted (no identity, above).
if (lookup.kind !== 'observed') {
  const subject = 'subject' in lookup ? ` about ${lookup.subject}` : ''
  console.log(`nothing observed this run: ${lookup.kind}${subject}`)
  process.exit(1)
}
