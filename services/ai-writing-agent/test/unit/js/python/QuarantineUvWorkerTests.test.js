import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { QuarantineUvWorker } = await import(
  '../../../../app/js/python/QuarantineUvWorker.js'
)

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('QuarantineUvWorker', () => {
  it('runs uv in an isolated temp workspace and returns lock and runtime artifacts', async () => {
    const calls = []
    const runner = vi.fn(async (command, args, options) => {
      calls.push({ command, args, options })
      if (args.includes('--version')) {
        return { exitCode: 0, stdout: Buffer.from('uv 0.8.22\n'), stderr: Buffer.alloc(0) }
      }
      if (args[0] === 'lock') {
        await writeFile(path.join(options.cwd, 'uv.lock'), 'version = 1\n', 'utf-8')
      }
      if (args[0] === 'sync') {
        await mkdir(
          path.join(options.cwd, '.venv/lib/python3.12/site-packages/pandas'),
          { recursive: true }
        )
        await writeFile(
          path.join(options.cwd, '.venv/lib/python3.12/site-packages/pandas/__init__.py'),
          '__version__ = "2.2.3"\n',
          'utf-8'
        )
      }
      return {
        exitCode: 0,
        stdout: Buffer.from('locked TOKEN=sk-secret123456\n'),
        stderr: Buffer.alloc(0),
      }
    })
    const worker = new QuarantineUvWorker({
      runner,
      baseEnv: {
        PATH: '/usr/bin',
        SECRET_TOKEN: 'should-not-forward',
        UV_INDEX_URL: 'https://token@example.invalid/simple',
        UV_EXTRA_INDEX_URL: 'https://token@example.invalid/extra',
        UV_KEYRING_PROVIDER: 'subprocess',
        PIP_INDEX_URL: 'https://token@example.invalid/simple',
      },
    })

    const result = await worker.resolve({
      mode: 'project-lock',
      request: {
        scope: 'skill',
        skillName: 'table-analysis',
        requestedPackages: [{ name: 'pandas', raw: 'pandas==2.2.3' }],
      },
      files: [{
        path: 'pyproject.toml',
        content: '[project]\ndependencies = ["pandas==2.2.3"]\n',
      }],
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe('resolved')
    expect(result.command.args).toEqual(['lock'])
    expect(calls[1]).toMatchObject({
      command: 'uv',
      args: ['sync', '--locked', '--no-install-project', '--link-mode', 'copy'],
    })
    expect(result.uvVersion).toBe('uv 0.8.22')
    expect(result.artifacts['uv.lock']).toMatchObject({
      content: 'version = 1\n',
      hash: expect.stringMatching(/^sha256:/),
    })
    expect(result.artifacts['site-packages/pandas/__init__.py']).toMatchObject({
      content: Buffer.from('__version__ = "2.2.3"\n'),
      hash: expect.stringMatching(/^sha256:/),
    })
    expect(result.runtime).toMatchObject({
      sitePackages: ['site-packages'],
    })
    expect(result.audit).toMatchObject({
      manifestHash: expect.stringMatching(/^sha256:/),
      sbomHash: expect.stringMatching(/^sha256:/),
      manifest: expect.objectContaining({
        requestFingerprint: expect.stringMatching(/^sha256:/),
        artifactHashes: {
          'uv.lock': result.artifacts['uv.lock'].hash,
          'site-packages/pandas/__init__.py':
            result.artifacts['site-packages/pandas/__init__.py'].hash,
        },
        runtime: {
          sitePackages: ['site-packages'],
        },
      }),
      sbom: expect.objectContaining({
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        components: [
          expect.objectContaining({
            type: 'library',
            name: 'pandas',
            version: '2.2.3',
            purl: 'pkg:pypi/pandas@2.2.3',
          }),
        ],
        properties: expect.arrayContaining([
          expect.objectContaining({
            name: 'resink:artifact:uv.lock:hash',
            value: result.artifacts['uv.lock'].hash,
          }),
        ]),
      }),
    })
    expect(result.logs[0].content).toContain('TOKEN=[redacted]')
    expect(calls[0].options.cwd).toContain('resink-uv-broker-')
    expect(calls.find(call => call.args.includes('--version')).options.cwd)
      .toBe(calls[0].options.cwd)
    expect(calls[0].options.env).toMatchObject({
      PATH: '/usr/bin',
      UV_INDEX_STRATEGY: 'first-index',
      UV_NO_PROGRESS: '1',
    })
    expect(calls[0].options.env.SECRET_TOKEN).toBeUndefined()
    expect(calls[0].options.env.UV_INDEX_URL).toBeUndefined()
    expect(calls[0].options.env.UV_EXTRA_INDEX_URL).toBeUndefined()
    expect(calls[0].options.env.UV_KEYRING_PROVIDER).toBeUndefined()
    expect(calls[0].options.env.PIP_INDEX_URL).toBeUndefined()
    expect(calls[0].options.networkPolicy).toBe('restricted')
    expect(calls[1].options.networkPolicy).toBe('restricted')
  })

  it('creates broker workspaces under the configured temp root', async () => {
    const tempRoot = await mkdir(
      path.join(process.cwd(), '.tmp-test-broker-workspaces'),
      { recursive: true }
    ).then(() => path.join(process.cwd(), '.tmp-test-broker-workspaces'))
    const calls = []
    const runner = vi.fn(async (_command, args, options) => {
      calls.push({ args, options })
      if (args.includes('--version')) {
        return { exitCode: 0, stdout: Buffer.from('uv 0.8.22\n'), stderr: Buffer.alloc(0) }
      }
      if (args[0] === 'lock') {
        await writeFile(path.join(options.cwd, 'uv.lock'), 'version = 1\n', 'utf-8')
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    })
    const worker = new QuarantineUvWorker({
      runner,
      tempRoot,
    })

    try {
      const result = await worker.resolve({
        mode: 'project-lock',
        request: {
          scope: 'project',
          requestedPackages: [],
        },
        files: [{
          path: 'pyproject.toml',
          content: '[project]\nname = "probe"\nversion = "0.0.0"\ndependencies = []\n',
        }],
      })

      expect(result.ok).toBe(true)
      expect(calls[0].options.cwd).toMatch(
        new RegExp(`^${escapeRegExp(tempRoot)}\\/resink-uv-broker-`)
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails closed for unsupported broker network policies before invoking uv', async () => {
    const runner = vi.fn()
    const worker = new QuarantineUvWorker({
      runner,
      networkPolicy: 'development-permissive',
    })

    const result = await worker.resolve({
      request: {
        scope: 'skill',
        skillName: 'table-analysis',
        requestedPackages: [{ name: 'pandas', raw: 'pandas==2.2.3' }],
      },
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      error: {
        code: 'BROKER_NETWORK_POLICY_DENIED',
      },
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('requires a broker-owned package index URL for package-index-proxy policy', async () => {
    const runner = vi.fn()
    const worker = new QuarantineUvWorker({
      runner,
      networkPolicy: 'package-index-proxy',
    })

    const result = await worker.resolve({
      request: {
        scope: 'skill',
        skillName: 'table-analysis',
        requestedPackages: [{ name: 'pandas', raw: 'pandas==2.2.3' }],
      },
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      error: {
        code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED',
      },
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('injects only the configured package-index proxy URL into uv', async () => {
    const calls = []
    const runner = vi.fn(async (_command, args, options) => {
      calls.push({ args, options })
      if (args.includes('--version')) {
        return { exitCode: 0, stdout: Buffer.from('uv 0.8.22\n'), stderr: Buffer.alloc(0) }
      }
      if (args[0] === 'lock') {
        await writeFile(path.join(options.cwd, 'uv.lock'), 'version = 1\n', 'utf-8')
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    })
    const worker = new QuarantineUvWorker({
      runner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyUrl: 'http://pypi-proxy/simple',
      baseEnv: {
        PATH: '/usr/bin',
        UV_INDEX_URL: 'https://token@example.invalid/simple',
        UV_EXTRA_INDEX_URL: 'https://token@example.invalid/extra',
      },
    })

    const result = await worker.resolve({
      request: {
        scope: 'project',
        requestedPackages: [],
      },
    })

    expect(result.ok).toBe(true)
    expect(calls[0].options.env).toMatchObject({
      UV_INDEX_URL: 'http://pypi-proxy/simple',
      UV_INDEX_STRATEGY: 'first-index',
    })
    expect(calls[0].options.env.UV_EXTRA_INDEX_URL).toBeUndefined()
    expect(JSON.stringify(calls.map(call => call.options.env))).not.toContain(
      'token@example.invalid'
    )
  })

  it('rejects package-index proxy URLs with query strings, fragments, or public hosts', async () => {
    for (const packageIndexProxyUrl of [
      'http://pypi-proxy/simple?token=secret',
      'http://pypi-proxy/simple#token=secret',
      'https://pypi.org/simple',
    ]) {
      const runner = vi.fn()
      const worker = new QuarantineUvWorker({
        runner,
        networkPolicy: 'package-index-proxy',
        packageIndexProxyUrl,
      })

      const result = await worker.resolve({
        request: {
          scope: 'skill',
          requestedPackages: [{ name: 'pandas', raw: 'pandas==2.2.3' }],
        },
      })

      expect(result).toMatchObject({
        ok: false,
        status: 'failed',
        error: {
          code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED',
        },
      })
      expect(runner).not.toHaveBeenCalled()
    }
  })

  it('denies unsafe dependency requests before invoking uv', async () => {
    const runner = vi.fn()
    const worker = new QuarantineUvWorker({ runner })

    const result = await worker.resolve({
      request: {
        scope: 'skill',
        skillName: 'unsafe',
        requestedPackages: [{
          name: 'unsafe',
          sourceHint: 'direct-url',
          raw: 'unsafe @ https://example.com/unsafe.whl',
        }],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('denied')
    expect(result.policyDecision.findings).toEqual([
      expect.objectContaining({ code: 'DENIED_DEPENDENCY_SOURCE' }),
      expect.objectContaining({ code: 'UNAPPROVED_DEPENDENCY_SOURCE' }),
    ])
    expect(runner).not.toHaveBeenCalled()
  })

  it('supports PEP 723 script lock mode without touching project sandbox state', async () => {
    const runner = vi.fn(async (_command, args, options) => {
      if (args.includes('--version')) {
        return { exitCode: 0, stdout: Buffer.from('uv 0.8.22\n'), stderr: Buffer.alloc(0) }
      }
      if (args[0] === 'lock') {
        await mkdir(path.join(options.cwd, 'scripts'), { recursive: true })
        await writeFile(
          path.join(options.cwd, 'scripts/analyze.py.lock'),
          'version = 1\n',
          'utf-8'
        )
      }
      if (args[0] === 'pip') {
        await mkdir(
          path.join(options.cwd, '.venv/lib/python3.12/site-packages/pypdf'),
          { recursive: true }
        )
        await writeFile(
          path.join(options.cwd, '.venv/lib/python3.12/site-packages/pypdf/__init__.py'),
          '__version__ = "5.0.0"\n',
          'utf-8'
        )
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    })
    const worker = new QuarantineUvWorker({ runner })

    const result = await worker.resolve({
      mode: 'script',
      scriptPath: 'scripts/analyze.py',
      request: {
        scope: 'script',
        scriptPath: 'scripts/analyze.py',
        requestedPackages: [{ name: 'pypdf', raw: 'pypdf==5.0.0' }],
      },
      files: [{
        path: 'scripts/analyze.py',
        content: `# /// script
# dependencies = ["pypdf==5.0.0"]
# ///
`,
      }],
    })

    expect(result.ok).toBe(true)
    expect(result.command.args).toEqual(['lock', '--script', 'scripts/analyze.py'])
    expect(result.artifacts['scripts/analyze.py.lock'].hash).toMatch(/^sha256:/)
    expect(result.artifacts['site-packages/pypdf/__init__.py']).toMatchObject({
      content: Buffer.from('__version__ = "5.0.0"\n'),
      hash: expect.stringMatching(/^sha256:/),
    })
    expect(result.runtime).toMatchObject({
      sitePackages: ['site-packages'],
    })
    expect(runner).toHaveBeenCalledWith('uv', [
      'export',
      '--script',
      'scripts/analyze.py',
      '--format',
      'requirements-txt',
      '--output-file',
      'requirements.txt',
    ], expect.any(Object))
    expect(runner).toHaveBeenCalledWith('uv', ['venv', '.venv'], expect.any(Object))
    expect(runner).toHaveBeenCalledWith('uv', [
      'pip',
      'install',
      '--python',
      '.venv/bin/python',
      '-r',
      'requirements.txt',
    ], expect.any(Object))
  })

  it('returns a clear missing-uv failure', async () => {
    const worker = new QuarantineUvWorker({
      uvBinary: 'missing-uv',
      runner: vi.fn(async () => ({
        exitCode: 127,
        errorCode: 'ENOENT',
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('not found'),
      })),
    })

    const result = await worker.resolve({
      request: {
        scope: 'skill',
        requestedPackages: [{ name: 'pandas', raw: 'pandas==2.2.3' }],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({
      code: 'UV_MISSING',
      message: 'uv binary not found: missing-uv',
    })
  })
})
