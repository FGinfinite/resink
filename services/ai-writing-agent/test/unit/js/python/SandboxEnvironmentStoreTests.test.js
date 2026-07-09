import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const {
  SandboxEnvironmentStore,
} = await import('../../../../app/js/python/SandboxEnvironmentStore.js')

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

describe('SandboxEnvironmentStore', () => {
  let rootDir

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'pyenv-store-test-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('stores approved environment snapshots with manifest hashes', async () => {
    const store = new SandboxEnvironmentStore({
      rootDir,
      now: () => new Date('2026-06-24T00:00:00.000Z'),
    })

    const manifest = await store.putSnapshot({
      environmentId: 'pyenv_table_analysis',
      scope: 'skill',
      skillName: 'table-analysis',
      pythonVersion: '3.12.4',
      uvVersion: 'uv 0.8.22',
      lockHash: 'sha256:lock',
      manifestHash: 'sha256:manifest',
      sbomHash: 'sha256:sbom',
      policyDecision: { status: 'approved' },
      approvedBy: 'admin-1',
      approvedAt: '2026-06-24T00:00:00.000Z',
      files: [
        { path: 'bin/python', content: '#!/bin/sh\n' },
        { path: 'lib/site-packages/pkg.py', content: 'VALUE = 1\n' },
      ],
    })

    expect(manifest).toMatchObject({
      environmentId: 'pyenv_table_analysis',
      scope: 'skill',
      skillName: 'table-analysis',
      createdAt: '2026-06-24T00:00:00.000Z',
      files: [
        expect.objectContaining({ path: 'bin/python', hash: expect.stringMatching(/^sha256:/) }),
        expect.objectContaining({ path: 'lib/site-packages/pkg.py' }),
      ],
    })
    expect(await store.hasSnapshot('pyenv_table_analysis')).toBe(true)

    const snapshot = await store.getSnapshot('pyenv_table_analysis')
    expect(snapshot.manifest.lockHash).toBe('sha256:lock')
    expect(snapshot.manifest.manifestHash).toBe('sha256:manifest')
    expect(snapshot.manifest.sbomHash).toBe('sha256:sbom')
    expect(snapshot.manifest.policyDecision).toEqual({ status: 'approved' })
    expect(snapshot.manifest.approvedBy).toBe('admin-1')
    expect((await snapshot.readFile('lib/site-packages/pkg.py')).toString()).toBe('VALUE = 1\n')
    expect(
      (await snapshot.readVerifiedFile(
        snapshot.manifest.files.find(file => file.path === 'lib/site-packages/pkg.py')
      )).toString()
    ).toBe('VALUE = 1\n')
  })

  it('fails closed when a snapshot file hash changes after approval', async () => {
    const store = new SandboxEnvironmentStore({ rootDir })
    await store.putSnapshot({
      environmentId: 'pyenv_tampered',
      files: [{ path: 'site-packages/pkg.py', content: 'VALUE = 1\n' }],
    })
    await writeFile(
      path.join(rootDir, 'pyenv_tampered', 'site-packages/pkg.py'),
      'VALUE = 2\n',
      'utf-8'
    )

    const snapshot = await store.getSnapshot('pyenv_tampered')
    const error = await captureError(
      snapshot.readVerifiedFile(snapshot.manifest.files[0])
    )

    expect(error.message).toContain('snapshot hash mismatch')
  })

  it('rejects invalid environment ids and path escapes', async () => {
    const store = new SandboxEnvironmentStore({ rootDir })

    const idError = await captureError(store.putSnapshot({
      environmentId: '../escape',
      files: [{ path: 'bin/python', content: '' }],
    }))
    expect(idError.message).toContain('Invalid Python environment id')

    const pathError = await captureError(store.putSnapshot({
      environmentId: 'pyenv_escape',
      files: [{ path: '../host', content: '' }],
    }))
    expect(pathError.message).toContain('escapes environment root')
  })

  it('reports snapshot size and removes expired snapshots without touching kept environments', async () => {
    let now = new Date('2026-06-24T00:00:00.000Z')
    const store = new SandboxEnvironmentStore({
      rootDir,
      now: () => now,
    })

    await store.putSnapshot({
      environmentId: 'pyenv_old',
      files: [{ path: 'pkg.py', content: 'old' }],
    })
    now = new Date('2026-06-24T01:00:00.000Z')
    await store.putSnapshot({
      environmentId: 'pyenv_keep',
      files: [{ path: 'pkg.py', content: 'keep' }],
    })
    await store.putSnapshot({
      environmentId: 'pyenv_recent',
      files: [{ path: 'pkg.py', content: 'recent' }],
    })

    const old = await store.describeSnapshot('pyenv_old')
    expect(old).toMatchObject({
      environmentId: 'pyenv_old',
      fileCount: 2,
    })
    expect(old.totalBytes).toBeGreaterThan(0)

    const cleanup = await store.cleanup({
      olderThanMs: 30 * 60 * 1000,
      keepEnvironmentIds: ['pyenv_keep'],
    })

    expect(cleanup.removed.map(item => item.environmentId)).toEqual(['pyenv_old'])
    expect(cleanup.kept.map(item => item.environmentId)).toEqual([
      'pyenv_keep',
      'pyenv_recent',
    ])
    expect(await store.hasSnapshot('pyenv_old')).toBe(false)
    expect(await store.hasSnapshot('pyenv_keep')).toBe(true)
    expect(await store.hasSnapshot('pyenv_recent')).toBe(true)
  })

  it('enforces a max byte budget by removing oldest unkept snapshots first', async () => {
    let tick = 0
    const store = new SandboxEnvironmentStore({
      rootDir,
      now: () => new Date(`2026-06-24T00:00:0${tick++}.000Z`),
    })

    await store.putSnapshot({
      environmentId: 'pyenv_a',
      files: [{ path: 'pkg.py', content: 'a'.repeat(40) }],
    })
    await store.putSnapshot({
      environmentId: 'pyenv_b',
      files: [{ path: 'pkg.py', content: 'b'.repeat(40) }],
    })
    await store.putSnapshot({
      environmentId: 'pyenv_c',
      files: [{ path: 'pkg.py', content: 'c'.repeat(40) }],
    })
    const before = await store.listSnapshots()
    const newest = before.find(item => item.environmentId === 'pyenv_c')

    const cleanup = await store.cleanup({
      maxTotalBytes: newest.totalBytes + 1,
      keepEnvironmentIds: ['pyenv_c'],
    })

    expect(cleanup.removed.map(item => item.environmentId)).toEqual([
      'pyenv_a',
      'pyenv_b',
    ])
    expect(await store.hasSnapshot('pyenv_a')).toBe(false)
    expect(await store.hasSnapshot('pyenv_b')).toBe(false)
    expect(await store.hasSnapshot('pyenv_c')).toBe(true)
  })

  it('ignores non-environment directories during cleanup', async () => {
    const store = new SandboxEnvironmentStore({ rootDir })
    await writeFile(path.join(rootDir, 'not-an-env'), 'ignore me')
    await store.putSnapshot({
      environmentId: 'pyenv_valid',
      files: [{ path: 'pkg.py', content: 'ok' }],
    })

    const snapshots = await store.listSnapshots()

    expect(snapshots.map(item => item.environmentId)).toEqual(['pyenv_valid'])
  })
})
