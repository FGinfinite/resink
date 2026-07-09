import { DocumentAdapter } from '../adapter/DocumentAdapter.js'
import { ProjectAdapter } from '../adapter/ProjectAdapter.js'
import { conflictError, validationError } from './AgentContextErrors.js'
import { assertAgentContextContentSafe } from './ContentSafetyGuard.js'

const DEFAULT_INSTRUCTIONS_FILE = 'AGENTS.md'
const DEFAULT_MAX_INSTRUCTION_CHARS = 40000

export class ProjectInstructionService {
  constructor(options = {}) {
    this.projectAdapter = options.projectAdapter || new ProjectAdapter()
    this.documentAdapter = options.documentAdapter || new DocumentAdapter()
    this.projectInstructionsFile =
      options.projectInstructionsFile || DEFAULT_INSTRUCTIONS_FILE
    this.maxInstructionChars =
      options.maxInstructionChars || DEFAULT_MAX_INSTRUCTION_CHARS
    this.changeSetService = options.changeSetService || null
    this.canonicalWritebackService = options.canonicalWritebackService || null
  }

  async getInstructions(input = {}) {
    const projectId = requireString(input.projectId, 'projectId')
    const entity = await this.projectAdapter.resolvePathToEntity(
      projectId,
      this.projectInstructionsFile
    )

    if (!entity) {
      return this.missingResult()
    }
    if (entity.type !== 'doc') {
      throw validationError(
        `${this.projectInstructionsFile} exists but is not a text document`,
        'PROJECT_INSTRUCTIONS_ENTITY_CONFLICT'
      )
    }

    const document = await this.documentAdapter.getDocumentContent(
      projectId,
      entity.id
    )
    return {
      exists: true,
      path: this.projectInstructionsFile,
      docId: entity.id,
      version: document.version,
      content: document.content,
      source: 'project-file',
      updatedAt: entity.updatedAt || null,
    }
  }

  async createInstructions(input = {}) {
    const projectId = requireString(input.projectId, 'projectId')
    const userId = requireString(input.userId, 'userId')
    const content = validateContent(input.content || '', this.maxInstructionChars)
    const existing = await this.projectAdapter.resolvePathToEntity(
      projectId,
      this.projectInstructionsFile
    )
    if (existing) {
      throw validationError(
        `${this.projectInstructionsFile} already exists`,
        'PROJECT_INSTRUCTIONS_ALREADY_EXISTS'
      )
    }

    const doc = await this.projectAdapter.createDoc(
      projectId,
      this.projectInstructionsFile,
      null,
      userId
    )
    const docId = doc._id?.toString?.() || doc._id || doc.id
    if (content.length > 0) {
      await this.documentAdapter._callSetDocAPI(
        projectId,
        docId,
        content.split('\n'),
        userId,
        0
      )
    }
    this.projectAdapter.clearCache?.(projectId)

    return {
      exists: true,
      path: this.projectInstructionsFile,
      docId,
      version: 1,
      content,
      source: 'project-file',
      updatedAt: null,
    }
  }

  async saveDraft(input = {}) {
    if (!this.changeSetService) {
      throw validationError(
        'Project instruction writeback service is not configured',
        'PROJECT_INSTRUCTIONS_WRITEBACK_UNAVAILABLE'
      )
    }
    const sessionId = requireString(input.sessionId, 'sessionId')
    const projectId = requireString(input.projectId, 'projectId')
    const userId = requireString(input.userId, 'userId')
    const mode = input.mode === 'auto' ? 'auto' : 'review'
    const content = validateContent(input.content, this.maxInstructionChars)
    const current = await this.getInstructions({ projectId })
    if (!current.exists) {
      throw validationError(
        `${this.projectInstructionsFile} does not exist`,
        'PROJECT_INSTRUCTIONS_NOT_FOUND'
      )
    }
    if (input.docId && input.docId !== current.docId) {
      throw conflictError(
        `${this.projectInstructionsFile} no longer points to the requested document`,
        'PROJECT_INSTRUCTIONS_DOC_CONFLICT'
      )
    }
    const baseVersion = normalizeOptionalVersion(input.baseVersion)
    if (baseVersion !== null && baseVersion !== current.version) {
      throw conflictError(
        `${this.projectInstructionsFile} has changed since it was loaded`,
        'PROJECT_INSTRUCTIONS_VERSION_CONFLICT'
      )
    }

    const changeSet = await this.changeSetService.createChangeSet({
      sessionId,
      projectId,
      userId,
      turnId: input.turnId || null,
      mode,
    })
    const draftChange = await this.changeSetService.createDraftChange({
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      turnId: input.turnId || null,
      toolCallId: input.toolCallId || null,
      type: 'edit',
      source: 'agent-loop-v2',
      path: this.projectInstructionsFile,
      docId: current.docId,
      baseVersion: current.version,
      oldText: current.content,
      newText: content,
      newContent: content,
      status: 'pending',
      provenance: {
        agentName: 'agent-context',
        toolName: 'project_instructions',
      },
      mirrorToSessionPendingChanges: true,
    })

    if (mode === 'auto') {
      if (!this.canonicalWritebackService) {
        throw validationError(
          'Canonical writeback service is not configured',
          'PROJECT_INSTRUCTIONS_WRITEBACK_UNAVAILABLE'
        )
      }
      const writeback = await this.canonicalWritebackService.applyDraftChange({
        change: draftChange,
        userId,
      })
      return this.formatDraftResponse({
        changeSet,
        draftChange: writeback.draftChange || draftChange,
        status: writeback.status,
        writeback,
      })
    }

    return this.formatDraftResponse({
      changeSet,
      draftChange,
      status: 'pending',
    })
  }

  formatDraftResponse({ changeSet, draftChange, status, writeback = null }) {
    const isConflict = status === 'conflict'
    return {
      changeSetId: changeSet._id?.toString?.() || changeSet._id,
      draftChangeId: draftChange._id?.toString?.() || draftChange._id,
      status,
      path: this.projectInstructionsFile,
      docId: draftChange.docId,
      baseVersion: draftChange.baseVersion ?? null,
      appliedVersion: draftChange.appliedVersion ?? null,
      conflict: isConflict
        ? {
            type: draftChange.conflictType || 'UNKNOWN',
            message: draftChange.conflictMessage || null,
          }
        : null,
      events: writeback?.events || [],
    }
  }

  missingResult() {
    return {
      exists: false,
      path: this.projectInstructionsFile,
      docId: null,
      version: null,
      content: '',
      source: 'project-file',
      updatedAt: null,
    }
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} is required`)
  }
  return value
}

function validateContent(content, maxLength) {
  if (typeof content !== 'string') {
    throw validationError('Project instructions content must be a string')
  }
  if (content.length > maxLength) {
    throw validationError(
      'Project instructions content exceeds maximum length',
      'PROJECT_INSTRUCTIONS_TOO_LARGE'
    )
  }
  return assertAgentContextContentSafe(content, 'Project instructions content')
}

function normalizeOptionalVersion(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  if (!Number.isInteger(value) || value < 0) {
    throw validationError(
      'baseVersion must be a non-negative integer',
      'PROJECT_INSTRUCTIONS_INVALID_BASE_VERSION'
    )
  }
  return value
}

export default ProjectInstructionService
