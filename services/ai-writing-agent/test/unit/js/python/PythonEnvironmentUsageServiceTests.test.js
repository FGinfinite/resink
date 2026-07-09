import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'

const { PythonEnvironmentUsageService } = await import(
  '../../../../app/js/python/PythonEnvironmentUsageService.js'
)

describe('PythonEnvironmentUsageService', () => {
  it('records attached environment usage audit entries', async () => {
    const insertedId = new ObjectId()
    const collection = {
      insertOne: vi.fn(async () => ({ insertedId })),
    }
    const service = new PythonEnvironmentUsageService({
      collection,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    const usage = await service.recordAttached({
      environmentId: 'pyenv_table',
      projectId: 'project-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      skillName: 'table-analysis',
      scriptPath: 'scripts/analyze.py',
    })

    expect(collection.insertOne).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: 'pyenv_table',
      projectId: 'project-1',
      sessionId: 'session-1',
      skillName: 'table-analysis',
      result: 'attached',
      attachedAt: new Date('2026-06-24T00:00:00.000Z'),
    }))
    expect(usage._id).toBe(insertedId)
  })
})
