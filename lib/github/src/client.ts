import type { GitHubAnswer, GitHubFailure, GitHubRepo, GitHubViewer } from './types'

const GITHUB_API = 'https://api.github.com'

function headersFor(token: string, accept = 'application/vnd.github+json') {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
  }
}

function toRepo(r: GitHubRepo): GitHubRepo {
  return {
    id: r.id,
    full_name: r.full_name,
    html_url: r.html_url,
    default_branch: r.default_branch,
    pushed_at: r.pushed_at,
    size: r.size,
    created_at: r.created_at ?? null,
  }
}

/**
 * Whether a 403 is GitHub throttling the caller rather than deciding about
 * the request: the primary quota is exhausted, a secondary limit set a
 * `retry-after`, or — secondary limits may carry neither header — the
 * message says so.
 */
async function isThrottle(response: Response): Promise<boolean> {
  if (response.headers.get('x-ratelimit-remaining') === '0') return true
  if (response.headers.get('retry-after') !== null) return true
  try {
    return /rate limit/i.test(await response.clone().text())
  } catch {
    return false
  }
}

/** Classify a non-2xx response. Exported for tests; callers use the fetch functions. */
export async function failureOf(response: Response): Promise<GitHubFailure> {
  const { status } = response
  if (status === 401) return { kind: 'unauthorized', status }
  if (status === 404) return { kind: 'not_found', status }
  if (status === 429 || (status === 403 && (await isThrottle(response)))) {
    const retryAfter = response.headers.get('retry-after')
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
    return {
      kind: 'throttled',
      status,
      retryAfterSeconds: Number.isFinite(seconds) ? seconds : undefined,
    }
  }
  if (status === 403) return { kind: 'forbidden', status }
  return { kind: 'unavailable', status }
}

/** Perform one request and turn whatever happened into an answer. */
async function answer<T>(
  request: () => Promise<Response>,
  read: (response: Response) => Promise<T>,
): Promise<GitHubAnswer<T>> {
  let response: Response
  try {
    response = await request()
  } catch (err) {
    return { kind: 'unreachable', message: err instanceof Error ? err.message : String(err) }
  }
  if (!response.ok) return failureOf(response)
  try {
    return { kind: 'ok', status: response.status, value: await read(response) }
  } catch {
    // A 2xx whose body cannot be read or parsed is an answer that could
    // not be used, not an observation.
    return { kind: 'unavailable', status: response.status }
  }
}

/** The authenticated user behind the token. */
export function fetchViewer(token: string): Promise<GitHubAnswer<GitHubViewer>> {
  return answer(
    () => fetch(`${GITHUB_API}/user`, { headers: headersFor(token) }),
    async (response) => {
      const user = await response.json()
      if (typeof user?.login !== 'string' || typeof user?.id !== 'number') {
        throw new Error('viewer payload is not a user')
      }
      return { login: user.login, id: user.id }
    },
  )
}

/** Readers validate the shape they rely on; anything else is an unusable answer. */
function asRepo(r: unknown): GitHubRepo {
  const candidate = r as Partial<GitHubRepo> | null
  if (
    typeof candidate?.id !== 'number' ||
    typeof candidate.full_name !== 'string' ||
    typeof candidate.html_url !== 'string' ||
    typeof candidate.default_branch !== 'string'
  ) {
    throw new Error('repository payload is not a repository')
  }
  return toRepo(candidate as GitHubRepo)
}

/**
 * All repositories accessible to the authenticated user, every page. The
 * first page that fails is the answer: a partial listing is never returned
 * as if it were the portfolio.
 */
export async function fetchUserRepos(token: string): Promise<GitHubAnswer<GitHubRepo[]>> {
  const repos: GitHubRepo[] = []
  let page = 1
  const perPage = 100
  let status = 200

  while (true) {
    const pageAnswer = await answer(
      () =>
        fetch(
          `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
          { headers: headersFor(token) },
        ),
      async (response) => {
        const data: unknown = await response.json()
        if (!Array.isArray(data)) throw new Error('repository listing is not an array')
        return data.map(asRepo)
      },
    )
    if (pageAnswer.kind !== 'ok') return pageAnswer

    status = pageAnswer.status
    const data = pageAnswer.value
    if (data.length === 0) break
    repos.push(...data)
    if (data.length < perPage) break
    page++
  }

  return { kind: 'ok', status, value: repos }
}

/**
 * A single repository by full name (owner/name).
 *
 * GitHub answers a renamed or transferred repository with a redirect that
 * `fetch` follows, so the returned repo may carry a different `full_name`
 * than requested — that pair is the evidence for an identity binding.
 * `not_found` may mean deleted, renamed without a redirect, or simply not
 * visible to this token; callers must not treat it as deletion.
 */
export function fetchRepository(
  token: string,
  fullName: string,
): Promise<GitHubAnswer<GitHubRepo>> {
  return answer(
    () => fetch(`${GITHUB_API}/repos/${fullName}`, { headers: headersFor(token) }),
    async (response) => asRepo(await response.json()),
  )
}

/**
 * Raw `.grove.yaml` content from a repository's branch. A file that does
 * not exist is an `ok` answer carrying `undefined` — absence of a
 * declaration is an observation, not a failure.
 */
export async function fetchGroveYaml(
  token: string,
  fullName: string,
  defaultBranch: string,
): Promise<GitHubAnswer<string | undefined>> {
  const result = await answer(
    () =>
      fetch(`${GITHUB_API}/repos/${fullName}/contents/.grove.yaml?ref=${defaultBranch}`, {
        headers: headersFor(token, 'application/vnd.github.raw+json'),
      }),
    (response) => response.text(),
  )
  if (result.kind === 'not_found') return { kind: 'ok', status: 404, value: undefined }
  return result
}
