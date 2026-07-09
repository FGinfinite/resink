import { mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { DockerUvBrokerRunner } = await import(
  '../../../../app/js/python/DockerUvBrokerRunner.js'
)

describe('DockerUvBrokerRunner', () => {
  it('runs uv in a broker container with Docker network none for restricted policy', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.from('ok'),
        stderr: Buffer.alloc(0),
      })),
    }
    const runner = new DockerUvBrokerRunner({
      image: 'resink-uv-broker:test',
      commandRunner,
    })

    try {
      const result = await runner.run('uv', ['lock'], {
        cwd: workspace,
        env: {
          HOME: workspace,
          UV_CACHE_DIR: path.join(workspace, '.uv-cache'),
          UV_NO_PROGRESS: '1',
        },
        timeoutMs: 12345,
        maxOutputBytes: 4096,
        networkPolicy: 'restricted',
      })

      expect(result.exitCode).toBe(0)
      expect(commandRunner.run).toHaveBeenCalledWith(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--user',
          `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
          '--workdir',
          '/broker-workspace',
          '--mount',
          `type=bind,src=${workspace},dst=/broker-workspace`,
          '--env',
          'HOME=/broker-workspace',
          '--env',
          'UV_CACHE_DIR=/broker-workspace/.uv-cache',
          '--env',
          'UV_NO_PROGRESS=1',
          'resink-uv-broker:test',
          'uv',
          'lock',
        ],
        {
          timeoutMs: 12345,
          maxOutputBytes: 4096,
        }
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('allows broker workspaces under a configured shared host root', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'broker-shared-root-'))
    const workspaceHostRoot = await mkdtemp(path.join(os.tmpdir(), 'broker-host-root-'))
    const workspace = await mkdtemp(path.join(workspaceRoot, 'resink-uv-broker-'))
    const hostWorkspace = path.join(workspaceHostRoot, path.basename(workspace))
    const commandRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.from('ok'),
        stderr: Buffer.alloc(0),
      })),
    }
    const runner = new DockerUvBrokerRunner({
      image: 'resink-uv-broker:test',
      commandRunner,
      workspaceRoot,
      workspaceHostRoot,
    })

    try {
      await runner.run('uv', ['lock'], {
        cwd: workspace,
        env: {
          HOME: workspace,
          UV_CACHE_DIR: path.join(workspace, '.uv-cache'),
        },
      })

      expect(commandRunner.run.mock.calls[0][1]).toContain(
        `type=bind,src=${hostWorkspace},dst=/broker-workspace`
      )
      expect(commandRunner.run.mock.calls[0][1]).toContain('HOME=/broker-workspace')
      expect(commandRunner.run.mock.calls[0][1]).toContain(
        'UV_CACHE_DIR=/broker-workspace/.uv-cache'
      )
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
      await rm(workspaceHostRoot, { recursive: true, force: true })
    }
  })

  it('requires an explicit approved network for package-index-proxy policy', async () => {
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      networkPolicy: 'package-index-proxy',
    })

    let error
    try {
      await runner.run('uv', ['lock'], {
        cwd: '/tmp/resink-uv-broker-abc',
        env: {},
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ code: 'BROKER_DOCKER_NETWORK_DENIED' })
    expect(commandRunner.run).not.toHaveBeenCalled()
  })

  it('rejects non-quarantine host workspaces before launching Docker', async () => {
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({ commandRunner })

    let error
    try {
      await runner.run('uv', ['--version'], {
        cwd: '/tmp',
        env: {},
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ code: 'BROKER_WORKSPACE_DENIED' })
    expect(commandRunner.run).not.toHaveBeenCalled()
  })

  it('rejects quarantine-looking symlink workspaces before launching Docker', async () => {
    const realTarget = await mkdtemp(path.join(os.tmpdir(), 'broker-target-'))
    const symlinkPath = `/tmp/resink-uv-broker-symlink-${Date.now()}`
    await symlink(realTarget, symlinkPath, 'dir')
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({ commandRunner })

    try {
      let error
      try {
        await runner.run('uv', ['--version'], {
          cwd: symlinkPath,
          env: {},
        })
      } catch (caught) {
        error = caught
      }

      expect(error).toMatchObject({ code: 'BROKER_WORKSPACE_DENIED' })
      expect(commandRunner.run).not.toHaveBeenCalled()
    } finally {
      await rm(symlinkPath, { force: true })
      await rm(realTarget, { recursive: true, force: true })
    }
  })

  it('does not forward arbitrary env variables when called directly', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })),
    }
    const runner = new DockerUvBrokerRunner({ commandRunner })

    try {
      await runner.run('uv', ['--version'], {
        cwd: workspace,
        env: {
          HOME: workspace,
          PATH: '/usr/bin',
          UV_CACHE_DIR: path.join(workspace, '.uv-cache'),
          UV_NO_PROGRESS: '1',
          UV_INDEX_URL: 'https://token@example.invalid/simple',
          SECRET_TOKEN: 'secret',
        },
      })

      const args = commandRunner.run.mock.calls[0][1]
      expect(args).toContain('HOME=/broker-workspace')
      expect(args).toContain('PATH=/usr/bin')
      expect(args).toContain('UV_CACHE_DIR=/broker-workspace/.uv-cache')
      expect(args).toContain('UV_NO_PROGRESS=1')
      expect(args.join('\n')).not.toContain('UV_INDEX_URL')
      expect(args.join('\n')).not.toContain('SECRET_TOKEN')
      expect(args.join('\n')).not.toContain('token@example.invalid')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('uses the configured approved package-index proxy Docker network', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyNetwork: 'resink-broker-proxy-approved',
    })

    try {
      await runner.run('uv', ['lock'], {
        cwd: workspace,
        env: {
          UV_INDEX_URL: 'http://pypi-proxy/simple',
        },
      })

      expect(commandRunner.run.mock.calls[0][1]).toContain('resink-broker-proxy-approved')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('forwards only broker-owned package-index proxy URL env vars', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyNetwork: 'resink-broker-proxy-approved',
    })

    try {
      await runner.run('uv', ['lock'], {
        cwd: workspace,
        env: {
          UV_INDEX_URL: 'http://pypi-proxy/simple',
          UV_EXTRA_INDEX_URL: 'https://token@example.invalid/extra',
          PIP_INDEX_URL: 'https://token@example.invalid/simple',
        },
      })

      const args = commandRunner.run.mock.calls[0][1].join('\n')
      expect(args).toContain('UV_INDEX_URL=http://pypi-proxy/simple')
      expect(args).not.toContain('UV_EXTRA_INDEX_URL')
      expect(args).not.toContain('PIP_INDEX_URL')
      expect(args).not.toContain('token@example.invalid')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects package-index proxy URLs with credentials before launching Docker', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyNetwork: 'resink-broker-proxy-approved',
    })

    try {
      let error
      try {
        await runner.run('uv', ['lock'], {
          cwd: workspace,
          env: {
            UV_INDEX_URL: 'https://token:p@pypi-proxy/simple',
          },
        })
      } catch (caught) {
        error = caught
      }

      expect(error).toMatchObject({ code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED' })
      expect(commandRunner.run).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects package-index proxy URLs with query or fragment secrets before launching Docker', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyNetwork: 'resink-broker-proxy-approved',
    })

    try {
      for (const url of [
        'http://pypi-proxy/simple?token=secret',
        'http://pypi-proxy/simple#token=secret',
      ]) {
        let error
        try {
          await runner.run('uv', ['lock'], {
            cwd: workspace,
            env: { UV_INDEX_URL: url },
          })
        } catch (caught) {
          error = caught
        }
        expect(error).toMatchObject({ code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED' })
      }
      expect(commandRunner.run).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects package-index proxy URLs outside the approved internal proxy alias', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyNetwork: 'resink-broker-proxy-approved',
    })

    try {
      let error
      try {
        await runner.run('uv', ['lock'], {
          cwd: workspace,
          env: { UV_INDEX_URL: 'https://pypi.org/simple' },
        })
      } catch (caught) {
        error = caught
      }

      expect(error).toMatchObject({ code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED' })
      expect(commandRunner.run).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects Docker default networks for package-index-proxy policy', async () => {
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyNetwork: 'bridge',
    })

    let error
    try {
      await runner.run('uv', ['lock'], {
        cwd: '/tmp/resink-uv-broker-abc',
        env: { UV_INDEX_URL: 'http://pypi-proxy/simple' },
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ code: 'BROKER_DOCKER_NETWORK_DENIED' })
    expect(commandRunner.run).not.toHaveBeenCalled()
  })

  it('rejects comma-bearing quarantine paths before launching Docker', async () => {
    const workspace = await mkdtemp('/tmp/resink-uv-broker-comma,')
    const commandRunner = {
      run: vi.fn(),
    }
    const runner = new DockerUvBrokerRunner({ commandRunner })

    try {
      let error
      try {
        await runner.run('uv', ['--version'], {
          cwd: workspace,
          env: {},
        })
      } catch (caught) {
        error = caught
      }

      expect(error).toMatchObject({ code: 'BROKER_WORKSPACE_DENIED' })
      expect(commandRunner.run).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('allows an explicit container uid and gid override', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))
    const commandRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })),
    }
    const runner = new DockerUvBrokerRunner({
      commandRunner,
      uid: 123,
      gid: 456,
    })

    try {
      await runner.run('uv', ['--version'], {
        cwd: workspace,
        env: {},
      })

      expect(commandRunner.run.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--user', '123:456'])
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
