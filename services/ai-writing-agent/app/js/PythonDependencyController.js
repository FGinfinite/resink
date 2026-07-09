import { expressify } from '@overleaf/promise-utils'
import { PythonDependencyRequestService } from './python/PythonDependencyRequestService.js'
import { checkProjectWriteAccess } from './util/project-access.js'

export class PythonDependencyController {
  constructor(options = {}) {
    this.requestService =
      options.requestService || new PythonDependencyRequestService()
  }

  async listRequests(req, res) {
    const requests = await this.requestService.list({
      projectId: req.query.projectId,
      status: req.query.status,
      limit: Number.parseInt(req.query.limit, 10) || 100,
    })
    res.json({ requests: requests.map(serializeRequest) })
  }

  async getRequest(req, res) {
    const request = await this.requestService.get(req.params.requestId)
    if (!request) return res.status(404).json({ error: 'Dependency request not found' })
    res.json({ request: serializeRequest(request) })
  }

  async approveRequest(req, res) {
    const request = await this.requestService.approve(req.params.requestId, {
      userId: req.headers['x-user-id'],
      reason: req.body?.reason || null,
    })
    if (!request) return res.status(404).json({ error: 'Dependency request not found' })
    res.json({ request: serializeRequest(request) })
  }

  async denyRequest(req, res) {
    const request = await this.requestService.deny(req.params.requestId, {
      userId: req.headers['x-user-id'],
      reason: req.body?.reason || null,
    })
    if (!request) return res.status(404).json({ error: 'Dependency request not found' })
    res.json({ request: serializeRequest(request) })
  }

  async approveProjectRequest(req, res) {
    const request = await this.loadProjectRequest(req, res)
    if (!request) return
    if (!isProjectOwnerApprovable(request)) {
      return res.status(403).json({
        error: 'Project owner approval is not allowed for this dependency request',
      })
    }
    const approved = await this.requestService.approve(req.params.requestId, {
      userId: req.headers['x-user-id'],
      reason: req.body?.reason || null,
      approvalScope: 'project-owner',
    })
    if (!approved) return res.status(404).json({ error: 'Dependency request not found' })
    res.json({ request: serializeRequest(approved) })
  }

  async denyProjectRequest(req, res) {
    const request = await this.loadProjectRequest(req, res)
    if (!request) return
    const denied = await this.requestService.deny(req.params.requestId, {
      userId: req.headers['x-user-id'],
      reason: req.body?.reason || null,
      approvalScope: 'project-owner',
    })
    if (!denied) return res.status(404).json({ error: 'Dependency request not found' })
    res.json({ request: serializeRequest(denied) })
  }

  async loadProjectRequest(req, res) {
    const { projectId, requestId } = req.params
    const userId = req.headers['x-user-id']
    if (!(await checkProjectWriteAccess(projectId, userId))) {
      res.status(403).json({ error: 'Project write access required' })
      return null
    }
    const request = await this.requestService.get(requestId)
    if (!request) {
      res.status(404).json({ error: 'Dependency request not found' })
      return null
    }
    if (String(request.projectId || '') !== String(projectId || '')) {
      res.status(404).json({ error: 'Dependency request not found' })
      return null
    }
    return request
  }
}

function isProjectOwnerApprovable(request = {}) {
  if (request.status && !['pending', 'needs-approval', 'failed'].includes(request.status)) {
    return false
  }
  if ((request.requestedNetworkPolicy || 'none') !== 'none') return false
  if (!['low', 'none'].includes(request.riskTier)) return false
  const findings = Array.isArray(request.policyFindings)
    ? request.policyFindings
    : []
  return !findings.some(finding =>
    ['error', 'high', 'critical'].includes(String(finding.severity || '').toLowerCase())
  )
}

export function serializeRequest(request) {
  return {
    id: request._id?.toString?.() || request.id,
    projectId: request.projectId || null,
    sessionId: request.sessionId || null,
    userId: request.userId || null,
    scope: request.scope,
    requester: request.requester || null,
    skillName: request.skillName || null,
    scriptPath: request.scriptPath || null,
    sourceFiles: request.sourceFiles || [],
    requestedPackages: request.requestedPackages || [],
    requestedPythonVersion: request.requestedPythonVersion || null,
    requestedNetworkPolicy: request.requestedNetworkPolicy || 'none',
    status: request.status,
    riskTier: request.riskTier || null,
    policyFindings: request.policyFindings || [],
    environmentId: request.environmentId || null,
    resolverStatus: request.resolverStatus || null,
    lockHash: request.lockHash || null,
    manifestHash: request.manifestHash || null,
    sbomHash: request.sbomHash || null,
    uvVersion: request.uvVersion || null,
    policyDecision: request.policyDecision || null,
    fingerprint: request.fingerprint || null,
    approvedBy: request.approvedBy || null,
    approvedAt: request.approvedAt?.getTime?.() || null,
    deniedBy: request.deniedBy || null,
    deniedAt: request.deniedAt?.getTime?.() || null,
    decisionReason: request.decisionReason || null,
    createdAt: request.createdAt?.getTime?.() || null,
    updatedAt: request.updatedAt?.getTime?.() || null,
  }
}

const controller = new PythonDependencyController()

export default {
  listRequests: expressify(controller.listRequests.bind(controller)),
  getRequest: expressify(controller.getRequest.bind(controller)),
  approveRequest: expressify(controller.approveRequest.bind(controller)),
  denyRequest: expressify(controller.denyRequest.bind(controller)),
  approveProjectRequest: expressify(controller.approveProjectRequest.bind(controller)),
  denyProjectRequest: expressify(controller.denyProjectRequest.bind(controller)),
}
