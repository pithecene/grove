import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { fetchRepository, type TreeEntry } from '@grove/github'

import type { HistoryCommit, HistorySource } from './source'

/**
 * Open the history of an identity after confirming that the name still
 * denotes it: a deleted name reused by another repository would otherwise
 * be fetched under this id and its history silently attributed to the
 * wrong repository (`docs/designs/identity.md` §2). GitHub's answer also
 * supplies the current name (redirects followed) and default branch.
 */
export async function openIdentityHistory(options: GitHistoryOptions): Promise<GitHistorySource> {
  const answer = await fetchRepository(options.token, options.fullName)
  if (answer.kind !== 'ok') {
    throw new Error(`GitHub gave no repository for ${options.fullName}: ${answer.kind}`)
  }
  if (answer.value.id !== options.githubId) {
    throw new Error(
      `${options.fullName} now denotes repository ${answer.value.id}, not ${options.githubId}; history not read`,
    )
  }
  return GitHistorySource.open({
    ...options,
    fullName: answer.value.full_name,
    defaultBranch: answer.value.default_branch,
  })
}

const exec = promisify(execFile)

/** Replace every occurrence of `secret` in a message with a marker. */
export function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.split(secret).join('<redacted>')
}

export interface GitHistoryOptions {
  /** Directory holding one bare, blobless clone per identity */
  cacheDir: string
  githubId: number
  fullName: string
  defaultBranch: string
  /** Used only as a request header for clone and fetch; never written to disk, printed, or passed as an argument */
  token: string
}

/**
 * A repository's history read from a bare, blobless clone kept under
 * `cacheDir/<github_id>`. Read-only against GitHub (`CONTRACT_READ_ONLY`):
 * the clone is fetched, never pushed.
 *
 * The credential reaches git as an `http.extraheader` supplied through
 * git's configuration environment (`GIT_CONFIG_*`), so it is neither an
 * argument visible in process listings nor stored in the clone; any git
 * failure is rethrown with the secret removed from its message.
 */
export class GitHistorySource implements HistorySource {
  private readonly dir: string
  private readonly branch: string
  private readonly secret: string
  private readonly env: NodeJS.ProcessEnv

  private constructor(options: GitHistoryOptions) {
    this.dir = join(options.cacheDir, String(options.githubId))
    this.branch = options.defaultBranch
    // GitHub's git-over-HTTPS takes a token as basic-auth credentials
    // (any user name, the token as password).
    this.secret = Buffer.from(`x-access-token:${options.token}`).toString('base64')
    this.env = {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${this.secret}`,
      GIT_TERMINAL_PROMPT: '0',
    }
  }

  /**
   * Clone on first use, fetch on later ones. The cache is keyed by the
   * immutable id, so the remote is re-pointed at the identity's *current*
   * name before every fetch: a former name may since denote another
   * repository, whose history must never land under this id. A repository
   * with no commits on its default branch is an empty history, not an
   * unavailable one.
   */
  static async open(options: GitHistoryOptions): Promise<GitHistorySource> {
    const source = new GitHistorySource(options)
    mkdirSync(options.cacheDir, { recursive: true })
    const url = `https://github.com/${options.fullName}.git`
    if (existsSync(source.dir)) {
      await source.git(['remote', 'set-url', 'origin', url])
      await source.git([
        'fetch',
        '--quiet',
        'origin',
        `+refs/heads/${options.defaultBranch}:refs/heads/${options.defaultBranch}`,
      ]).catch(async (err) => {
        if (await source.remoteHasBranch(url)) throw err
        // Nothing on the branch (an empty repository): keep the cache, no commits.
      })
    } else {
      try {
        await source.run([
          'clone',
          '--quiet',
          '--bare',
          '--filter=blob:none',
          '--single-branch',
          '--branch',
          options.defaultBranch,
          url,
          source.dir,
        ])
      } catch (err) {
        if (await source.remoteHasBranch(url)) throw err
        // The repository exists but has no commits on its default branch:
        // an empty bare clone represents it, with no history to read.
        await source.run(['init', '--quiet', '--bare', source.dir])
        await source.git(['remote', 'add', 'origin', url])
      }
    }
    return source
  }

  /** Whether the remote currently has the default branch at all (false for an empty repository). */
  private async remoteHasBranch(url: string): Promise<boolean> {
    const out = await this.run(['ls-remote', '--heads', url, this.branch])
    return out.trim().length > 0
  }

  /** Whether the cached clone has the branch (false while the repository is empty). */
  private async hasBranch(): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${this.branch}`])
      return true
    } catch {
      return false
    }
  }

  /** Run git with the credential in the environment; failures are redacted. */
  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec('git', args, { env: this.env, maxBuffer: 64 * 1024 * 1024 })
      return stdout
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(redactSecret(message, this.secret))
    }
  }

  private git(args: string[]): Promise<string> {
    return this.run(['-C', this.dir, ...args])
  }

  private parseCommits(out: string): HistoryCommit[] {
    return out
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, committedAt] = line.split('\u001f')
        return { sha: sha ?? '', committedAt: new Date(committedAt ?? '').toISOString() }
      })
  }

  async firstParentCommits(): Promise<HistoryCommit[]> {
    if (!(await this.hasBranch())) return []
    return this.parseCommits(
      await this.git(['log', '--first-parent', '--reverse', '--format=%H%x1f%cI', this.branch]),
    )
  }

  async commitsTouching(path: string): Promise<HistoryCommit[]> {
    if (!(await this.hasBranch())) return []
    return this.parseCommits(
      await this.git([
        'log',
        '--first-parent',
        '--reverse',
        '--format=%H%x1f%cI',
        this.branch,
        '--',
        path,
      ]),
    )
  }

  async treeAt(sha: string): Promise<TreeEntry[]> {
    const out = await this.git(['ls-tree', '-r', '-t', sha])
    const entries: TreeEntry[] = []
    for (const line of out.split('\n')) {
      if (!line) continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const [, type] = line.slice(0, tab).split(' ')
      entries.push({ path: line.slice(tab + 1), type: type ?? '' })
    }
    return entries
  }

  async fileAt(sha: string, path: string): Promise<string | undefined> {
    try {
      return await this.git(['show', `${sha}:${path}`])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/does not exist|exists on disk, but not in|not in the index|is in commit .* but not/i.test(message)) {
        return undefined
      }
      throw err
    }
  }
}
