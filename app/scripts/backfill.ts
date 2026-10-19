/**
 * Reconstruct the daily series from each repository's own commit history.
 *
 *   pnpm --filter @grove/app backfill -- --from 2026-04-01            # dry run: plan and report, write nothing
 *   pnpm --filter @grove/app backfill -- --from 2026-04-01 --apply    # write history rows
 *   pnpm --filter @grove/app backfill -- --from 2026-04-01 --to 2026-10-17 --names org/a,org/b
 *
 * Reads GROVE_GITHUB_TOKEN, GROVE_SCOPE_*, GROVE_DB_PATH (default data/grove.db)
 * and GROVE_GIT_CACHE (default data/git-cache; one bare blobless clone per
 * identity). `--to` defaults to, and may not exceed, the previous UTC day.
 * Run against a copy first. Never prints the token.
 *
 * Exit status: 0 done; 1 a target's history was unavailable; 2 nothing attempted.
 */
import { resolve } from 'node:path'

import { backfillHistory, DIVERGENCES, lastBackfillDay } from '../src/server/backfill'
import { getDb } from '../src/server/db'
import { openIdentityHistory } from '../src/server/history/git'
import { parseScope } from '../src/server/scope'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const apply = process.argv.includes('--apply')
const from = arg('from')
const to = arg('to')
const names = arg('names')?.split(',').map((s) => s.trim()).filter(Boolean)
const token = process.env.GROVE_GITHUB_TOKEN

if (!token) {
  console.error('GROVE_GITHUB_TOKEN is not set; history cannot be fetched.')
  process.exit(2)
}
/** A real UTC calendar day in YYYY-MM-DD form (2025-02-31 is not). */
function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.toISOString().slice(0, 10) === value
}
if (!from || !isCalendarDay(from)) {
  console.error('--from YYYY-MM-DD (a real calendar day) is required.')
  process.exit(2)
}
if (to && !isCalendarDay(to)) {
  console.error('--to must be a real calendar day in YYYY-MM-DD form.')
  process.exit(2)
}
const latest = lastBackfillDay(new Date())
if (to && to > latest) {
  console.error(`--to may not be later than ${latest} (the current day is never backfilled).`)
  process.exit(2)
}
if (to && to < from) {
  console.error('--to is earlier than --from; nothing to do.')
  process.exit(2)
}

const dbPath = resolve(process.env.GROVE_DB_PATH ?? 'data/grove.db')
const cacheDir = resolve(process.env.GROVE_GIT_CACHE ?? 'data/git-cache')
console.log(`database: ${dbPath}`)
console.log(`history cache: ${cacheDir}`)
console.log(apply ? 'mode: apply' : 'mode: dry run (nothing will be written)')
console.log(`range: ${from} .. ${to ?? latest}`)
const scope = parseScope()
console.log(
  scope
    ? `scope: owners [${[...scope.owners].join(', ')}] exclude [${[...scope.exclude].join(', ')}]`
    : 'scope: none configured (every repository with an identity)',
)
console.log('divergences from live observation, recorded on every row:')
for (const d of DIVERGENCES) console.log(`  - ${d}`)

const db = getDb()
const report = await backfillHistory(db, {
  from,
  to,
  names,
  apply,
  scope,
  sourceFor: (target) =>
    openIdentityHistory({
      cacheDir,
      githubId: target.githubId,
      fullName: target.fullName,
      defaultBranch: target.defaultBranch,
      token,
    }),
})

const pad = (s: string, n: number) => s.padEnd(n)
console.log('')
console.log(
  `${pad('repository', 36)} ${pad('to fill', 8)} ${pad('tree', 6)} ${pad('empty', 6)} ${pad('pre', 5)} ${pad('unkn', 5)} ${pad('decl', 5)} commits`,
)
for (const e of report.entries) {
  console.log(
    `${pad(e.fullName, 36)} ${pad(String(e.daysToFill), 8)} ${pad(String(e.daysFromTree), 6)} ${pad(String(e.daysEmpty), 6)} ${pad(String(e.daysBeforeCreation), 5)} ${pad(String(e.daysUnknown), 5)} ${pad(String(e.declarations), 5)} ${e.commitsInRange}${e.message ? `  ${e.message}` : ''}`,
  )
}
const totalDays = report.entries.reduce((n, e) => n + e.daysToFill, 0)
const totalDecl = report.entries.reduce((n, e) => n + e.declarations, 0)
console.log('')
console.log(
  `${apply ? 'written' : 'would write'}: ${totalDays} day rows, ${totalDecl} declaration rows across ${report.entries.length} repositories${report.runId !== undefined ? ` (run ${report.runId})` : ''}`,
)
if (report.entries.length === 0) {
  console.log('nothing attempted: no repository in scope matched, or the range is empty.')
  process.exit(2)
}
if (report.entries.some((e) => e.message)) process.exit(1)
