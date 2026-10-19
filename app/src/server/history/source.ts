import type { TreeEntry } from '@grove/github'

/** One commit on the default branch's first-parent history. */
export interface HistoryCommit {
  sha: string
  /** Committer date, ISO 8601 */
  committedAt: string
}

/**
 * What a repository's own history can answer. Everything the backfill
 * reads comes through this boundary, so the reconstruction can be tested
 * against a fabricated history and run against a real clone unchanged.
 *
 * What it says is the *retrospective* branch state — the commits the
 * default branch now reaches, in the order their committer dates put
 * them — never when a commit joined the branch.
 */
export interface HistorySource {
  /** First-parent history of the default branch, oldest first. */
  firstParentCommits(): Promise<HistoryCommit[]>
  /** First-parent commits that changed `path`, oldest first. */
  commitsTouching(path: string): Promise<HistoryCommit[]>
  /** Every entry (blobs and trees) of the tree at `sha`. */
  treeAt(sha: string): Promise<TreeEntry[]>
  /** The file at `path` in `sha`, or undefined when it does not exist there. */
  fileAt(sha: string, path: string): Promise<string | undefined>
}
