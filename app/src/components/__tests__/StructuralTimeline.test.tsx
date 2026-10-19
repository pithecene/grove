import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TimelineEntry } from '../../server/timeline'
import { StructuralTimeline } from '../StructuralTimeline'

const text = (timeline: TimelineEntry[]) =>
  renderToStaticMarkup(<StructuralTimeline timeline={timeline} />)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')

// The same series, once as observed rows and once as rows recorded from
// the repository's history.
function series(method: 'observed' | 'history'): TimelineEntry[] {
  return [
    {
      kind: 'density_span',
      observedAt: '2025-01-01T23:59:59.999Z',
      spanEnd: '2025-01-02T23:59:59.999Z',
      tier: 'rooting',
      observationCount: 2,
      days: 2,
      method,
    },
    {
      kind: 'density_transition',
      observedAt: '2025-01-01T23:59:59.999Z',
      fromTier: null,
      toTier: 'rooting',
      method,
    },
    {
      kind: 'declaration_change',
      observedAt: '2024-12-31T23:59:59.999Z',
      changes: [{ field: 'phase', from: 'emerging', to: 'expanding' }],
      method,
      recordedAt: method === 'history' ? '2025-10-19T10:00:00.000Z' : null,
    },
  ] as TimelineEntry[]
}

describe('StructuralTimeline', () => {
  let tz: string | undefined
  beforeEach(() => {
    tz = process.env.TZ
  })
  afterEach(() => {
    process.env.TZ = tz
  })

  it('renders a day recorded from history exactly like an observed day', () => {
    expect(text(series('history'))).toBe(text(series('observed')))
    expect(text(series('history'))).not.toMatch(/history|retrospective|reconstructed/i)
  })

  it('renders dates as UTC days in any time zone', async () => {
    // Formatters are built when the module loads, so load it under each zone.
    const render = async (zone: string) => {
      process.env.TZ = zone
      vi.resetModules()
      const { StructuralTimeline: Timeline } = await import('../StructuralTimeline')
      return renderToStaticMarkup(<Timeline timeline={series('history')} />)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
    }
    const east = await render('Pacific/Kiritimati') // UTC+14
    const west = await render('Pacific/Pago_Pago') // UTC−11
    expect(east).toContain('Jan 1, 2025 through Jan 2, 2025')
    expect(west).toBe(east)
  })
})
