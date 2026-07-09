import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@overleaf/settings', () => ({
  default: {
    runBudget: {},
  },
}))

const { RunBudget } = await import(
  '../../../../app/js/agent/RunBudget.js'
)

describe('RunBudget', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('enforces concurrent delegation slots explicitly', () => {
    const budget = new RunBudget({ maxConcurrentDelegations: 1 })

    expect(budget.currentDelegations).toBe(0)
    expect(budget.tryAcquireDelegationSlot()).toBe(true)
    expect(budget.currentDelegations).toBe(1)
    expect(budget.tryAcquireDelegationSlot()).toBe(false)
    expect(budget.currentDelegations).toBe(1)

    budget.releaseDelegationSlot()
    expect(budget.currentDelegations).toBe(0)
    expect(budget.tryAcquireDelegationSlot()).toBe(true)
  })

  it('does not release below zero', () => {
    const budget = new RunBudget({ maxConcurrentDelegations: 1 })

    budget.releaseDelegationSlot()

    expect(budget.currentDelegations).toBe(0)
  })
})
