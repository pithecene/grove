import { afterEach, describe, expect, it, vi } from 'vitest'

import { failureOf, fetchRepository, fetchUserRepos, fetchViewer } from '../client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('answers for a request that did not complete or could not be read', () => {
  it('a network failure is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    expect(await fetchViewer('t')).toEqual({ kind: 'unreachable', message: 'fetch failed' })
  })

  it('a 2xx listing that is valid JSON but not a list of repositories is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"unexpected"}', { status: 200 })),
    )
    expect(await fetchUserRepos('t')).toEqual({ kind: 'unavailable', status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[{"id":"x"}]', { status: 200 })))
    expect(await fetchUserRepos('t')).toEqual({ kind: 'unavailable', status: 200 })
  })

  it('a 2xx whose body cannot be parsed is unavailable, not an exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not json', { status: 200 })))
    expect(await fetchRepository('t', 'orchard/alpha')).toEqual({
      kind: 'unavailable',
      status: 200,
    })
  })
})

const response = (status: number, headers: Record<string, string> = {}, body = '') =>
  new Response(body, { status, headers })

describe('failureOf — one classification of what GitHub answered', () => {
  it('401 is the token not being accepted', async () => {
    expect(await failureOf(response(401))).toEqual({ kind: 'unauthorized', status: 401 })
  })

  it('404 is not found — never deletion', async () => {
    expect(await failureOf(response(404))).toEqual({ kind: 'not_found', status: 404 })
  })

  it('403 with the quota exhausted is throttling, not a decision', async () => {
    expect(
      await failureOf(response(403, { 'x-ratelimit-remaining': '0', 'retry-after': '30' })),
    ).toEqual({ kind: 'throttled', status: 403, retryAfterSeconds: 30 })
  })

  it('403 with only a retry-after is a secondary limit', async () => {
    expect(await failureOf(response(403, { 'retry-after': '60' }))).toMatchObject({
      kind: 'throttled',
      retryAfterSeconds: 60,
    })
  })

  it('403 with no headers but a rate-limit message is still throttling', async () => {
    expect(
      await failureOf(
        response(
          403,
          { 'x-ratelimit-remaining': '4999' },
          '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}',
        ),
      ),
    ).toMatchObject({ kind: 'throttled', status: 403, retryAfterSeconds: undefined })
  })

  it('403 that is none of those is a decision about access', async () => {
    expect(
      await failureOf(
        response(403, { 'x-ratelimit-remaining': '4999' }, '{"message":"Resource protected by organization SAML enforcement."}'),
      ),
    ).toEqual({ kind: 'forbidden', status: 403 })
  })

  it('429 is throttling', async () => {
    expect(await failureOf(response(429))).toMatchObject({ kind: 'throttled', status: 429 })
  })

  it('anything else non-2xx is GitHub being unable to serve the request', async () => {
    expect(await failureOf(response(502))).toEqual({ kind: 'unavailable', status: 502 })
    expect(await failureOf(response(422))).toEqual({ kind: 'unavailable', status: 422 })
  })
})
