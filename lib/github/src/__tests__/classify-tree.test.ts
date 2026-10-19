import { describe, expect, it } from 'vitest'

import { classifyTree, countEcosystemDependencies } from '../signals'

describe('classifyTree — one definition for every method of observation', () => {
  const tree = [
    { path: 'README.md', type: 'blob' },
    { path: 'package.json', type: 'blob' },
    { path: 'docs', type: 'tree' },
    { path: 'docs/intro.md', type: 'blob' },
    { path: '.github/workflows/ci.yml', type: 'blob' },
    { path: 'packages/core/go.mod', type: 'blob' },
    { path: 'src/thing.test.ts', type: 'blob' },
  ]

  it('counts blobs, detects manifests at any depth, and root-level documentation', () => {
    expect(classifyTree(tree)).toEqual({
      fileCount: 6,
      manifests: ['package.json', 'go.mod'],
      hasRootPackageJson: true,
      readmePresent: true,
      contributingPresent: false,
      licensePresent: false,
      docsDirectoryPresent: true,
      ciConfigPresent: true,
      testDirectoryPresent: false,
      testFilePatternsObserved: true,
    })
  })

  it('a truncated listing confirms presence only, never absence', () => {
    const partial = classifyTree(tree, true)
    expect(partial.fileCount).toBeUndefined()
    expect(partial.readmePresent).toBe(true)
    expect(partial.contributingPresent).toBeUndefined()
    expect(partial.licensePresent).toBeUndefined()
  })
})

describe('countEcosystemDependencies', () => {
  it('matches dependency short names against repository short names', () => {
    const pkg = JSON.stringify({
      dependencies: { '@orchard/alpha': '1', lodash: '4' },
      devDependencies: { beta: '2' },
    })
    expect(countEcosystemDependencies(pkg, ['orchard/alpha', 'orchard/beta', 'orchard/gamma'])).toBe(2)
  })

  it('unparsable JSON is not an observation', () => {
    expect(countEcosystemDependencies('nope', ['orchard/alpha'])).toBeUndefined()
  })
})
