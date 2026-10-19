export { classifyRepository } from './classify'
export {
  failureOf,
  fetchGroveYaml,
  fetchRepository,
  fetchUserRepos,
  fetchViewer,
} from './client'
export {
  classifyTree,
  countEcosystemDependencies,
  fetchStructuralSignals,
  type TreeEntry,
  type TreeSignals,
} from './signals'
export type { GitHubAnswer, GitHubFailure, GitHubRepo, GitHubViewer } from './types'
