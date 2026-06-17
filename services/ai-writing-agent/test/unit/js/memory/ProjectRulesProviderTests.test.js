import { describe, it, expect, vi, beforeEach } from 'vitest'

const findOneMock = vi.fn()

vi.mock('../../../../app/js/mongodb.js', () => ({
  db: {
    aiProjectRules: { findOne: findOneMock },
  },
}))

const { ProjectRulesProvider } = await import(
  '../../../../app/js/memory/ProjectRulesProvider.js'
)

describe('ProjectRulesProvider', () => {
  let provider

  beforeEach(() => {
    provider = new ProjectRulesProvider()
    findOneMock.mockReset()
  })

  it('returns content when document exists', async () => {
    findOneMock.mockResolvedValue({ content: '# My Rules' })

    const result = await provider.getContent('proj123')
    expect(result).toBe('# My Rules')
    expect(findOneMock).toHaveBeenCalledWith(
      { projectId: 'proj123' },
      { projection: { content: 1 } }
    )
  })

  it('returns null when no document found', async () => {
    findOneMock.mockResolvedValue(null)

    const result = await provider.getContent('proj123')
    expect(result).toBeNull()
  })

  it('returns null when content is empty string', async () => {
    findOneMock.mockResolvedValue({ content: '' })

    const result = await provider.getContent('proj123')
    expect(result).toBeNull()
  })
})
