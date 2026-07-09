import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LocalDockerSandboxProvider,
} from '../../../../app/js/sandbox/LocalDockerSandboxProvider.js'
import {
  SandboxNotFoundError,
  SandboxOutputLimitError,
  SandboxPathError,
  SandboxPolicyError,
  SandboxSetupError,
  SandboxTimeoutError,
} from '../../../../app/js/sandbox/SandboxErrors.js'

function createCommandRunner(handler = async () => ({ exitCode: 0 })) {
  const commandRunner = {
    calls: [],
    run: null,
  }
  commandRunner.run = vi.fn(async (command, args, options) => {
    const call = { command, args, options }
    const result = await handler(call)
    const normalized = {
      exitCode: 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      outputLimited: false,
      ...result,
    }
    commandRunner.calls.push(call)
    return normalized
  })
  return commandRunner
}

let runner

async function collect(asyncIterable) {
  const events = []
  for await (const event of asyncIterable) {
    events.push(event)
  }
  return events
}

async function expectRejectsWith(promise, ErrorClass) {
  try {
    await promise
    expect.unreachable(`Expected ${ErrorClass.name}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorClass)
  }
}

function dockerInspectMounts({ workspacePath, runtimeEnvironmentPath }) {
  return Buffer.from(JSON.stringify([{
    Mounts: [
      {
        Source: workspacePath,
        Destination: '/workspace',
        RW: true,
      },
      {
        Source: runtimeEnvironmentPath,
        Destination: '/workspace/.agent/python-envs',
        RW: false,
      },
    ],
  }]))
}

describe('LocalDockerSandboxProvider', () => {
  let rootDir

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'sandbox-provider-test-'))
    runner = null
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  function buildProvider(options = {}) {
    runner = options.commandRunner || createCommandRunner()
    return new LocalDockerSandboxProvider({
      rootDir,
      commandRunner: runner,
      timeoutMs: 1234,
      maxOutputBytes: 42,
      image: 'test-image:latest',
      ...options,
    })
  }

  it('uses an optional Docker-visible root for bind mount sources', async () => {
    const provider = buildProvider({ dockerRootDir: '/host/sandboxes' })

    const session = await provider.createSession({ id: 'session-host-root' })

    expect(session.workspacePath).toBe(
      path.join(rootDir, 'session-host-root', 'workspace')
    )
    expect(runner.calls[0].args).toContain(
      'type=bind,src=/host/sandboxes/session-host-root/workspace,dst=/workspace'
    )
    expect(runner.calls[0].args).toContain(
      'type=bind,src=/host/sandboxes/session-host-root/runtime-python-envs,dst=/workspace/.agent/python-envs,readonly'
    )
  })

  it('creates a Docker-backed session with a scoped temporary workspace', async () => {
    const provider = buildProvider()

    const session = await provider.createSession({ id: 'session-1' })

    expect(session.id).toBe('session-1')
    expect(session.workspacePath).toBe(
      path.join(rootDir, 'session-1', 'workspace')
    )
    expect(runner.run).toHaveBeenCalledTimes(2)
    expect(runner.calls[0].args).toEqual([
      'create',
      '--name',
      'overleaf-ai-sandbox-session-1',
      '--label',
      'overleaf.ai.sandbox.provider=local-docker',
      '--label',
      'overleaf.ai.sandbox.managed=true',
      '--label',
      'overleaf.ai.sandbox.session=session-1',
      '--network',
      'none',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,src=${session.workspacePath},dst=/workspace`,
      '--mount',
      `type=bind,src=${path.join(rootDir, 'session-1', 'runtime-python-envs')},dst=/workspace/.agent/python-envs,readonly`,
      'test-image:latest',
      'sh',
      '-c',
      'sleep infinity',
    ])
    expect(runner.calls[1].args).toEqual([
      'start',
      'overleaf-ai-sandbox-session-1',
    ])
  })

  it('adds Docker resource limits, labels, and resolved network policy', async () => {
    const provider = buildProvider({
      networkPolicy: 'development-permissive',
      memoryBytes: 268435456,
      memorySwapBytes: 268435456,
      cpuCount: 0.5,
      pidsLimit: 64,
      maxFileCount: 10,
    })

    const session = await provider.createSession({ id: 'limited-session' })

    expect(session.maxFileCount).toBe(10)
    expect(runner.calls[0].args).toEqual([
      'create',
      '--name',
      'overleaf-ai-sandbox-limited-session',
      '--label',
      'overleaf.ai.sandbox.provider=local-docker',
      '--label',
      'overleaf.ai.sandbox.managed=true',
      '--label',
      'overleaf.ai.sandbox.session=limited-session',
      '--network',
      'bridge',
      '--memory',
      '268435456',
      '--memory-swap',
      '268435456',
      '--cpus',
      '0.5',
      '--pids-limit',
      '64',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,src=${session.workspacePath},dst=/workspace`,
      '--mount',
      `type=bind,src=${path.join(rootDir, 'limited-session', 'runtime-python-envs')},dst=/workspace/.agent/python-envs,readonly`,
      'test-image:latest',
      'sh',
      '-c',
      'sleep infinity',
    ])
  })

  it('writes broker-approved Python environments outside the writable workspace mount', async () => {
    const provider = buildProvider({ dockerRootDir: '/host/sandboxes' })
    const session = await provider.createSession({ id: 'python-env-session' })

    await session.writeRuntimeEnvironmentFile(
      'pyenv_demo',
      'site-packages/pkg.py',
      'approved'
    )

    const runtimePath = path.join(
      rootDir,
      'python-env-session',
      'runtime-python-envs',
      'pyenv_demo',
      'site-packages',
      'pkg.py'
    )
    expect(await readFile(runtimePath, 'utf8')).toBe('approved')
    await expectRejectsWith(
      session.writeRuntimeEnvironmentFile('../escape', 'pkg.py', 'no'),
      SandboxPathError
    )
    await expectRejectsWith(
      session.writeRuntimeEnvironmentFile('pyenv_demo', '../escape.py', 'no'),
      SandboxPathError
    )
    await expectRejectsWith(
      access(path.join(
        session.workspacePath,
        '.agent',
        'python-envs',
        'pyenv_demo',
        'site-packages',
        'pkg.py'
      )),
      Error
    )
  })

  it('allows explicit Docker network names through network policy', async () => {
    const provider = buildProvider({
      networkPolicy: 'docker-network:ai-egress',
    })

    await provider.createSession({ id: 'network-session' })

    expect(runner.calls[0].args).toContain('ai-egress')
  })

  it('rejects unsupported network policies before creating a container', async () => {
    const provider = buildProvider({ networkPolicy: 'host' })

    await expectRejectsWith(
      provider.createSession({ id: 'bad-network' }),
      SandboxPolicyError
    )
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('resumes and destroys a session, cleaning the workspace directory', async () => {
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'session-2' })

    expect(await provider.resumeSession('session-2')).toBe(session)

    await provider.destroySession('session-2')

    expect(runner.calls.at(-1).args).toEqual([
      'rm',
      '-f',
      'overleaf-ai-sandbox-session-2',
    ])
    await expectRejectsWith(
      stat(path.dirname(session.workspacePath)),
      Error
    )
    await expectRejectsWith(
      provider.resumeSession('session-2'),
      SandboxNotFoundError
    )
  })

  it('rebuilds a persisted session from workspace metadata', async () => {
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'persisted-session' })
    await session.writeFile('notes/state.txt', 'still here')
    const restoredProvider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'inspect') {
          return {
            stdout: dockerInspectMounts({
              workspacePath: session.workspacePath,
              runtimeEnvironmentPath: session.runtimeEnvironmentPath,
            }),
          }
        }
        return { exitCode: 0 }
      }),
    })

    const restored = await restoredProvider.resumeSession('persisted-session', {
      workspacePath: session.workspacePath,
      containerName: session.containerName,
    })

    expect(await restored.readFile('notes/state.txt')).toEqual(
      Buffer.from('still here')
    )

    await provider.destroySession('persisted-session')
  })

  it('rejects persisted sessions whose Docker container is missing', async () => {
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'missing-container' })
    const restoredProvider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'inspect') {
          return { exitCode: 1, stderr: Buffer.from('No such container') }
        }
        return { exitCode: 0 }
      }),
    })

    await expectRejectsWith(
      restoredProvider.resumeSession('missing-container', {
        workspacePath: session.workspacePath,
        containerName: session.containerName,
      }),
      SandboxNotFoundError
    )

    await provider.destroySession('missing-container')
  })

  it('rejects persisted sessions whose existing container has stale mounts', async () => {
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'stale-mounts' })
    const restoredProvider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'inspect') {
          return {
            stdout: Buffer.from(JSON.stringify([{
              Mounts: [{
                Source: '/old/root/workspace',
                Destination: '/workspace',
                RW: true,
              }],
            }])),
          }
        }
        return { exitCode: 0 }
      }),
    })

    await expectRejectsWith(
      restoredProvider.resumeSession('stale-mounts', {
        workspacePath: session.workspacePath,
        runtimeEnvironmentPath: session.runtimeEnvironmentPath,
        containerName: session.containerName,
      }),
      SandboxNotFoundError
    )

    await provider.destroySession('stale-mounts')
  })

  it('destroys a persisted session from workspace metadata', async () => {
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'destroy-persisted' })
    const workspaceRoot = path.dirname(session.workspacePath)
    const restoredProvider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'inspect') {
          return {
            stdout: dockerInspectMounts({
              workspacePath: session.workspacePath,
              runtimeEnvironmentPath: session.runtimeEnvironmentPath,
            }),
          }
        }
        return { exitCode: 0 }
      }),
    })

    await restoredProvider.destroySession('destroy-persisted', {
      workspacePath: session.workspacePath,
      containerName: session.containerName,
    })

    let accessError = null
    try {
      await access(workspaceRoot)
    } catch (error) {
      accessError = error
    }
    expect(accessError).toMatchObject({ code: 'ENOENT' })
  })

  it('cleans the workspace when Docker create fails', async () => {
    const failingRunner = createCommandRunner(async ({ args }) => {
      if (args[0] === 'create') {
        return {
          exitCode: 1,
          stderr: Buffer.from('docker unavailable'),
        }
      }
      return { exitCode: 0 }
    })
    const provider = buildProvider({ commandRunner: failingRunner })

    await expectRejectsWith(
      provider.createSession({ id: 'bad-session' }),
      SandboxSetupError
    )
    expect(failingRunner.calls.at(-1).args).toEqual([
      'rm',
      '-f',
      'overleaf-ai-sandbox-bad-session',
    ])
    await expectRejectsWith(stat(path.join(rootDir, 'bad-session')), Error)
  })

  it('rejects unsafe session ids before creating a workspace', async () => {
    const provider = buildProvider()

    await expectRejectsWith(
      provider.createSession({ id: '../bad' }),
      SandboxSetupError
    )
    await expectRejectsWith(stat(path.join(rootDir, '..', 'bad')), Error)
  })

  it('runs commands through docker exec and streams normalized events', async () => {
    const provider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'exec') {
          return {
            exitCode: 7,
            stdout: Buffer.from('hello\n'),
            stderr: Buffer.from('warn\n'),
          }
        }
        return { exitCode: 0 }
      }),
    })
    const session = await provider.createSession({ id: 'run-session' })

    const events = await collect(session.run({
      command: ['sh', '-c', 'echo hello'],
      timeoutMs: 500,
      maxOutputBytes: 10,
      workdir: 'chapters',
    }))

    expect(runner.calls.at(-1).args).toEqual([
      'exec',
      '--workdir',
      '/workspace/chapters',
      'overleaf-ai-sandbox-run-session',
      'sh',
      '-c',
      'echo hello',
    ])
    expect(runner.calls.at(-1).options).toEqual({
      timeoutMs: 500,
      maxOutputBytes: 10,
    })
    expect(events).toEqual([
      {
        type: 'start',
        sessionId: 'run-session',
        command: ['sh', '-c', 'echo hello'],
      },
      { type: 'stdout', data: 'hello\n' },
      { type: 'stderr', data: 'warn\n' },
      { type: 'exit', exitCode: 7, signal: null },
    ])
  })

  it('supports runtime adapter command shape and process-scoped env vars', async () => {
    const provider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'exec') {
          return { stdout: Buffer.from('ok\n') }
        }
        return { exitCode: 0 }
      }),
    })
    const session = await provider.createSession({ id: 'runtime-session' })

    await collect(session.run({
      command: 'opencode',
      args: ['run', '--print', '--', 'hello'],
      env: {
        OPENAI_API_KEY: 'sk-test',
      },
    }))

    expect(runner.calls.at(-1).args).toEqual([
      'exec',
      '--workdir',
      '/workspace',
      '--env',
      'OPENAI_API_KEY=sk-test',
      'overleaf-ai-sandbox-runtime-session',
      'opencode',
      'run',
      '--print',
      '--',
      'hello',
    ])
  })

  it('throws on command timeout', async () => {
    const provider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'exec') return { timedOut: true, exitCode: null }
        return { exitCode: 0 }
      }),
    })
    const session = await provider.createSession({ id: 'timeout-session' })

    await expectRejectsWith(
      collect(session.run({ command: ['sleep', '9'] })),
      SandboxTimeoutError
    )
  })

  it('throws on max output limit', async () => {
    const provider = buildProvider({
      commandRunner: createCommandRunner(async ({ args }) => {
        if (args[0] === 'exec') return { outputLimited: true, exitCode: null }
        return { exitCode: 0 }
      }),
    })
    const session = await provider.createSession({ id: 'output-session' })

    await expectRejectsWith(
      collect(session.run({ command: ['cat', 'large.log'] })),
      SandboxOutputLimitError
    )
  })

  it('reads, writes, lists files, and collects artifacts inside the workspace', async () => {
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'file-session' })

    await session.writeFile('main.tex', '\\begin{document}\nHi\n')
    await session.writeFile('build/output.pdf', Buffer.from('%PDF-test'))
    await session.writeFile('build/output.log', 'log')

    const content = await session.readFile('main.tex')
    const files = await session.listFiles('.')
    const artifacts = await session.collectArtifacts(['build/*.pdf'])

    expect(content.toString('utf-8')).toBe('\\begin{document}\nHi\n')
    expect(files.map(file => file.path)).toEqual([
      'build/output.log',
      'build/output.pdf',
      'main.tex',
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].path).toBe('build/output.pdf')
    expect(artifacts[0].content.toString()).toBe('%PDF-test')
  })

  it('rejects paths that escape the sandbox workspace', async () => {
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'scope-session' })

    await expectRejectsWith(
      session.writeFile('../escape.txt', 'no'),
      SandboxPathError
    )
    await expectRejectsWith(session.readFile('/etc/passwd'), SandboxPathError)
    await expectRejectsWith(session.listFiles('nested\\bad'), SandboxPathError)
    await expectRejectsWith(
      session.collectArtifacts(['../*.pdf']),
      SandboxPathError
    )
  })

  it('rejects symlink paths that resolve outside the sandbox workspace', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'sandbox-outside-'))
    const provider = buildProvider()
    const session = await provider.createSession({ id: 'symlink-session' })
    await writeFile(path.join(outsideDir, 'secret.txt'), 'secret')
    await symlink(outsideDir, path.join(session.workspacePath, 'outside-link'))

    await expectRejectsWith(
      session.readFile('outside-link/secret.txt'),
      SandboxPathError
    )
    await expectRejectsWith(
      session.writeFile('outside-link/new.txt', 'no'),
      SandboxPathError
    )
    await expectRejectsWith(
      session.writeFile('outside-link/nested/new.txt', 'no'),
      SandboxPathError
    )
    await expectRejectsWith(
      access(path.join(outsideDir, 'nested')),
      Error
    )
    await expectRejectsWith(
      session.listFiles('outside-link'),
      SandboxPathError
    )

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('enforces max artifact bytes', async () => {
    const provider = buildProvider({ maxArtifactBytes: 3 })
    const session = await provider.createSession({ id: 'artifact-session' })
    await session.writeFile('out.pdf', '1234')

    await expectRejectsWith(
      session.collectArtifacts(['*.pdf']),
      SandboxOutputLimitError
    )
  })

  it('enforces max file count when listing workspace files', async () => {
    const provider = buildProvider({ maxFileCount: 2 })
    const session = await provider.createSession({ id: 'file-limit-session' })
    await session.writeFile('a.txt', 'a')
    await session.writeFile('b.txt', 'b')
    await session.writeFile('nested/c.txt', 'c')

    try {
      await session.listFiles('.')
      expect.unreachable('Expected file count limit')
    } catch (error) {
      expect(error).toMatchObject({ code: 'SANDBOX_FILE_COUNT_LIMIT' })
    }
  })

  it('cleans orphaned managed containers and workspaces on startup', async () => {
    const cleanupRunner = createCommandRunner(async ({ args }) => {
      if (args[0] === 'ps') {
        return {
          stdout: Buffer.from(
            'overleaf-ai-sandbox-active\n' +
            'overleaf-ai-sandbox-orphan\n'
          ),
        }
      }
      return { exitCode: 0 }
    })
    const provider = buildProvider({ commandRunner: cleanupRunner })
    const active = await provider.createSession({ id: 'active' })
    await provider.createSession({ id: 'orphan-workspace' })
    provider.sessions.delete('orphan-workspace')

    const result = await provider.startupCleanup()

    expect(result.removedContainers).toEqual(['overleaf-ai-sandbox-orphan'])
    expect(result.removedWorkspaces).toEqual([
      path.join(rootDir, 'orphan-workspace'),
    ])
    expect(cleanupRunner.calls.some(call => (
      call.args.join(' ') === 'rm -f overleaf-ai-sandbox-active'
    ))).toBe(false)
    await expect(stat(path.dirname(active.workspacePath))).resolves.toBeTruthy()
  })

  it('manual cleanup can include active managed containers and workspaces', async () => {
    const cleanupRunner = createCommandRunner(async ({ args }) => {
      if (args[0] === 'ps') {
        return { stdout: Buffer.from('overleaf-ai-sandbox-active\n') }
      }
      return { exitCode: 0 }
    })
    const provider = buildProvider({ commandRunner: cleanupRunner })
    const active = await provider.createSession({ id: 'active' })

    const result = await provider.manualCleanup({ includeActive: true })

    expect(result.removedContainers).toEqual(['overleaf-ai-sandbox-active'])
    expect(result.removedWorkspaces).toEqual([path.dirname(active.workspacePath)])
    expect(cleanupRunner.calls.some(call => (
      call.args.join(' ') === 'rm -f overleaf-ai-sandbox-active'
    ))).toBe(true)
  })
})
