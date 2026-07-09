import path from 'node:path'
import settings from '@overleaf/settings'
import { SandboxEnvironmentStore, normalizeEnvironmentId } from './SandboxEnvironmentStore.js'
import { PythonEnvironmentUsageService } from './PythonEnvironmentUsageService.js'
import { SandboxPolicyError } from '../sandbox/SandboxErrors.js'

const RUNTIME_ENV_ROOT = '.agent/python-envs'
const UNSUPPORTED_IMMUTABLE_MOUNT_REASON = 'immutable-runtime-env-mount-unsupported'

export class PythonRuntimeMountService {
  constructor(options = {}) {
    this.environmentStore =
      options.environmentStore ||
      new SandboxEnvironmentStore({
        rootDir:
          settings.aiAssistant?.pythonDependencyBroker?.environmentStoreRoot ||
          undefined,
      })
    this.usageService = options.usageService || new PythonEnvironmentUsageService()
    this.now = options.now || (() => new Date())
  }

  async attach(input = {}, context = {}) {
    const sandboxSession = context.persistentWorkspace?.sandboxSession
    if (!sandboxSession) {
      throw new Error('Python environment attachment requires a persistent sandbox workspace')
    }
    const environmentId = normalizeEnvironmentId(input.environmentId)
    const snapshot = await this.environmentStore.getSnapshot(environmentId)
    const targetRoot = path.posix.join(RUNTIME_ENV_ROOT, environmentId)
    const writeRuntimeFile = buildRuntimeFileWriter(sandboxSession, environmentId, targetRoot)

    for (const file of snapshot.manifest.files) {
      const content = snapshot.readVerifiedFile
        ? await snapshot.readVerifiedFile(file)
        : await snapshot.readFile(file.path)
      await writeRuntimeFile(file.path, content)
    }

    const attachedAt = this.now().toISOString()
    const runtimeManifest = {
      ...snapshot.manifest,
      attachedAt,
      workspaceId: context.persistentWorkspace?.workspace?._id || null,
      sandboxSessionId: sandboxSession.id || null,
    }
    await writeRuntimeFile(
      '.resink-env-manifest.json',
      `${JSON.stringify(runtimeManifest, null, 2)}\n`
    )
    const usage = await this.usageService.recordAttached({
      environmentId,
      projectId: context.projectId || null,
      sessionId: context.sessionId || null,
      turnId: context.turnId || null,
      skillName: input.skillName || null,
      scriptPath: input.scriptPath || null,
      attachedAt,
    })

    return {
      environmentId,
      targetRoot,
      manifest: runtimeManifest,
      env: buildRuntimeEnv(targetRoot, snapshot.manifest.runtime),
      usageId: usage?._id?.toString?.() || null,
      events: [{
        type: 'python_environment.attached',
        environmentId,
        usageId: usage?._id?.toString?.() || null,
        targetRoot,
        sessionId: context.sessionId,
        turnId: context.turnId || null,
        workspaceId: context.persistentWorkspace?.workspace?._id || null,
        sandboxSessionId: sandboxSession.id || null,
        attachedAt,
      }],
    }
  }
}

function buildRuntimeFileWriter(sandboxSession, environmentId, targetRoot) {
  if (
    sandboxSession.capabilities?.immutableRuntimeEnvironmentMount === true &&
    typeof sandboxSession.writeRuntimeEnvironmentFile === 'function'
  ) {
    return (filePath, content) =>
      sandboxSession.writeRuntimeEnvironmentFile(environmentId, filePath, content)
  }
  throw new SandboxPolicyError(
    `Sandbox provider does not support immutable Python environment mounts for ${targetRoot}`,
    {
      code: 'PYTHON_ENV_IMMUTABLE_MOUNT_UNSUPPORTED',
      reason: UNSUPPORTED_IMMUTABLE_MOUNT_REASON,
      targetRoot,
      environmentId,
      providerCapabilities: sandboxSession.capabilities || {},
    }
  )
}

function buildRuntimeEnv(targetRoot, runtime = {}) {
  const sitePackages = Array.isArray(runtime?.sitePackages)
    ? runtime.sitePackages
    : []
  if (sitePackages.length === 0) return {}
  return {
    PYTHONPATH: sitePackages
      .map(sitePackagePath => path.posix.join(targetRoot, sitePackagePath))
      .join(':'),
  }
}

export default PythonRuntimeMountService
