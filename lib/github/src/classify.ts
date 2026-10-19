import { deriveSeason, parseGroveYaml } from '@grove/core'
import type { RepositoryEcology } from '@grove/core'

import { fetchGroveYaml } from './client'
import type { GitHubAnswer, GitHubRepo } from './types'

/**
 * Classify a single repository by fetching and parsing its .grove.yaml.
 * A missing or invalid file is an unclassified ecology (an observation);
 * a request GitHub did not answer with the file's presence or absence is
 * passed through as that answer — it is not an observation of anything.
 */
export async function classifyRepository(
  token: string,
  repo: GitHubRepo,
): Promise<GitHubAnswer<RepositoryEcology>> {
  const answer = await fetchGroveYaml(token, repo.full_name, repo.default_branch)
  if (answer.kind !== 'ok') return answer

  const raw = answer.value
  if (!raw) {
    return {
      kind: 'ok',
      status: answer.status,
      value: { fullName: repo.full_name, htmlUrl: repo.html_url, classified: false },
    }
  }

  const result = parseGroveYaml(raw)

  if (!result.ok) {
    return {
      kind: 'ok',
      status: answer.status,
      value: { fullName: repo.full_name, htmlUrl: repo.html_url, classified: false },
    }
  }

  const season = deriveSeason(result.declaration.phase)

  return {
    kind: 'ok',
    status: answer.status,
    value: {
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      declaration: result.declaration,
      season,
      classified: true,
    },
  }
}
