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

/** The authenticated user behind a token — the steward's identity. */
export interface GitHubViewer {
  login: string
  /** Immutable numeric user id — survives login changes */
  id: number
}

/**
 * What GitHub answered, decided once at this boundary.
 *
 * Every request made through this package returns one of these; nothing is
 * thrown for an answer GitHub gave, and a request that never completed is
 * an answer too (`unreachable`). Callers map kinds to what they can state —
 * they never re-derive meaning from status codes or headers.
 */
export type GitHubAnswer<T> =
  | { kind: 'ok'; status: number; value: T }
  /** 404 — missing, renamed without redirect, or not visible to this token: indistinguishable from outside */
  | { kind: 'not_found'; status: 404 }
  /** 403 that is a decision about access, not throttling */
  | { kind: 'forbidden'; status: 403 }
  /** 401 — the token was not accepted */
  | { kind: 'unauthorized'; status: 401 }
  /** 429, or a 403 that is a primary or secondary rate limit — not a decision about the request */
  | { kind: 'throttled'; status: number; retryAfterSeconds?: number }
  /** Any other non-2xx — GitHub answered but could not serve the request */
  | { kind: 'unavailable'; status: number }
  /** No answer at all — the request did not complete */
  | { kind: 'unreachable'; message: string }

/** Every answer that is not `ok`. */
export type GitHubFailure = Exclude<GitHubAnswer<never>, { kind: 'ok' }>
