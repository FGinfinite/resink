import { db } from '../mongodb.js'

export class PythonEnvironmentUsageService {
  constructor(options = {}) {
    this.collection = options.collection || db.aiPythonEnvironmentUsages
    this.now = options.now || (() => new Date())
  }

  async recordAttached(input = {}) {
    if (!input.environmentId) return null
    const document = {
      environmentId: input.environmentId,
      projectId: input.projectId || null,
      sessionId: input.sessionId || null,
      turnId: input.turnId || null,
      skillName: input.skillName || null,
      scriptPath: input.scriptPath || null,
      commandId: input.commandId || null,
      attachedAt: input.attachedAt ? new Date(input.attachedAt) : this.now(),
      detachedAt: null,
      result: input.result || 'attached',
      outputBytes: input.outputBytes || 0,
      artifactIds: input.artifactIds || [],
    }
    const result = await this.collection.insertOne(document)
    return {
      ...document,
      _id: result.insertedId,
    }
  }
}

export default PythonEnvironmentUsageService
