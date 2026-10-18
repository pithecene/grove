import type { GitHubRepo, RepositoryResolution } from './types'

const GITHUB_API = 'https://api.github.com'

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

    repos.push(...data.map(toRepo))

    if (data.length < perPage) break
    page++
  }

  return repos
}

/**
 * Fetch a single repository by full name (owner/name).
 */
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
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    )
  }

  const r: GitHubRepo = await response.json()
  return toRepo(r)
}

/**
 * Resolve a repository name to its current identity without throwing.
 *
 * GitHub answers a renamed or transferred repository with a redirect that
 * `fetch` follows, so the returned repo may carry a different `full_name`
 * than requested — that pair is the evidence for an identity binding.
 * A 404 is reported as `not_found`: it may mean deleted, renamed without a
 * redirect, or simply not visible to this token. Callers must not treat
 * it as deletion.
 */
export async function resolveRepositoryByName(
  token: string,
  fullName: string,
): Promise<RepositoryResolution> {
  let response: Response
  try {
    response = await fetch(`${GITHUB_API}/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    })
  } catch (err) {
    return { outcome: 'error', status: 0, message: String(err) }
  }

  if (response.status === 404) return { outcome: 'not_found', status: 404 }
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'forbidden', status: response.status }
  }
  if (!response.ok) {
    return {
      outcome: 'error',
      status: response.status,
      message: response.statusText,
    }
  }

  const r: GitHubRepo = await response.json()
  return { outcome: 'resolved', status: response.status, repo: toRepo(r) }
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
