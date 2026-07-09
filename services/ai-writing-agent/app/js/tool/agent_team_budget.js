export function acquireDelegationBudget(runBudget, currentDepth = 0, label = 'Agent team') {
  if (!runBudget) {
    return { allowed: true, release() {} }
  }
  const depth = Number.isSafeInteger(currentDepth) ? currentDepth : 0
  if (
    typeof runBudget.tryConsumeDelegation === 'function' &&
    !runBudget.tryConsumeDelegation(depth)
  ) {
    return {
      allowed: false,
      reason: 'delegation-budget-exhausted',
      message: `${label} blocked: delegation budget exhausted`,
      release() {},
    }
  }
  if (
    typeof runBudget.tryAcquireDelegationSlot === 'function' &&
    !runBudget.tryAcquireDelegationSlot()
  ) {
    return {
      allowed: false,
      reason: 'concurrent-delegation-budget-exhausted',
      message: `${label} blocked: concurrent delegation budget exhausted`,
      release() {},
    }
  }
  let released = false
  return {
    allowed: true,
    release() {
      if (released) return
      released = true
      runBudget.releaseDelegationSlot?.()
    },
  }
}
