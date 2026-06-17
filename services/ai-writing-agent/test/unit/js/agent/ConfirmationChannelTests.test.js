import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockSettings = {
  confirmationChannel: {
    timeout: 30000,
    defaultTimeoutMs: 30000,
    maxPending: 500,
    maxEarlyConfirmations: 100,
    earlyTtlMs: 30000,
    finalizedTtlMs: 60000,
  },
}

const mockLogger = {
  warn: vi.fn(),
}

vi.mock('@overleaf/settings', () => ({
  default: mockSettings,
}))

vi.mock('@overleaf/logger', () => ({
  default: mockLogger,
}))

const { ConfirmationChannel } = await import(
  '../../../../app/js/agent/ConfirmationChannel.js'
)

describe('ConfirmationChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockLogger.warn.mockReset()
    mockSettings.confirmationChannel.timeout = 30000
    mockSettings.confirmationChannel.defaultTimeoutMs = 30000
    mockSettings.confirmationChannel.maxPending = 500
    mockSettings.confirmationChannel.maxEarlyConfirmations = 100
    mockSettings.confirmationChannel.earlyTtlMs = 30000
    mockSettings.confirmationChannel.finalizedTtlMs = 60000
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should read the default timeout from settings when constructed', () => {
    mockSettings.confirmationChannel.defaultTimeoutMs = 1234

    const channel = new ConfirmationChannel()

    expect(channel.timeout).toBe(1234)
  })

  it('should resolve a pending confirmation before timeout', async () => {
    mockSettings.confirmationChannel.defaultTimeoutMs = 1000
    const channel = new ConfirmationChannel()
    const waitPromise = channel.waitForConfirmation('change-1')

    channel.confirm('change-1', 'accept', 'looks good')
    await vi.runAllTimersAsync()

    await expect(await waitPromise).toEqual({
      action: 'accept',
      reason: 'looks good',
    })
  })

  it('should auto reject after the configured timeout', async () => {
    mockSettings.confirmationChannel.defaultTimeoutMs = 1000
    const channel = new ConfirmationChannel()
    const waitPromise = channel.waitForConfirmation('change-2')

    await vi.advanceTimersByTimeAsync(1000)

    await expect(await waitPromise).toEqual({
      action: 'reject',
      reason: 'Confirmation timed out',
    })
  })

  it('should reuse an early confirmation within ttl', async () => {
    const channel = new ConfirmationChannel()

    expect(channel.confirm('change-3', 'reject', 'no')).toBe(true)

    await expect(await channel.waitForConfirmation('change-3')).toEqual({
      action: 'reject',
      reason: 'no',
    })
  })

  it('should discard expired early confirmations', async () => {
    mockSettings.confirmationChannel.defaultTimeoutMs = 1000
    mockSettings.confirmationChannel.earlyTtlMs = 100
    const channel = new ConfirmationChannel()

    expect(channel.confirm('change-4', 'accept', 'stale')).toBe(true)
    await vi.advanceTimersByTimeAsync(101)

    const waitPromise = channel.waitForConfirmation('change-4')
    await vi.advanceTimersByTimeAsync(1000)

    await expect(await waitPromise).toEqual({
      action: 'reject',
      reason: 'Confirmation timed out',
    })
  })
})
