// Minimal GitHub repository type — only what Grove needs
export interface GitHubRepo {
  /** Immutable numeric repository id — survives renames and transfers */
  id: number
  full_name: string
  html_url: string
  default_branch: string
  pushed_at: string | null
  size?: number // KB, from GitHub API
  /** Creation time (ISO 8601) — evidence that observations predating it belong to a different identity */
  created_at?: string | null
}

/**
 * Outcome of resolving a repository name against the GitHub API.
 * GitHub follows renames/transfers with a redirect, so a resolved result
 * may carry a different `full_name` than the one asked for.
 */
export type RepositoryResolution =
  | {
      outcome: 'resolved'
      status: number
      repo: GitHubRepo
    }
  | {
      /** Deleted, renamed without redirect, or not visible to this token — indistinguishable from outside */
      outcome: 'not_found'
      status: 404
    }
  | {
      outcome: 'forbidden'
      status: 401 | 403
    }
  | {
      outcome: 'error'
      status: number
      message: string
    }
