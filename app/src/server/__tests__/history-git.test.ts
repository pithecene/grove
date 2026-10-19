import { describe, expect, it } from 'vitest'

import { redactSecret } from '../history/git'

describe('redactSecret', () => {
  it('removes every occurrence of the secret from a message', () => {
    const secret = 'c2VjcmV0'
    const message = `Command failed: git -c http.extraheader=AUTHORIZATION: basic ${secret} clone … (${secret})`
    expect(redactSecret(message, secret)).toBe(
      'Command failed: git -c http.extraheader=AUTHORIZATION: basic <redacted> clone … (<redacted>)',
    )
  })

  it('leaves a message without the secret alone, and never matches an empty secret', () => {
    expect(redactSecret('fatal: not a git repository', 'abc')).toBe('fatal: not a git repository')
    expect(redactSecret('anything', '')).toBe('anything')
  })
})
