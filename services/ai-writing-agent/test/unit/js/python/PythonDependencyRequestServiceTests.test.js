import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'

const { PythonDependencyRequestService } = await import(
  '../../../../app/js/python/PythonDependencyRequestService.js'
)

function collectionMock() {
  return {
    find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  }
}

describe('PythonDependencyRequestService', () => {
  it('uses the restricted broker network policy when constructing the uv worker', () => {
    const service = new PythonDependencyRequestService({
      collection: collectionMock(),
      environmentStore: { hasSnapshot: vi.fn() },
    })

    expect(service.uvWorker.networkPolicy).toBe('restricted')
  })

  it('uses the Docker broker runner by default', () => {
    const service = new PythonDependencyRequestService({
      collection: collectionMock(),
      environmentStore: { hasSnapshot: vi.fn() },
    })

    expect(service.uvWorker.runner.constructor.name).toBe('DockerUvBrokerRunner')
    expect(service.uvWorker.runner.networkPolicy).toBe('restricted')
  })

  it('allows tests and controlled callers to override broker worker options', () => {
    const service = new PythonDependencyRequestService({
      collection: collectionMock(),
      environmentStore: { hasSnapshot: vi.fn() },
      uvWorkerOptions: { networkPolicy: 'package-index-proxy' },
    })

    expect(service.uvWorker.networkPolicy).toBe('package-index-proxy')
  })

  it('allows tests and controlled callers to override the Python environment store root', () => {
    const service = new PythonDependencyRequestService({
      collection: collectionMock(),
      environmentStoreOptions: { rootDir: '/tmp/custom-python-env-store' },
    })

    expect(service.environmentStore.rootDir).toBe('/tmp/custom-python-env-store')
  })

  it('passes configured package-index proxy options into the default broker runner', () => {
    const service = new PythonDependencyRequestService({
      collection: collectionMock(),
      environmentStore: { hasSnapshot: vi.fn() },
      uvWorkerOptions: {
        networkPolicy: 'package-index-proxy',
        packageIndexProxyNetwork: 'resink-broker-proxy-approved',
        packageIndexProxyUrl: 'http://pypi-proxy/simple',
        tempRoot: '/tmp/resink-uv-broker-workspaces',
        hostTempRoot: '/host/resink-uv-broker-workspaces',
      },
    })

    expect(service.uvWorker.networkPolicy).toBe('package-index-proxy')
    expect(service.uvWorker.packageIndexProxyUrl).toBe('http://pypi-proxy/simple')
    expect(service.uvWorker.tempRoot).toBe('/tmp/resink-uv-broker-workspaces')
    expect(service.uvWorker.runner.packageIndexProxyNetwork).toBe('resink-broker-proxy-approved')
    expect(service.uvWorker.runner.workspaceRoot).toBe('/tmp/resink-uv-broker-workspaces')
    expect(service.uvWorker.runner.workspaceHostRoot).toBe('/host/resink-uv-broker-workspaces')
  })

  it('returns approved requests only when their snapshot still exists', async () => {
    const requestId = new ObjectId()
    const collection = collectionMock()
    collection.findOne.mockResolvedValue({
      _id: requestId,
      projectId: 'project-1',
      skillName: 'dependency-smoke',
      fingerprint: 'sha256:request',
      status: 'approved',
      environmentId: 'pyenv_skill_dependency-smoke_request',
    })
    const environmentStore = {
      hasSnapshot: vi.fn(async () => false),
    }
    const service = new PythonDependencyRequestService({
      collection,
      environmentStore,
    })

    const missingSnapshot = await service.findApprovedByFingerprint('sha256:request', {
      projectId: 'project-1',
      skillName: 'dependency-smoke',
    })
    expect(missingSnapshot).toBeNull()
    expect(environmentStore.hasSnapshot).toHaveBeenCalledWith(
      'pyenv_skill_dependency-smoke_request'
    )

    environmentStore.hasSnapshot.mockResolvedValue(true)
    const available = await service.findApprovedByFingerprint('sha256:request', {
      projectId: 'project-1',
      skillName: 'dependency-smoke',
    })
    expect(available).toMatchObject({
      _id: requestId,
      environmentId: 'pyenv_skill_dependency-smoke_request',
    })
  })

  it('cleans environment snapshots while keeping approved request environments', async () => {
    const docs = [
      { status: 'approved', environmentId: 'pyenv_keep' },
      { status: 'denied', environmentId: 'pyenv_old' },
      { status: 'approved', environmentId: null },
    ]
    const collection = {
      find: vi.fn(query => ({
        project: vi.fn(() => ({
          toArray: vi.fn(async () => docs.filter(doc => doc.status === query.status)),
        })),
      })),
    }
    const environmentStore = {
      cleanup: vi.fn(async input => ({
        removed: [{ environmentId: 'pyenv_old' }],
        kept: [{ environmentId: 'pyenv_keep' }],
        keepEnvironmentIds: input.keepEnvironmentIds,
      })),
    }
    const service = new PythonDependencyRequestService({
      collection,
      environmentStore,
    })

    const result = await service.cleanupEnvironmentSnapshots({
      olderThanMs: 1000,
      maxTotalBytes: 1024,
    })

    expect(environmentStore.cleanup).toHaveBeenCalledWith({
      olderThanMs: 1000,
      maxTotalBytes: 1024,
      keepEnvironmentIds: ['pyenv_keep'],
    })
    expect(result).toMatchObject({
      removed: [{ environmentId: 'pyenv_old' }],
      kept: [{ environmentId: 'pyenv_keep' }],
    })
  })

  it('upserts normalized dependency requests by fingerprint and project', async () => {
    const collection = collectionMock()
    collection.findOneAndUpdate.mockResolvedValue({
      value: { _id: new ObjectId(), status: 'pending' },
    })
    const service = new PythonDependencyRequestService({
      collection,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    await service.upsertFromDependencyRequest({
      projectId: 'project-1',
      userId: 'user-1',
      dependencyRequest: {
        fingerprint: 'sha256:request',
        scope: 'project',
        requestedPackages: [{ name: 'pandas' }],
      },
    })

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { fingerprint: 'sha256:request', projectId: 'project-1' },
      expect.objectContaining({
        $setOnInsert: { createdAt: new Date('2026-06-24T00:00:00.000Z') },
        $set: expect.objectContaining({
          projectId: 'project-1',
          userId: 'user-1',
          status: 'pending',
          fingerprint: 'sha256:request',
        }),
      }),
      { upsert: true, returnDocument: 'after' }
    )
  })

  it('denies requests with audit fields', async () => {
    const requestId = new ObjectId()
    const collection = collectionMock()
    collection.findOneAndUpdate.mockResolvedValue({
      value: { _id: requestId, status: 'denied' },
    })
    const service = new PythonDependencyRequestService({
      collection,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    await service.deny(requestId, {
      userId: 'user-2',
      reason: 'unsafe',
    })

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: requestId },
      {
        $set: expect.objectContaining({
          status: 'denied',
          deniedBy: 'user-2',
          decisionReason: 'unsafe',
        }),
      },
      { returnDocument: 'after' }
    )
  })

  it('resolves pending requests with uv and creates an approved snapshot', async () => {
    const requestId = new ObjectId()
    const collection = collectionMock()
    const request = {
      _id: requestId,
      projectId: 'project-1',
      scope: 'project',
      status: 'failed',
      fingerprint: 'sha256:request',
      resolverError: { code: 'UV_RESOLUTION_FAILED', exitCode: 1 },
      sourceFiles: [{ path: 'pyproject.toml', kind: 'pyproject' }],
      requestedPackages: [{ name: 'pandas', raw: 'pandas==2.2.3' }],
      requestedPythonVersion: '>=3.12',
      requestedNetworkPolicy: 'none',
    }
    collection.findOne.mockResolvedValue(request)
    collection.findOneAndUpdate.mockImplementation(async (_query, update) => ({
      value: { ...request, ...update.$set },
    }))
    const uvWorker = {
      resolve: vi.fn(async () => ({
        ok: true,
        status: 'resolved',
        request,
        policyDecision: { status: 'approved', riskTier: 'low', findings: [] },
        uvVersion: 'uv 0.8.22',
        artifacts: {
          'uv.lock': {
            content: 'version = 1\n',
            hash: 'sha256:lock',
          },
        },
        audit: {
          manifestHash: 'sha256:manifest',
          sbomHash: 'sha256:sbom',
          manifest: { artifactHashes: { 'uv.lock': 'sha256:lock' } },
          sbom: { packages: [{ name: 'pandas' }] },
        },
      })),
    }
    const environmentStore = {
      putSnapshot: vi.fn(async input => ({ environmentId: input.environmentId })),
    }
    const service = new PythonDependencyRequestService({
      collection,
      uvWorker,
      environmentStore,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    await service.approve(requestId.toString(), {
      userId: 'admin-1',
      reason: 'approved for project',
    })

    expect(uvWorker.resolve).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        _id: requestId,
        projectId: 'project-1',
        status: 'resolving',
        resolverLeaseId: expect.any(String),
        fingerprint: 'sha256:request',
      }),
      mode: 'project-lock',
      files: [
        expect.objectContaining({
          path: 'pyproject.toml',
          content: expect.stringContaining('pandas==2.2.3'),
        }),
      ],
    }))
    expect(environmentStore.putSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: 'pyenv_project_project-1_request',
      scope: 'project',
      projectId: 'project-1',
      lockHash: 'sha256:lock',
      manifestHash: 'sha256:manifest',
      sbomHash: 'sha256:sbom',
      uvVersion: 'uv 0.8.22',
      approvedBy: 'admin-1',
      approvedAt: '2026-06-24T00:00:00.000Z',
      files: [
        expect.objectContaining({
          path: 'uv.lock',
          content: 'version = 1\n',
        }),
      ],
    }))
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: requestId },
      {
        $set: expect.objectContaining({
          status: 'approved',
          environmentId: 'pyenv_project_project-1_request',
          approvedBy: 'admin-1',
          decisionReason: 'approved for project',
          lockHash: 'sha256:lock',
          manifestHash: 'sha256:manifest',
          sbomHash: 'sha256:sbom',
        }),
        $unset: {
          resolverError: '',
        },
      },
      { returnDocument: 'after' }
    )
  })

  it('does not let approve bypass uv resolution with a supplied environment id', async () => {
    const requestId = new ObjectId()
    const collection = collectionMock()
    const request = {
      _id: requestId,
      projectId: 'project-1',
      scope: 'project',
      status: 'pending',
      fingerprint: 'sha256:request',
      sourceFiles: [],
      requestedPackages: [],
    }
    collection.findOne.mockResolvedValue(request)
    collection.findOneAndUpdate.mockImplementation(async (_query, update) => ({
      value: { ...request, ...update.$set },
    }))
    const uvWorker = {
      resolve: vi.fn(async () => ({
        ok: true,
        status: 'resolved',
        request,
        policyDecision: { status: 'approved', riskTier: 'low', findings: [] },
        artifacts: { 'uv.lock': { content: 'version = 1\n', hash: 'sha256:lock' } },
        audit: { manifestHash: 'sha256:manifest', sbomHash: 'sha256:sbom' },
      })),
    }
    const service = new PythonDependencyRequestService({
      collection,
      uvWorker,
      environmentStore: { putSnapshot: vi.fn() },
    })

    await service.approve(requestId.toString(), {
      userId: 'admin-1',
      environmentId: 'pyenv-manual-bypass',
    })

    expect(uvWorker.resolve).toHaveBeenCalled()
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: requestId },
      expect.objectContaining({
        $set: expect.objectContaining({
          environmentId: 'pyenv_project_project-1_request',
        }),
      }),
      { returnDocument: 'after' }
    )
  })

  it('does not run uv when another resolver lease is still active', async () => {
    const requestId = new ObjectId()
    const request = {
      _id: requestId,
      projectId: 'project-1',
      scope: 'project',
      status: 'resolving',
      resolverLeaseId: 'lease-active',
      resolvingLeaseExpiresAt: new Date('2026-06-24T00:10:00.000Z'),
      fingerprint: 'sha256:active',
      sourceFiles: [],
      requestedPackages: [],
    }
    const collection = collectionMock()
    collection.findOneAndUpdate.mockResolvedValue(null)
    collection.findOne.mockResolvedValue(request)
    const uvWorker = { resolve: vi.fn() }
    const service = new PythonDependencyRequestService({
      collection,
      uvWorker,
      environmentStore: { putSnapshot: vi.fn() },
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    const result = await service.approve(requestId, { userId: 'admin-1' })

    expect(result).toBe(request)
    expect(uvWorker.resolve).not.toHaveBeenCalled()
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: requestId,
        $or: expect.any(Array),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'resolving',
          resolverLeaseId: expect.any(String),
        }),
      }),
      { returnDocument: 'after' }
    )
  })

  it('can recover stale resolving requests by acquiring a new resolver lease', async () => {
    const requestId = new ObjectId()
    const request = {
      _id: requestId,
      projectId: 'project-1',
      scope: 'project',
      status: 'resolving',
      resolverLeaseId: 'lease-old',
      resolvingLeaseExpiresAt: new Date('2026-06-23T23:00:00.000Z'),
      fingerprint: 'sha256:stale',
      sourceFiles: [],
      requestedPackages: [],
    }
    const collection = collectionMock()
    collection.findOneAndUpdate.mockImplementation(async (_query, update) => ({
      value: { ...request, ...update.$set },
    }))
    const uvWorker = {
      resolve: vi.fn(async () => ({
        ok: true,
        status: 'resolved',
        request,
        policyDecision: { status: 'approved', riskTier: 'low', findings: [] },
        artifacts: { 'uv.lock': { content: 'version = 1\n', hash: 'sha256:lock' } },
        audit: { manifestHash: 'sha256:manifest', sbomHash: 'sha256:sbom' },
      })),
    }
    const service = new PythonDependencyRequestService({
      collection,
      uvWorker,
      environmentStore: { putSnapshot: vi.fn() },
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    await service.approve(requestId, { userId: 'admin-1' })

    expect(uvWorker.resolve).toHaveBeenCalled()
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: requestId,
        $or: expect.arrayContaining([
          { status: 'resolving', resolvingLeaseExpiresAt: { $lte: new Date('2026-06-24T00:00:00.000Z') } },
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'resolving',
          resolvingStartedAt: new Date('2026-06-24T00:00:00.000Z'),
          resolvingLeaseExpiresAt: new Date('2026-06-24T00:15:00.000Z'),
        }),
      }),
      { returnDocument: 'after' }
    )
  })

  it('does not approve or publish snapshots when the resolver denies a request', async () => {
    const requestId = new ObjectId()
    const collection = collectionMock()
    const request = {
      _id: requestId,
      projectId: 'project-1',
      scope: 'project',
      status: 'pending',
      fingerprint: 'sha256:denied',
      sourceFiles: [],
      requestedPackages: [{ name: 'evil', raw: 'evil @ https://example.test/evil.whl' }],
    }
    collection.findOne.mockResolvedValue(request)
    collection.findOneAndUpdate.mockImplementation(async (_query, update) => ({
      value: { ...request, ...update.$set },
    }))
    const uvWorker = {
      resolve: vi.fn(async () => ({
        ok: false,
        status: 'denied',
        request,
        policyDecision: {
          status: 'denied',
          riskTier: 'high',
          findings: [{ code: 'DENIED_DEPENDENCY_SOURCE', severity: 'high' }],
        },
        artifacts: {},
      })),
    }
    const environmentStore = {
      putSnapshot: vi.fn(),
    }
    const service = new PythonDependencyRequestService({
      collection,
      uvWorker,
      environmentStore,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    const denied = await service.approve(requestId, {
      userId: 'admin-1',
      reason: 'reviewed unsafe source',
    })

    expect(denied).toMatchObject({
      status: 'denied',
      resolverStatus: 'denied',
      decisionReason: 'reviewed unsafe source',
    })
    expect(denied.environmentId).toBeUndefined()
    expect(environmentStore.putSnapshot).not.toHaveBeenCalled()
  })

  it('marks requests failed when uv resolution fails before snapshot publish', async () => {
    const requestId = new ObjectId()
    const collection = collectionMock()
    const request = {
      _id: requestId,
      projectId: 'project-1',
      scope: 'project',
      status: 'pending',
      fingerprint: 'sha256:failed',
      sourceFiles: [],
      requestedPackages: [{ name: 'pandas', raw: 'pandas==999.999.999' }],
    }
    collection.findOne.mockResolvedValue(request)
    collection.findOneAndUpdate.mockImplementation(async (_query, update) => ({
      value: { ...request, ...update.$set },
    }))
    const uvWorker = {
      resolve: vi.fn(async () => ({
        ok: false,
        status: 'failed',
        request,
        error: { code: 'UV_RESOLUTION_FAILED', exitCode: 1 },
        policyDecision: { status: 'needs-approval', riskTier: 'medium', findings: [] },
        artifacts: {},
      })),
    }
    const environmentStore = {
      putSnapshot: vi.fn(),
    }
    const service = new PythonDependencyRequestService({
      collection,
      uvWorker,
      environmentStore,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    const failed = await service.approve(requestId, {
      userId: 'admin-1',
      reason: 'try resolver',
    })

    expect(failed).toMatchObject({
      status: 'failed',
      resolverStatus: 'failed',
      resolverError: { code: 'UV_RESOLUTION_FAILED', exitCode: 1 },
    })
    expect(environmentStore.putSnapshot).not.toHaveBeenCalled()
  })

  it('marks requests failed when resolver or snapshot publish throws', async () => {
    const requestId = new ObjectId()
    const collection = collectionMock()
    const request = {
      _id: requestId,
      projectId: 'project-1',
      scope: 'project',
      status: 'pending',
      fingerprint: 'sha256:throw',
      sourceFiles: [],
      requestedPackages: [],
    }
    collection.findOne.mockResolvedValue(request)
    collection.findOneAndUpdate.mockImplementation(async (_query, update) => ({
      value: { ...request, ...update.$set },
    }))
    const service = new PythonDependencyRequestService({
      collection,
      uvWorker: {
        resolve: vi.fn(async () => {
          throw new Error('uv crashed')
        }),
      },
      environmentStore: { putSnapshot: vi.fn() },
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    const failed = await service.approve(requestId, { userId: 'admin-1' })

    expect(failed).toMatchObject({
      status: 'failed',
      resolverStatus: 'failed',
      resolverError: {
        code: 'PYTHON_ENV_APPROVAL_FAILED',
        message: 'uv crashed',
      },
    })
  })
})
