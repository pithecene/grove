import type { GitHubRepo } from './types'

const GITHUB_API = 'https://api.github.com'

/**
 * Fetch all repositories accessible to the authenticated user.
 * Paginates through all pages.
 */
export async function fetchUserRepos(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = []
  let page = 1
  const perPage = 100

  while (true) {
    const response = await fetch(
      `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    )

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`,
      )
    }

    const data: GitHubRepo[] = await response.json()
    if (data.length === 0) break

    repos.push(
      ...data.map((r) => ({
        full_name: r.full_name,
        html_url: r.html_url,
        default_branch: r.default_branch,
        pushed_at: r.pushed_at,
        size: r.size,
      })),
    )

    if (data.length < perPage) break
    page++
  }

  return repos
}

/**
 * Fetch a single repository by full name (owner/name).
 */
/**
 * Whether a non-2xx response is GitHub throttling the caller rather than
 * answering about the request: 429, or 403 with the primary quota exhausted
 * (`x-ratelimit-remaining: 0`) or a secondary limit (`retry-after`).
 */
export function isRateLimitResponse(status: number, headers: Headers): boolean {
  if (status === 429) return true
  if (status !== 403) return false
  return (
    headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null
  )
}

/** A non-2xx answer from the GitHub API, with what callers need to map it. */
export class GitHubApiError extends Error {
  readonly status: number
  /** The answer is throttling, not a decision about the request */
  readonly rateLimited: boolean
  constructor(status: number, statusText: string, rateLimited = false) {
    super(`GitHub API error: ${status} ${statusText}`)
    this.name = 'GitHubApiError'
    this.status = status
    this.rateLimited = rateLimited
  }
}

export async function fetchRepository(
  token: string,
  fullName: string,
): Promise<GitHubRepo> {
  const response = await fetch(`${GITHUB_API}/repos/${fullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  })

  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      response.statusText,
      isRateLimitResponse(response.status, response.headers),
    )
  }

  const r: GitHubRepo = await response.json()
  return {
    full_name: r.full_name,
    html_url: r.html_url,
    default_branch: r.default_branch,
    pushed_at: r.pushed_at,
    size: r.size,
  }
}

/**
 * Fetch raw .grove.yaml content from a repository.
 * Returns undefined if the file does not exist (404).
 */
export async function fetchGroveYaml(
  token: string,
  fullName: string,
  defaultBranch: string,
): Promise<string | undefined> {
  const response = await fetch(
    `${GITHUB_API}/repos/${fullName}/contents/.grove.yaml?ref=${defaultBranch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
      },
    },
  )

  if (response.status === 404) return undefined

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    )
  }

  return response.text()
}
