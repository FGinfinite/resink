import settings from '@overleaf/settings'
import crypto from 'node:crypto'
import { ObjectId, db } from '../mongodb.js'
import { DockerUvBrokerRunner } from './DockerUvBrokerRunner.js'
import { QuarantineUvWorker } from './QuarantineUvWorker.js'
import { SandboxEnvironmentStore } from './SandboxEnvironmentStore.js'

const DEFAULT_RESOLVER_LEASE_TTL_MS = 15 * 60 * 1000
const APPROVABLE_STATUSES = ['pending', 'needs-approval', 'failed']
const VALID_STATUSES = new Set([
  'pending',
  'resolving',
  'needs-approval',
  'approved',
  'denied',
  'failed',
])

export class PythonDependencyRequestService {
  constructor(options = {}) {
    this.collection = options.collection || db.aiPythonDependencyRequests
    const uvWorkerOptions = {
      networkPolicy:
        settings.aiAssistant?.pythonDependencyBroker?.networkPolicy ||
        'restricted',
      packageIndexProxyUrl:
        settings.aiAssistant?.pythonDependencyBroker?.packageIndexProxyUrl ||
        null,
      tempRoot:
        settings.aiAssistant?.pythonDependencyBroker?.tempRoot ||
        undefined,
      hostTempRoot:
        settings.aiAssistant?.pythonDependencyBroker?.hostTempRoot ||
        undefined,
      ...(options.uvWorkerOptions || {}),
    }
    if (!uvWorkerOptions.runner) {
      uvWorkerOptions.runner = new DockerUvBrokerRunner({
        networkPolicy: uvWorkerOptions.networkPolicy,
        image:
          settings.aiAssistant?.pythonDependencyBroker?.dockerImage ||
          undefined,
        packageIndexProxyNetwork:
          uvWorkerOptions.packageIndexProxyNetwork ||
          settings.aiAssistant?.pythonDependencyBroker
            ?.packageIndexProxyNetwork || null,
        workspaceRoot: uvWorkerOptions.tempRoot,
        workspaceHostRoot: uvWorkerOptions.hostTempRoot,
      })
    }
    this.uvWorker = options.uvWorker || new QuarantineUvWorker(uvWorkerOptions)
    const environmentStoreOptions = {
      rootDir:
        settings.aiAssistant?.pythonDependencyBroker?.environmentStoreRoot ||
        undefined,
      ...(options.environmentStoreOptions || {}),
    }
    this.environmentStore =
      options.environmentStore || new SandboxEnvironmentStore(environmentStoreOptions)
    this.now = options.now || (() => new Date())
    this.resolverLeaseTtlMs =
      options.resolverLeaseTtlMs ||
      settings.aiAssistant?.pythonDependencyBroker?.resolverLeaseTtlMs ||
      DEFAULT_RESOLVER_LEASE_TTL_MS
  }

  async list(filter = {}) {
    const query = {}
    if (filter.projectId) query.projectId = String(filter.projectId)
    if (filter.status && VALID_STATUSES.has(filter.status)) {
      query.status = filter.status
    }
    return this.collection
      .find(query, { sort: { updatedAt: -1, createdAt: -1 }, limit: filter.limit || 100 })
      .toArray()
  }

  async get(requestId) {
    return this.collection.findOne({ _id: normalizeRequestId(requestId) })
  }

  async findApprovedByFingerprint(fingerprint, filter = {}) {
    if (!fingerprint) return null
    const query = {
      fingerprint,
      status: 'approved',
      environmentId: { $ne: null },
    }
    if (filter.projectId) query.projectId = String(filter.projectId)
    if (filter.skillName) query.skillName = String(filter.skillName)
    const request = await this.collection.findOne(query, {
      sort: { approvedAt: -1, updatedAt: -1 },
    })
    if (!request?.environmentId) return null
    if (!(await this.environmentStore.hasSnapshot(request.environmentId))) {
      return null
    }
    return request
  }

  async upsertFromDependencyRequest(input = {}) {
    const request = input.dependencyRequest || input
    const now = this.now()
    const document = {
      projectId: input.projectId || request.projectId || null,
      sessionId: input.sessionId || request.sessionId || null,
      userId: input.userId || request.userId || null,
      scope: request.scope,
      requester: input.requester || { type: 'agent', id: input.userId || null },
      skillName: request.skillName || null,
      scriptPath: request.scriptPath || null,
      sourceFiles: request.sourceFiles || [],
      requestedPackages: request.requestedPackages || [],
      requestedPythonVersion: request.requestedPythonVersion || null,
      requestedNetworkPolicy: request.requestedNetworkPolicy || 'none',
      status: input.status || 'pending',
      riskTier: input.riskTier || null,
      policyFindings: request.policyFindings || [],
      environmentId: input.environmentId || null,
      fingerprint: request.fingerprint,
      updatedAt: now,
    }
    const result = await this.collection.findOneAndUpdate(
      { fingerprint: request.fingerprint, projectId: document.projectId },
      {
        $setOnInsert: { createdAt: now },
        $set: document,
      },
      { upsert: true, returnDocument: 'after' }
    )
    return result.value || result
  }

  async approve(requestId, input = {}) {
    return this.resolveAndApprove(requestId, input)
  }

  async deny(requestId, input = {}) {
    return this.transition(requestId, {
      status: 'denied',
      deniedBy: input.userId || null,
      deniedAt: this.now(),
      decisionReason: input.reason || null,
      resolverLeaseId: null,
      resolvingStartedAt: null,
      resolvingLeaseExpiresAt: null,
    })
  }

  async resolveAndApprove(requestId, input = {}) {
    const normalizedId = normalizeRequestId(requestId)
    const leaseId = crypto.randomUUID()
    const request = await this.acquireResolverLease(normalizedId, leaseId)
    if (!request) return null
    if (request.resolverLeaseId !== leaseId) return request

    const approvalTime = this.now()
    try {
      const files = buildResolverFiles(request)
      const mode = request.scope === 'skill' ? 'script' : 'project-lock'
      const resolved = await this.uvWorker.resolve({
        request,
        mode,
        files,
        scriptPath: request.scriptPath || defaultScriptPath(files),
      })
      if (!resolved.ok) {
        return this.transition(normalizedId, {
          status: resolved.status === 'denied' ? 'denied' : 'failed',
          resolverStatus: resolved.status,
          resolverError: resolved.error || null,
          policyDecision: resolved.policyDecision || null,
          decisionReason: input.reason || null,
          resolverLeaseId: null,
          resolvingStartedAt: null,
          resolvingLeaseExpiresAt: null,
        })
      }

      const environmentId = buildEnvironmentId(request)
      const snapshotFiles = buildSnapshotFiles(resolved)
      await this.environmentStore.putSnapshot({
        environmentId,
        scope: request.scope || 'project',
        skillName: request.skillName || null,
        projectId: request.projectId || null,
        lockHash: firstArtifactHash(resolved.artifacts),
        manifestHash: resolved.audit?.manifestHash || null,
        sbomHash: resolved.audit?.sbomHash || null,
        pythonVersion: request.requestedPythonVersion || null,
        uvVersion: resolved.uvVersion || null,
        policyDecision: resolved.policyDecision || null,
        runtime: resolved.runtime || null,
        approvedBy: input.userId || null,
        approvedAt: approvalTime.toISOString(),
        files: snapshotFiles,
      })

      return this.transition(normalizedId, {
        status: 'approved',
        environmentId,
        approvedBy: input.userId || null,
        approvedAt: approvalTime,
        decisionReason: input.reason || null,
        resolverStatus: resolved.status,
        lockHash: firstArtifactHash(resolved.artifacts),
        manifestHash: resolved.audit?.manifestHash || null,
        sbomHash: resolved.audit?.sbomHash || null,
        uvVersion: resolved.uvVersion || null,
        policyDecision: resolved.policyDecision || null,
        resolverLeaseId: null,
        resolvingStartedAt: null,
        resolvingLeaseExpiresAt: null,
        unset: ['resolverError'],
      })
    } catch (error) {
      return this.transition(normalizedId, {
        status: 'failed',
        resolverStatus: 'failed',
        resolverError: {
          code: 'PYTHON_ENV_APPROVAL_FAILED',
          message: error.message || 'Python dependency approval failed',
        },
        decisionReason: input.reason || null,
        resolverLeaseId: null,
        resolvingStartedAt: null,
        resolvingLeaseExpiresAt: null,
      })
    }
  }

  async acquireResolverLease(requestId, leaseId) {
    const now = this.now()
    const leaseExpiresAt = new Date(now.getTime() + this.resolverLeaseTtlMs)
    const result = await this.collection.findOneAndUpdate(
      {
        _id: normalizeRequestId(requestId),
        $or: [
          { status: { $in: APPROVABLE_STATUSES } },
          { status: 'resolving', resolvingLeaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'resolving',
          resolverLeaseId: leaseId,
          resolvingStartedAt: now,
          resolvingLeaseExpiresAt: leaseExpiresAt,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    )
    const leased = result?.value || result
    if (leased) return leased
    return this.collection.findOne({ _id: normalizeRequestId(requestId) })
  }

  async transition(requestId, fields) {
    const now = this.now()
    const { unset, ...setFields } = fields
    const update = {
      $set: {
        ...setFields,
        updatedAt: now,
      },
    }
    if (Array.isArray(unset) && unset.length > 0) {
      update.$unset = Object.fromEntries(unset.map(field => [field, '']))
    }
    const result = await this.collection.findOneAndUpdate(
      { _id: normalizeRequestId(requestId) },
      update,
      { returnDocument: 'after' }
    )
    return result.value || result
  }

  async cleanupEnvironmentSnapshots(options = {}) {
    const approved = await this.collection
      .find({ status: 'approved', environmentId: { $ne: null } })
      .project({ environmentId: 1 })
      .toArray()
    const keepEnvironmentIds = [
      ...new Set(approved.map(request => request.environmentId).filter(Boolean)),
    ]
    return this.environmentStore.cleanup({
      olderThanMs: options.olderThanMs,
      maxTotalBytes: options.maxTotalBytes,
      keepEnvironmentIds,
    })
  }
}

function buildResolverFiles(request = {}) {
  const files = []
  const sourceFiles = Array.isArray(request.sourceFiles) ? request.sourceFiles : []
  const hasPyprojectContent = sourceFiles.some(
    file => file.path === 'pyproject.toml' && file.content !== undefined
  )
  const hasScript = sourceFiles.some(file => String(file.path || '').endsWith('.py'))
  for (const source of sourceFiles) {
    if (source.content !== undefined) {
      files.push({ path: source.path, content: source.content })
    }
  }
  if (!hasPyprojectContent && request.scope !== 'skill') {
    files.push({
      path: 'pyproject.toml',
      content: buildPyprojectContent(request),
    })
  }
  if (request.scope === 'skill' && !hasScript) {
    const scriptPath = request.scriptPath || 'script.py'
    files.push({
      path: scriptPath,
      content: buildPep723ScriptContent(request),
    })
  }
  return files
}

function buildPyprojectContent(request = {}) {
  const dependencies = (request.requestedPackages || [])
    .map(pkg => JSON.stringify(pkg.raw || pkg.name))
    .join(', ')
  const python = request.requestedPythonVersion
    ? `requires-python = ${JSON.stringify(request.requestedPythonVersion)}\n`
    : ''
  return `[project]\nname = "resink-project-env"\nversion = "0.0.0"\n${python}dependencies = [${dependencies}]\n`
}

function buildPep723ScriptContent(request = {}) {
  const dependencies = (request.requestedPackages || [])
    .map(pkg => JSON.stringify(pkg.raw || pkg.name))
    .join(', ')
  const python = request.requestedPythonVersion
    ? `# requires-python = ${JSON.stringify(request.requestedPythonVersion)}\n`
    : ''
  return `# /// script\n${python}# dependencies = [${dependencies}]\n# ///\nprint("dependency metadata only")\n`
}

function defaultScriptPath(files = []) {
  return files.find(file => String(file.path || '').endsWith('.py'))?.path || 'script.py'
}

function buildSnapshotFiles(resolved = {}) {
  return Object.entries(resolved.artifacts || {}).map(([artifactPath, artifact]) => ({
    path: artifactPath,
    content: artifact.content || '',
  }))
}

function firstArtifactHash(artifacts = {}) {
  return Object.values(artifacts || {}).find(artifact => artifact?.hash)?.hash || null
}

function buildEnvironmentId(request = {}) {
  const scope = sanitizeEnvironmentSegment(request.scope || 'project')
  const owner = sanitizeEnvironmentSegment(request.skillName || request.projectId || 'shared')
  const fingerprint = sanitizeEnvironmentSegment(String(request.fingerprint || 'request').replace(/^sha256:/, ''))
    .slice(0, 24)
  return `pyenv_${scope}_${owner}_${fingerprint}`
}

function sanitizeEnvironmentSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown'
}

export function normalizeRequestId(requestId) {
  if (requestId instanceof ObjectId) return requestId
  if (typeof requestId === 'string' && ObjectId.isValid(requestId)) {
    return new ObjectId(requestId)
  }
  throw new Error('Invalid dependency request id')
}

export default PythonDependencyRequestService
