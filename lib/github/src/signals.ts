import type { StructuralSignals } from '@grove/core'

const GITHUB_API = 'https://api.github.com'

/** Known dependency manifest filenames */
const KNOWN_MANIFESTS = new Set([
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
])

/**
 * Fetch structural signals from GitHub for a single repository.
 * Uses Git Trees API and Commit Activity Stats API.
 * Partial signals are always valid — absence is not an error.
 */
export async function fetchStructuralSignals(
  token: string,
  fullName: string,
  defaultBranch: string,
  ecosystemRepoNames?: string[],
): Promise<StructuralSignals> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  }

  const observedAt = new Date().toISOString()

  // Parallel API calls — partial results always valid
  const [treeResult, commitResult] = await Promise.allSettled([
    fetchTreeSignals(fullName, defaultBranch, headers),
    fetchCommitSignals(fullName, headers),
  ])

  const tree =
    treeResult.status === 'fulfilled' ? treeResult.value : undefined
  const commits =
    commitResult.status === 'fulfilled' ? commitResult.value : undefined

  // Entanglement: inspect root package.json if tree found one
  let ecosystemDependencyCount: number | undefined
  if (tree?.hasRootPackageJson && ecosystemRepoNames?.length) {
    ecosystemDependencyCount = await fetchEcosystemDependencyCount(
      fullName,
      defaultBranch,
      headers,
      ecosystemRepoNames,
    )
  }

  return {
    fileCount: tree?.fileCount,
    commitsLast30d: commits?.commitsLast30d,
    commitsLast90d: commits?.commitsLast90d,
    dependencyManifestsObserved: tree?.manifests,
    ecosystemDependencyCount,
    readmePresent: tree?.readmePresent,
    contributingPresent: tree?.contributingPresent,
    licensePresent: tree?.licensePresent,
    docsDirectoryPresent: tree?.docsDirectoryPresent,
    ciConfigPresent: tree?.ciConfigPresent,
    testDirectoryPresent: tree?.testDirectoryPresent,
    testFilePatternsObserved: tree?.testFilePatternsObserved,
    observedAt,
  }
}

/** One entry of a repository tree, as GitHub's Trees API or `ls-tree -r -t` lists it. */
export interface TreeEntry {
  path: string
  /** 'blob' | 'tree' (anything else is ignored) */
  type: string
}

export interface TreeSignals {
  fileCount: number | undefined
  manifests: string[]
  hasRootPackageJson: boolean
  readmePresent: boolean | undefined
  contributingPresent: boolean | undefined
  licensePresent: boolean | undefined
  docsDirectoryPresent: boolean | undefined
  ciConfigPresent: boolean | undefined
  testDirectoryPresent: boolean | undefined
  testFilePatternsObserved: boolean | undefined
}

async function fetchTreeSignals(
  fullName: string,
  defaultBranch: string,
  headers: Record<string, string>,
): Promise<TreeSignals> {
  const response = await fetch(
    `${GITHUB_API}/repos/${fullName}/git/trees/${defaultBranch}?recursive=1`,
    { headers },
  )

  if (!response.ok) {
    throw new Error(`Tree API: ${response.status}`)
  }

  const data = await response.json()
  const tree: TreeEntry[] = data.tree ?? []

  // GitHub truncates recursive trees for very large repos.
  return classifyTree(tree, data.truncated === true)
}

/**
 * Classify a repository tree: file count, dependency manifests, documentation,
 * CI and test artifacts. One definition for every method of observation —
 * the live tree fetch and a tree read from the repository's own history
 * must agree on what the same tree means.
 *
 * When the listing is truncated, only positive observations are reliable:
 * absence cannot be confirmed, so undetected signals are `undefined`
 * (not observed) rather than `false` (observed as absent), and the file
 * count is dropped rather than presented as complete.
 */
export function classifyTree(tree: ReadonlyArray<TreeEntry>, truncated = false): TreeSignals {
  let fileCount = 0
  const manifests: string[] = []
  let hasRootPackageJson = false
  let readmePresent = false
  let contributingPresent = false
  let licensePresent = false
  let docsDirectoryPresent = false
  let ciConfigPresent = false
  let testDirectoryPresent = false
  let testFilePatternsObserved = false

  for (const entry of tree) {
    if (entry.type === 'blob') {
      fileCount++

      // Extract the filename (last segment of path)
      const baseName = entry.path.split('/').pop() ?? entry.path
      const isRootLevel = !entry.path.includes('/')

      // Detect manifests at any depth — a go.mod implies Go toolchain
      // whether it lives at root or in a monorepo subdirectory.
      // Deduplicate by manifest name (only record each type once).
      if (KNOWN_MANIFESTS.has(baseName) && !manifests.includes(baseName)) {
        manifests.push(baseName)
      }
      if (isRootLevel && baseName === 'package.json') {
        hasRootPackageJson = true
      }

      // Documentation artifacts (root-level, case-insensitive)
      if (isRootLevel) {
        const lower = baseName.toLowerCase()
        if (lower.startsWith('readme')) readmePresent = true
        if (lower.startsWith('contributing')) contributingPresent = true
        if (lower.startsWith('license') || lower === 'licence' || lower === 'licence.md') {
          licensePresent = true
        }
      }

      // CI config files (any depth)
      const path = entry.path.toLowerCase()
      if (
        path.startsWith('.github/workflows/') ||
        path === '.gitlab-ci.yml' ||
        path === '.travis.yml' ||
        path === 'jenkinsfile' ||
        path === '.circleci/config.yml'
      ) {
        ciConfigPresent = true
      }

      // Co-located test file patterns (any depth)
      if (!testFilePatternsObserved) {
        const lowerBase = baseName.toLowerCase()
        if (
          lowerBase.endsWith('_test.go') ||               // Go
          lowerBase.endsWith('.test.ts') ||                // TypeScript
          lowerBase.endsWith('.test.js') ||                // JavaScript
          lowerBase.endsWith('.test.tsx') ||               // React/TSX
          lowerBase.endsWith('.test.jsx') ||               // React/JSX
          lowerBase.endsWith('.spec.ts') ||                // TypeScript spec
          lowerBase.endsWith('.spec.js') ||                // JavaScript spec
          lowerBase.endsWith('.spec.tsx') ||               // React/TSX spec
          lowerBase.endsWith('.spec.jsx') ||               // React/JSX spec
          lowerBase.endsWith('_test.py') ||                // Python (suffix)
          (lowerBase.startsWith('test_') && lowerBase.endsWith('.py')) || // Python (prefix)
          lowerBase.endsWith('_test.rs')                   // Rust
        ) {
          testFilePatternsObserved = true
        }
      }
    }

    // Directory-level checks (trees + blobs under known paths)
    const topDir = entry.path.split('/')[0]?.toLowerCase()
    if (topDir === 'docs' || topDir === 'doc' || topDir === 'documentation') {
      docsDirectoryPresent = true
    }
    if (
      topDir === 'test' ||
      topDir === 'tests' ||
      topDir === '__tests__' ||
      topDir === 'spec' ||
      topDir === 'specs'
    ) {
      testDirectoryPresent = true
    }
  }

  const guard = (observed: boolean): boolean | undefined =>
    truncated ? (observed || undefined) : observed

  return {
    fileCount: truncated ? undefined : fileCount,
    manifests,
    hasRootPackageJson,
    readmePresent: guard(readmePresent),
    contributingPresent: guard(contributingPresent),
    licensePresent: guard(licensePresent),
    docsDirectoryPresent: guard(docsDirectoryPresent),
    ciConfigPresent: guard(ciConfigPresent),
    testDirectoryPresent: guard(testDirectoryPresent),
    testFilePatternsObserved: guard(testFilePatternsObserved),
  }
}

interface CommitSignals {
  commitsLast30d: number
  commitsLast90d: number
}

async function fetchCommitSignals(
  fullName: string,
  headers: Record<string, string>,
): Promise<CommitSignals | undefined> {
  const response = await fetch(
    `${GITHUB_API}/repos/${fullName}/stats/commit_activity`,
    { headers },
  )

  // 202 means GitHub is computing stats — not yet available
  if (response.status === 202) {
    return undefined
  }

  if (!response.ok) {
    throw new Error(`Commit stats API: ${response.status}`)
  }

  const weeks: Array<{ total: number }> = await response.json()

  if (!Array.isArray(weeks) || weeks.length === 0) {
    return undefined
  }

  // weeks is 52 entries, most recent last
  // ~4 weeks ≈ 30 days, ~13 weeks ≈ 90 days
  const last4 = weeks.slice(-4)
  const last13 = weeks.slice(-13)

  const commitsLast30d = last4.reduce((sum, w) => sum + w.total, 0)
  const commitsLast90d = last13.reduce((sum, w) => sum + w.total, 0)

  return { commitsLast30d, commitsLast90d }
}

/**
 * Count dependencies of a root `package.json` whose short name matches a
 * repository of the ecosystem (e.g. "justapithecus/lode" → "lode"). Pure:
 * the same definition serves the live fetch and history.
 */
export function countEcosystemDependencies(
  packageJsonText: string,
  ecosystemRepoNames: ReadonlyArray<string>,
): number | undefined {
  try {
    const pkg = JSON.parse(packageJsonText)

    // Collect all dependency names
    const allDeps = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ])

    const ecosystemShortNames = new Set(
      ecosystemRepoNames.map((name) => {
        const parts = name.split('/')
        return (parts[parts.length - 1] ?? name).toLowerCase()
      }),
    )

    let count = 0
    for (const dep of allDeps) {
      // "@scope/pkg" → "pkg", "some-lib" → "some-lib"
      const depShortName = dep.includes('/')
        ? (dep.split('/').pop() ?? dep).toLowerCase()
        : dep.toLowerCase()

      if (ecosystemShortNames.has(depShortName)) {
        count++
      }
    }

    return count
  } catch {
    return undefined
  }
}

async function fetchEcosystemDependencyCount(
  fullName: string,
  defaultBranch: string,
  headers: Record<string, string>,
  ecosystemRepoNames: string[],
): Promise<number | undefined> {
  try {
    const response = await fetch(
      `${GITHUB_API}/repos/${fullName}/contents/package.json?ref=${defaultBranch}`,
      {
        headers: {
          ...headers,
          Accept: 'application/vnd.github.raw+json',
        },
      },
    )

    if (!response.ok) return undefined

    return countEcosystemDependencies(await response.text(), ecosystemRepoNames)
  } catch {
    return undefined
  }
}
