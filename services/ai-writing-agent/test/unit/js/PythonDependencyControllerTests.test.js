import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../app/js/util/project-access.js', () => ({
  checkProjectWriteAccess: vi.fn(),
}))

const {
  PythonDependencyController,
  serializeRequest,
} = await import('../../../app/js/PythonDependencyController.js')
const { checkProjectWriteAccess } = await import(
  '../../../app/js/util/project-access.js'
)

function responseMock() {
  return {
    statusCode: 200,
    body: null,
    status: vi.fn(function status(code) {
      this.statusCode = code
      return this
    }),
    json: vi.fn(function json(body) {
      this.body = body
      return this
    }),
  }
}

describe('PythonDependencyController', () => {
  it('lists dependency requests with safe serialization', async () => {
    const id = new ObjectId()
    const controller = new PythonDependencyController({
      requestService: {
        list: vi.fn(async () => [{
          _id: id,
          projectId: 'project-1',
          scope: 'project',
          status: 'pending',
          requestedPackages: [{ name: 'pandas' }],
          createdAt: new Date('2026-06-24T00:00:00.000Z'),
          updatedAt: new Date('2026-06-24T00:00:01.000Z'),
        }]),
      },
    })
    const res = responseMock()

    await controller.listRequests({
      query: { projectId: 'project-1', status: 'pending' },
    }, res)

    expect(res.body.requests).toEqual([
      expect.objectContaining({
        id: id.toString(),
        projectId: 'project-1',
        status: 'pending',
        requestedPackages: [{ name: 'pandas' }],
        createdAt: new Date('2026-06-24T00:00:00.000Z').getTime(),
      }),
    ])
  })

  it('approves dependency requests with the authenticated user id', async () => {
    const id = new ObjectId()
    const approve = vi.fn(async () => ({
      _id: id,
      scope: 'project',
      status: 'approved',
      environmentId: 'pyenv-approved',
    }))
    const controller = new PythonDependencyController({
      requestService: { approve },
    })
    const res = responseMock()

    await controller.approveRequest({
      params: { requestId: id.toString() },
      headers: { 'x-user-id': '0123456789abcdef01234567' },
      body: { environmentId: 'pyenv-approved', reason: 'ok' },
    }, res)

    expect(approve).toHaveBeenCalledWith(id.toString(), {
      userId: '0123456789abcdef01234567',
      reason: 'ok',
    })
    expect(res.body.request).toMatchObject({
      id: id.toString(),
      status: 'approved',
      environmentId: 'pyenv-approved',
    })
  })

  it('lets project writers approve low-risk project dependency requests', async () => {
    const id = new ObjectId()
    checkProjectWriteAccess.mockResolvedValue(true)
    const get = vi.fn(async () => ({
      _id: id,
      projectId: 'project-1',
      status: 'pending',
      requestedNetworkPolicy: 'none',
      riskTier: 'low',
      policyFindings: [],
    }))
    const approve = vi.fn(async () => ({
      _id: id,
      projectId: 'project-1',
      status: 'approved',
      environmentId: 'pyenv_project',
    }))
    const controller = new PythonDependencyController({
      requestService: { get, approve },
    })
    const res = responseMock()

    await controller.approveProjectRequest({
      params: { projectId: 'project-1', requestId: id.toString() },
      headers: { 'x-user-id': '0123456789abcdef01234567' },
      body: { reason: 'project helper script' },
    }, res)

    expect(checkProjectWriteAccess).toHaveBeenCalledWith(
      'project-1',
      '0123456789abcdef01234567'
    )
    expect(approve).toHaveBeenCalledWith(id.toString(), {
      userId: '0123456789abcdef01234567',
      reason: 'project helper script',
      approvalScope: 'project-owner',
    })
    expect(res.body.request).toMatchObject({
      id: id.toString(),
      status: 'approved',
      environmentId: 'pyenv_project',
    })
  })

  it('rejects project approval without write access or low-risk policy', async () => {
    const id = new ObjectId()
    const approve = vi.fn()
    const controller = new PythonDependencyController({
      requestService: {
        get: vi.fn(async () => ({
          _id: id,
          projectId: 'project-1',
          status: 'pending',
          requestedNetworkPolicy: 'none',
          riskTier: 'low',
          policyFindings: [],
        })),
        approve,
      },
    })

    checkProjectWriteAccess.mockResolvedValue(false)
    const noAccess = responseMock()
    await controller.approveProjectRequest({
      params: { projectId: 'project-1', requestId: id.toString() },
      headers: { 'x-user-id': '0123456789abcdef01234567' },
      body: {},
    }, noAccess)
    expect(noAccess.statusCode).toBe(403)

    checkProjectWriteAccess.mockResolvedValue(true)
    controller.requestService.get = vi.fn(async () => ({
      _id: id,
      projectId: 'project-1',
      status: 'pending',
      requestedNetworkPolicy: 'network',
      riskTier: 'low',
      policyFindings: [],
    }))
    const risky = responseMock()
    await controller.approveProjectRequest({
      params: { projectId: 'project-1', requestId: id.toString() },
      headers: { 'x-user-id': '0123456789abcdef01234567' },
      body: {},
    }, risky)
    expect(risky.statusCode).toBe(403)
    expect(risky.body.error).toBe('Project owner approval is not allowed for this dependency request')
    expect(approve).not.toHaveBeenCalled()
  })

  it('requires explicit low-risk classification for project owner approval', async () => {
    const id = new ObjectId()
    checkProjectWriteAccess.mockResolvedValue(true)
    const approve = vi.fn()
    const controller = new PythonDependencyController({
      requestService: {
        get: vi.fn(),
        approve,
      },
    })

    for (const request of [
      {
        _id: id,
        projectId: 'project-1',
        status: 'pending',
        requestedNetworkPolicy: 'none',
        riskTier: null,
        policyFindings: [],
      },
      {
        _id: id,
        projectId: 'project-1',
        status: 'pending',
        requestedNetworkPolicy: 'none',
        riskTier: 'medium',
        policyFindings: [],
      },
      {
        _id: id,
        projectId: 'project-1',
        status: 'pending',
        requestedNetworkPolicy: 'none',
        riskTier: 'low',
        policyFindings: [{ severity: 'high', code: 'DIRECT_URL' }],
      },
    ]) {
      controller.requestService.get.mockResolvedValueOnce(request)
      const res = responseMock()
      await controller.approveProjectRequest({
        params: { projectId: 'project-1', requestId: id.toString() },
        headers: { 'x-user-id': '0123456789abcdef01234567' },
        body: {},
      }, res)
      expect(res.statusCode).toBe(403)
      expect(res.body.error).toBe('Project owner approval is not allowed for this dependency request')
    }

    expect(approve).not.toHaveBeenCalled()
  })

  it('lets project writers deny their own project dependency requests', async () => {
    const id = new ObjectId()
    checkProjectWriteAccess.mockResolvedValue(true)
    const deny = vi.fn(async () => ({
      _id: id,
      projectId: 'project-1',
      status: 'denied',
      decisionReason: 'not needed',
    }))
    const controller = new PythonDependencyController({
      requestService: {
        get: vi.fn(async () => ({ _id: id, projectId: 'project-1' })),
        deny,
      },
    })
    const res = responseMock()

    await controller.denyProjectRequest({
      params: { projectId: 'project-1', requestId: id.toString() },
      headers: { 'x-user-id': '0123456789abcdef01234567' },
      body: { reason: 'not needed' },
    }, res)

    expect(deny).toHaveBeenCalledWith(id.toString(), {
      userId: '0123456789abcdef01234567',
      reason: 'not needed',
      approvalScope: 'project-owner',
    })
    expect(res.body.request).toMatchObject({
      status: 'denied',
      decisionReason: 'not needed',
    })
  })

  it('serializes approval and denial audit fields', () => {
    const serialized = serializeRequest({
      _id: new ObjectId('0123456789abcdef01234567'),
      scope: 'project',
      status: 'denied',
      deniedBy: 'user-1',
      deniedAt: new Date('2026-06-24T00:00:00.000Z'),
      decisionReason: 'unsafe',
    })

    expect(serialized).toMatchObject({
      id: '0123456789abcdef01234567',
      status: 'denied',
      deniedBy: 'user-1',
      deniedAt: new Date('2026-06-24T00:00:00.000Z').getTime(),
      decisionReason: 'unsafe',
    })
  })

  it('serializes resolver and snapshot audit fields', () => {
    const serialized = serializeRequest({
      _id: new ObjectId('0123456789abcdef01234567'),
      scope: 'project',
      status: 'approved',
      environmentId: 'pyenv-project',
      resolverStatus: 'resolved',
      lockHash: 'sha256:lock',
      manifestHash: 'sha256:manifest',
      sbomHash: 'sha256:sbom',
      uvVersion: 'uv 0.8.22',
      policyDecision: { status: 'approved' },
    })

    expect(serialized).toMatchObject({
      status: 'approved',
      environmentId: 'pyenv-project',
      resolverStatus: 'resolved',
      lockHash: 'sha256:lock',
      manifestHash: 'sha256:manifest',
      sbomHash: 'sha256:sbom',
      uvVersion: 'uv 0.8.22',
      policyDecision: { status: 'approved' },
    })
  })
})
