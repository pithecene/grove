/**
 * Portfolio scope — explicit, private selection of which reachable
 * repositories Grove observes.
 *
 * Read from the environment (kept in the gitignored `.env`), never from
 * `.grove.yaml` and never hard-coded: the selection belongs to the steward's
 * deployment, not to Grove's reusable core.
 *
 * - GROVE_SCOPE_OWNERS   comma-separated owners (users/orgs) to include
 * - GROVE_SCOPE_EXCLUDE  comma-separated full names to leave out
 *
 * With neither set, every repository the token can reach is observed
 * (the pre-existing behaviour). Out-of-scope repositories are simply not
 * observed; nothing already recorded about them is touched.
 */
export interface PortfolioScope {
  owners: ReadonlySet<string>
  exclude: ReadonlySet<string>
}

type ScopeEnv = Record<string, string | undefined>

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

/** Parse the scope from environment variables; undefined when none are set. */
export function parseScope(env: ScopeEnv = process.env): PortfolioScope | undefined {
  const owners = splitList(env.GROVE_SCOPE_OWNERS)
  const exclude = splitList(env.GROVE_SCOPE_EXCLUDE)
  if (owners.length === 0 && exclude.length === 0) return undefined
  return { owners: new Set(owners), exclude: new Set(exclude) }
}

/** Whether a repository (owner/name) falls inside the scope. */
export function isWithinScope(
  fullName: string,
  scope: PortfolioScope | undefined,
): boolean {
  if (!scope) return true
  const lower = fullName.toLowerCase()
  if (scope.exclude.has(lower)) return false
  if (scope.owners.size === 0) return true
  const owner = lower.split('/')[0] ?? ''
  return scope.owners.has(owner)
}

/** Keep only repositories inside the scope, preserving order. */
export function applyScope<T extends { full_name: string }>(
  repos: T[],
  scope: PortfolioScope | undefined,
): T[] {
  if (!scope) return repos
  return repos.filter((repo) => isWithinScope(repo.full_name, scope))
}
