import { describe, expect, it } from 'vitest'

import { buildCalendarWindow } from '../persistence'

describe('buildCalendarWindow with rows of both methods', () => {
  it('prefers a contemporaneous observation over a row recorded from history on the same day', () => {
    const rows = [
      { observedAt: '2025-01-14T23:59:59.999Z', method: 'history', id: 'h' },
      { observedAt: '2025-01-14T09:00:00.000Z', method: 'observed', id: 'o' },
    ]
    const [slot] = buildCalendarWindow(rows, '2025-01-14', 1)
    expect(slot.snapshot?.id).toBe('o')
  })

  it('fills a day with the history row when nothing was observed', () => {
    const rows = [
      { observedAt: '2025-01-13T23:59:59.999Z', method: 'history', id: 'h13' },
      { observedAt: '2025-01-14T09:00:00.000Z', method: 'observed', id: 'o14' },
    ]
    const slots = buildCalendarWindow(rows, '2025-01-14', 2)
    expect(slots.map((s) => s.snapshot?.id)).toEqual(['o14', 'h13'])
  })

  it('keeps the latest row within one method, as before', () => {
    const rows = [
      { observedAt: '2025-01-14T09:00:00.000Z', id: 'early' },
      { observedAt: '2025-01-14T18:00:00.000Z', id: 'late' },
    ]
    expect(buildCalendarWindow(rows, '2025-01-14', 1)[0].snapshot?.id).toBe('late')
  })
})
