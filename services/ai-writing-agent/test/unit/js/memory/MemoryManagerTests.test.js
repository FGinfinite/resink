import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@overleaf/logger', () => ({
  default: { warn: vi.fn() },
}))

const { MemoryManager } = await import(
  '../../../../app/js/memory/MemoryManager.js'
)
const { MemoryProvider } = await import(
  '../../../../app/js/memory/MemoryProvider.js'
)

describe('MemoryManager', () => {
  let manager

  beforeEach(() => {
    manager = new MemoryManager()
  })

  it('returns null when no providers registered', async () => {
    const result = await manager.getMemoryContent('proj1')
    expect(result).toBeNull()
  })

  it('returns content from a single provider', async () => {
    const provider = new MemoryProvider('test')
    provider.getContent = vi.fn().mockResolvedValue('rule 1')
    manager.register(provider)

    const result = await manager.getMemoryContent('proj1')
    expect(result).toBe('rule 1')
    expect(provider.getContent).toHaveBeenCalledWith('proj1')
  })

  it('joins content from multiple providers', async () => {
    const p1 = new MemoryProvider('a')
    p1.getContent = vi.fn().mockResolvedValue('content A')
    const p2 = new MemoryProvider('b')
    p2.getContent = vi.fn().mockResolvedValue('content B')

    manager.register(p1)
    manager.register(p2)

    const result = await manager.getMemoryContent('proj1')
    expect(result).toBe('content A\n\ncontent B')
  })

  it('skips providers that return null', async () => {
    const p1 = new MemoryProvider('a')
    p1.getContent = vi.fn().mockResolvedValue('content A')
    const p2 = new MemoryProvider('b')
    p2.getContent = vi.fn().mockResolvedValue(null)

    manager.register(p1)
    manager.register(p2)

    const result = await manager.getMemoryContent('proj1')
    expect(result).toBe('content A')
  })

  it('returns null when all providers return null', async () => {
    const p1 = new MemoryProvider('a')
    p1.getContent = vi.fn().mockResolvedValue(null)
    const p2 = new MemoryProvider('b')
    p2.getContent = vi.fn().mockResolvedValue(null)

    manager.register(p1)
    manager.register(p2)

    const result = await manager.getMemoryContent('proj1')
    expect(result).toBeNull()
  })

  it('continues when a provider throws', async () => {
    const p1 = new MemoryProvider('failing')
    p1.getContent = vi.fn().mockRejectedValue(new Error('db error'))
    const p2 = new MemoryProvider('ok')
    p2.getContent = vi.fn().mockResolvedValue('good content')

    manager.register(p1)
    manager.register(p2)

    const result = await manager.getMemoryContent('proj1')
    expect(result).toBe('good content')
  })
})
