import path from 'node:path'

export class AgentCapabilityPromptLoader {
  constructor(options = {}) {
    this.skillRegistry = options.skillRegistry || null
  }

  async loadPrompt(capability) {
    const promptRef = capability?.promptRef
    if (promptRef?.kind === 'builtin-agent-prompt') {
      return this.loadBuiltinAgentPrompt(promptRef.prompt)
    }
    if (promptRef?.kind === 'skill') {
      return this.loadSkillPrompt(promptRef)
    }
    if (promptRef?.kind === 'skill-reference') {
      return this.loadSkillReferencePrompt(promptRef)
    }
    throw new Error(`Unsupported agent capability promptRef: ${promptRef?.kind || '(none)'}`)
  }

  async loadBuiltinAgentPrompt(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Agent capability prompt is required')
    }
    return prompt
  }

  async loadSkillPrompt(promptRef) {
    const skillName = normalizeSkillName(promptRef.skillName)
    if (promptRef.ref !== 'SKILL.md') {
      throw new Error('Unsafe skill capability promptRef')
    }
    const skill = this.skillRegistry?.get?.(skillName)
    const instructions = skill?.instructions || skill?.body
    if (!instructions) {
      throw new Error('Unknown skill capability promptRef')
    }
    return instructions
  }

  async loadSkillReferencePrompt(promptRef) {
    const skillName = normalizeSkillName(promptRef.skillName)
    const ref = normalizeSkillReferenceRef(promptRef.ref)
    const reference = await this.skillRegistry?.readReference?.(skillName, ref)
    if (!reference?.content) {
      throw new Error('Unknown skill capability promptRef')
    }
    return reference.content
  }
}

function normalizeSkillName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error('Unsafe skill capability promptRef')
  }
  return value
}

function normalizeSkillReferenceRef(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) {
    throw new Error('Unsafe skill capability promptRef')
  }
  const normalized = path.posix.normalize(value)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    !normalized.startsWith('references/')
  ) {
    throw new Error('Unsafe skill capability promptRef')
  }
  return normalized
}

export default AgentCapabilityPromptLoader
