import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const viewer = (login: string, id: number) =>
  new Response(JSON.stringify({ login, id }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

async function freshIdentity() {
  vi.resetModules()
  return import('../identity')
}

beforeEach(() => {
  process.env.GROVE_GITHUB_TOKEN = 'synthetic-token'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GROVE_GITHUB_TOKEN
})

describe('resolveStewardIdentity', () => {
  it('concurrent checks on a cold cache share one request and agree', async () => {
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(viewer('orchard', 7)), 5)),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { resolveStewardIdentity } = await freshIdentity()

    const [a, b] = await Promise.all([resolveStewardIdentity(), resolveStewardIdentity()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toMatchObject({ kind: 'resolved', identity: { login: 'orchard', id: 7 } })
    expect(b).toEqual(a)
    // Cached afterwards: no further request.
    await resolveStewardIdentity()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('says why when the token is refused, and why when GitHub gave no usable answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    let mod = await freshIdentity()
    expect(await mod.resolveStewardIdentity()).toMatchObject({
      kind: 'unavailable',
      reason: 'rejected',
      status: 401,
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    mod = await freshIdentity()
    expect(await mod.resolveStewardIdentity()).toMatchObject({
      kind: 'unavailable',
      reason: 'unreachable',
      status: 503,
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    mod = await freshIdentity()
    expect(await mod.resolveStewardIdentity()).toMatchObject({
      kind: 'unavailable',
      reason: 'unreachable',
    })
  })

  it('a failed check is not cached: the next check asks again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(viewer('orchard', 7))
    vi.stubGlobal('fetch', fetchMock)
    const { resolveStewardIdentity } = await freshIdentity()
    expect((await resolveStewardIdentity()).kind).toBe('unavailable')
    expect((await resolveStewardIdentity()).kind).toBe('resolved')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidation forgets the identity so a revoked token is re-checked', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(viewer('orchard', 7))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const { resolveStewardIdentity, invalidateStewardIdentity } = await freshIdentity()
    expect((await resolveStewardIdentity()).kind).toBe('resolved')
    invalidateStewardIdentity()
    expect(await resolveStewardIdentity()).toMatchObject({ kind: 'unavailable', reason: 'rejected' })
  })
})
