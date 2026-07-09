import { access, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { E2BSandboxProvider } from '../../../../app/js/sandbox/E2BSandboxProvider.js'
import {
  SandboxOutputLimitError,
  SandboxPathError,
  SandboxSetupError,
} from '../../../../app/js/sandbox/SandboxErrors.js'

async function expectRejectsWith(promise, ErrorClass) {
  try {
    await promise
    expect.unreachable(`Expected ${ErrorClass.name}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorClass)
  }
}

function createMockSandbox() {
  const remoteFiles = new Map()
  return {
    commands: {
      run: vi.fn(async command => {
        if (command.startsWith('mkdir -p')) return { stdout: '', exitCode: 0 }
        if (command.startsWith('find ') && command.includes('-exec rm -rf')) {
          remoteFiles.clear()
          return { stdout: '', exitCode: 0 }
        }
        if (command.startsWith("'find'")) {
          return {
            stdout: [...remoteFiles.keys()].sort().join('\n'),
            exitCode: 0,
          }
        }
        if (command.includes('cat ../input.tex > output.tex')) {
          remoteFiles.set(
            '/workspace/output.tex',
            remoteFiles.get('/workspace/input.tex')
          )
          remoteFiles.delete('/workspace/input.tex')
          return { stdout: 'done\n', stderr: '', exitCode: 0 }
        }
        return { stdout: 'ok\n', stderr: '', exitCode: 0 }
      }),
    },
    files: {
      write: vi.fn(async writes => {
        for (const write of writes) {
          remoteFiles.set(write.path, write.data)
        }
      }),
      read: vi.fn(async remotePath => remoteFiles.get(remotePath)),
    },
    kill: vi.fn(async () => {}),
    remoteFiles,
  }
}

describe('E2BSandboxProvider', () => {
  let rootDir

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'e2b-provider-test-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  function buildProvider(mockSandbox, options = {}) {
    return new E2BSandboxProvider({
      rootDir,
      apiKey: 'test-e2b-key',
      sdkFactory: async () => ({
        Sandbox: {
          create: vi.fn(async () => mockSandbox),
        },
      }),
      ...options,
    })
  }

  it('requires admin-scoped E2B credentials', async () => {
    const provider = new E2BSandboxProvider({
      rootDir,
      apiKey: '',
      sdkFactory: async () => ({}),
    })

    await expectRejectsWith(
      provider.createSession({ id: 'missing-key' }),
      SandboxSetupError
    )
  })

  it('round-trips a local mirror through E2B and reflects deletes', async () => {
    const mockSandbox = createMockSandbox()
    const provider = buildProvider(mockSandbox)
    const session = await provider.createSession({ id: 'e2b-session' })

    await session.writeFile('input.tex', 'hello')
    const events = []
    for await (const event of session.run({
      command: ['sh', '-lc', 'cat ../input.tex > output.tex && rm ../input.tex'],
      workdir: 'chapters',
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: 'start',
        sessionId: 'e2b-session',
        command: ['sh', '-lc', 'cat ../input.tex > output.tex && rm ../input.tex'],
      },
      { type: 'stdout', data: 'done\n' },
      { type: 'exit', exitCode: 0, signal: null },
    ])
    expect(await session.readFile('output.tex')).toEqual(Buffer.from('hello'))
    expect(mockSandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("cd '/workspace/chapters'"),
      expect.any(Object)
    )
    await expectRejectsWith(
      stat(path.join(session.workspacePath, 'input.tex')),
      Error
    )
    expect(mockSandbox.files.write).toHaveBeenCalledWith([
      {
        path: '/workspace/input.tex',
        data: Buffer.from('hello'),
      },
    ])
  })


  it('streams ordinary non-zero exits instead of throwing command errors', async () => {
    const mockSandbox = createMockSandbox()
    mockSandbox.commands.run.mockImplementation(async command => {
      if (command.startsWith('mkdir -p')) return { stdout: '', exitCode: 0 }
      if (command.startsWith('find ') && command.includes('-exec rm -rf')) return { stdout: '', exitCode: 0 }
      if (command.startsWith("'find'")) return { stdout: '', exitCode: 0 }
      return { stdout: '', stderr: 'missing\n', exitCode: 2 }
    })
    const provider = buildProvider(mockSandbox)
    const session = await provider.createSession({ id: 'nonzero-session' })

    const events = []
    for await (const event of session.run({ command: ['grep', 'needle', 'main.tex'] })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'start', sessionId: 'nonzero-session', command: ['grep', 'needle', 'main.tex'] },
      { type: 'stderr', data: 'missing\n' },
      { type: 'exit', exitCode: 2, signal: null },
    ])
  })

  it('collects artifacts from the local mirror after remote sync', async () => {
    const mockSandbox = createMockSandbox()
    const provider = buildProvider(mockSandbox)
    const session = await provider.createSession({ id: 'artifact-session' })
    await session.writeFile('build/output.pdf', 'pdf bytes')

    const artifacts = await session.collectArtifacts(['build/*.pdf'])

    expect(artifacts).toEqual([
      {
        path: 'build/output.pdf',
        size: 9,
        content: Buffer.from('pdf bytes'),
      },
    ])
  })

  it('rejects local mirror paths and symlinks that escape the workspace', async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'e2b-outside-'))
    const mockSandbox = createMockSandbox()
    const provider = buildProvider(mockSandbox)
    const session = await provider.createSession({ id: 'path-session' })
    await writeFile(path.join(outsideDir, 'secret.txt'), 'secret')
    await symlink(outsideDir, path.join(session.workspacePath, 'outside-link'))

    await expectRejectsWith(session.writeFile('../escape.txt', 'no'), SandboxPathError)
    await expectRejectsWith(session.readFile('/etc/passwd'), SandboxPathError)
    await expectRejectsWith(session.listFiles('nested\\bad'), SandboxPathError)
    await expectRejectsWith(session.collectArtifacts(['../*.pdf']), SandboxPathError)
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
    await expectRejectsWith(access(path.join(outsideDir, 'nested')), Error)
    await expectRejectsWith(session.listFiles('outside-link'), SandboxPathError)

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('enforces output limits on cloud command results', async () => {
    const mockSandbox = createMockSandbox()
    mockSandbox.commands.run.mockImplementation(async command => {
      if (command.startsWith('mkdir -p')) return { stdout: '', exitCode: 0 }
      if (command.startsWith('find ') && command.includes('-exec rm -rf')) {
        return { stdout: '', exitCode: 0 }
      }
      return { stdout: 'too long', exitCode: 0 }
    })
    const provider = buildProvider(mockSandbox, { maxOutputBytes: 3 })
    const session = await provider.createSession({ id: 'limit-session' })

    await expectRejectsWith(
      (async () => {
        for await (const event of session.run({ command: ['echo', 'hello'] })) {
          expect(event).toBeDefined()
          // exhaust iterable
        }
      })(),
      SandboxOutputLimitError
    )
  })


  it('ignores hostile remote paths when syncing E2B files back to the local mirror', async () => {
    const mockSandbox = createMockSandbox()
    mockSandbox.commands.run.mockImplementation(async command => {
      if (command.startsWith('mkdir -p')) return { stdout: '', exitCode: 0 }
      if (command.startsWith('find ') && command.includes('-exec rm -rf')) return { stdout: '', exitCode: 0 }
      if (command.startsWith("'find'")) {
        return {
          stdout: [
            '/workspace/good.tex',
            '/tmp/escape.tex',
            '/workspace/../escape.tex',
            '/workspace/sub/../../escape2.tex',
          ].join('\n'),
          exitCode: 0,
        }
      }
      mockSandbox.remoteFiles.set('/workspace/good.tex', 'safe')
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    mockSandbox.files.read.mockImplementation(async remotePath => {
      if (remotePath === '/workspace/good.tex') return 'safe'
      throw new Error(`unexpected hostile remote read: ${remotePath}`)
    })
    const provider = buildProvider(mockSandbox)
    const session = await provider.createSession({ id: 'hostile-sync-session' })

    const events = []
    for await (const event of session.run({ command: ['true'] })) {
      events.push(event)
    }

    expect(events.at(-1)).toEqual({ type: 'exit', exitCode: 0, signal: null })
    expect(await session.readFile('good.tex')).toEqual(Buffer.from('safe'))
    await expectRejectsWith(session.readFile('escape.tex'), Error)
    await expectRejectsWith(session.readFile('../escape.tex'), SandboxPathError)
  })

  it('quotes E2B command arguments before invoking the cloud shell', async () => {
    const mockSandbox = createMockSandbox()
    const provider = buildProvider(mockSandbox)
    const session = await provider.createSession({ id: 'quote-session' })
    const arg = "semi; $(touch /tmp/pwned) 'quoted'"

    for await (const event of session.run({ command: ['printf', arg] })) {
      expect(event).toBeDefined()
    }

    const command = mockSandbox.commands.run.mock.calls.find(([value]) =>
      String(value).includes('printf')
    )?.[0]
    expect(command).toContain("'printf'")
    expect(command).toContain("'semi; $(touch /tmp/pwned) '")
    expect(command).toContain(`'"'"'quoted'"'"''`)
  })

  it('destroys the cloud sandbox and local mirror', async () => {
    const mockSandbox = createMockSandbox()
    const provider = buildProvider(mockSandbox)
    const session = await provider.createSession({ id: 'destroy-session' })

    await provider.destroySession('destroy-session')

    expect(mockSandbox.kill).toHaveBeenCalled()
    await expectRejectsWith(stat(path.dirname(session.workspacePath)), Error)
  })
})
