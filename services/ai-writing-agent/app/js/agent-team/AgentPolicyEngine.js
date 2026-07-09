const NETWORK_RANK = new Map([
  ['deny', 0],
  ['package-index-proxy', 1],
  ['allow', 2],
])
const WRITE_TOOLS = new Set([
  'edit_document',
  'delete_file',
  'sync_workspace_changes',
  'write_workspace_file',
  'bib_manage',
])
const CHILD_DENIED_TOOLS = new Set([
  'start_agent_task',
  'start_agent_team',
  'handoff_to_agent',
  'return_from_handoff',
  'propose_memory',
])

export class AgentPolicyError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'AgentPolicyError'
    this.code = 'AGENT_POLICY_DENIED'
    this.info = info
  }
}

export class AgentPolicyEngine {
  computeChildPolicy(input = {}) {
    const parent = normalizePolicy(input.parentPolicy)
    const layers = [
      normalizePolicy(input.capabilityPolicy),
      normalizePolicy(input.workflowPolicy),
      normalizePolicy(input.taskPolicy),
    ].filter(Boolean)

    const result = layers.reduce(
      (policy, layer) => intersectPolicies(policy, layer),
      parent
    )
    result.tools = result.tools.filter(tool => !CHILD_DENIED_TOOLS.has(tool))

    assertUsefulPolicy(result, layers)
    return result
  }
}

function normalizePolicy(policy) {
  if (!policy) return null
  return {
    tools: normalizeStringArray(policy.tools),
    fileGlobs: normalizeStringArray(policy.fileGlobs),
    writeGlobs: Array.isArray(policy.writeGlobs)
      ? normalizeStringArray(policy.writeGlobs)
      : null,
    network: normalizeNetwork(policy.network, policy.network === undefined ? null : 'deny'),
    pythonEnvironments: normalizeStringArray(policy.pythonEnvironments),
    modelTiers: normalizeStringArray(policy.modelTiers),
    maxDepth: normalizeLimit(policy.maxDepth),
    maxParallelTasks: normalizeLimit(policy.maxParallelTasks),
    maxToolCalls: normalizeLimit(policy.maxToolCalls),
    allowSpawn: policy.allowSpawn === true,
    allowHandoff: policy.allowHandoff === true,
  }
}

function intersectPolicies(left, right) {
  return {
    tools: intersectArrays(left.tools, right.tools),
    fileGlobs: intersectGlobs(left.fileGlobs, right.fileGlobs),
    writeGlobs: intersectGlobs(left.writeGlobs, right.writeGlobs),
    network: stricterNetwork(left.network, right.network),
    pythonEnvironments: intersectArrays(
      left.pythonEnvironments,
      right.pythonEnvironments
    ),
    modelTiers: intersectArrays(left.modelTiers, right.modelTiers),
    maxDepth: stricterLimit(left.maxDepth, right.maxDepth),
    maxParallelTasks: stricterLimit(left.maxParallelTasks, right.maxParallelTasks),
    maxToolCalls: stricterLimit(left.maxToolCalls, right.maxToolCalls),
    allowSpawn: left.allowSpawn && right.allowSpawn,
    allowHandoff: left.allowHandoff && right.allowHandoff,
  }
}

function assertUsefulPolicy(policy, layers = []) {
  const failures = []
  if (policy.tools.length === 0) failures.push('tools')
  if (policy.fileGlobs.length === 0) failures.push('fileGlobs')
  if (policy.modelTiers.length === 0) failures.push('modelTiers')
  if (policy.maxToolCalls <= 0) failures.push('maxToolCalls')
  if (
    policy.tools.some(tool => WRITE_TOOLS.has(tool)) &&
    (policy.writeGlobs || []).length === 0
  ) {
    failures.push('writeGlobs')
  }
  if (
    policy.pythonEnvironments.length === 0 &&
    layers.some(layer => layer.pythonEnvironments.length > 0)
  ) {
    failures.push('pythonEnvironments')
  }
  if (failures.length > 0) {
    throw new AgentPolicyError('Child agent policy has no usable permissions', {
      reason: 'empty-child-policy',
      failures,
    })
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
    : []
}

function normalizeNetwork(value, fallback = 'deny') {
  return NETWORK_RANK.has(value) ? value : fallback
}

function normalizeLimit(value) {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) return null
  return numeric
}

function intersectArrays(left, right) {
  if (right.length === 0) return left
  const allowed = new Set(left)
  return right.filter(item => allowed.has(item))
}

function intersectGlobs(parentGlobs, childGlobs) {
  if (parentGlobs == null && childGlobs == null) return null
  if (parentGlobs == null) return childGlobs
  if (childGlobs == null) return parentGlobs
  if (childGlobs.length === 0) return parentGlobs
  return childGlobs.filter(childGlob =>
    parentGlobs.some(parentGlob => globContains(parentGlob, childGlob))
  )
}

function globContains(parentGlob, childGlob) {
  if (parentGlob === childGlob) return true
  if (parentGlob === '**/*') return true
  if (parentGlob.startsWith('**/*.')) {
    return childGlob.endsWith(parentGlob.slice('**/*'.length))
  }
  if (parentGlob.endsWith('/**')) {
    const prefix = parentGlob.slice(0, -'/**'.length)
    return childGlob === prefix || childGlob.startsWith(`${prefix}/`)
  }
  return false
}

function stricterNetwork(left, right) {
  if (right == null) return left
  if (left == null) return right
  return NETWORK_RANK.get(left) <= NETWORK_RANK.get(right) ? left : right
}

function stricterLimit(left, right) {
  if (right == null) return left
  if (left == null) return right
  return Math.min(left, right)
}

export default AgentPolicyEngine
