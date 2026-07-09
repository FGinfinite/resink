import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectSnapshotExporter,
  ProjectSnapshotExportError,
} from '../../../../app/js/sandbox/ProjectSnapshotExporter.js'
import {
  normalizeProjectPath,
  projectPathToWorkspaceRelative,
} from '../../../../app/js/util/project-path.js'

describe('project path utilities', () => {
  it('normalizes project paths to leading slash form', () => {
    expect(normalizeProjectPath('chapters/../main.tex')).toBe('/main.tex')
    expect(projectPathToWorkspaceRelative('/figures/result.png')).toBe(
      'figures/result.png'
    )
  })

  it('rejects unsafe paths', () => {
    expect(() => normalizeProjectPath('../x.tex')).toThrow('..')
    expect(() => normalizeProjectPath('/../x.tex')).toThrow('..')
    expect(() => normalizeProjectPath('a\\b.tex')).toThrow('backslashes')
    expect(() => normalizeProjectPath('%2e%2e/x.tex')).toThrow('encoded')
  })
})

describe('ProjectSnapshotExporter', () => {
  let workspaceRoot

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-export-'))
  })

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('exports text docs and binary files with manifest metadata', async () => {
    const exporter = new ProjectSnapshotExporter({
      projectAdapter: {
        getEntities: vi.fn().mockResolvedValue({
          docs: [{ id: 'doc-1', path: '/main.tex', name: 'main.tex' }],
          files: [{ id: 'file-1', path: '/figures/a.png', name: 'a.png' }],
        }),
      },
      documentAdapter: {
        getDocumentContent: vi.fn().mockResolvedValue({
          content: '\\section{Intro}\nHello',
          version: 7,
        }),
      },
      fileStoreAdapter: {
        downloadProjectFile: vi.fn().mockResolvedValue(Buffer.from([0, 1, 2])),
      },
    })

    const manifest = await exporter.exportProject('project-1', workspaceRoot, {
      userId: 'user-1',
    })

    expect(await fs.readFile(path.join(workspaceRoot, 'main.tex'), 'utf8'))
      .toBe('\\section{Intro}\nHello')
    expect(await fs.readFile(path.join(workspaceRoot, 'figures/a.png')))
      .toEqual(Buffer.from([0, 1, 2]))

    expect(manifest.files).toMatchObject([
      {
        path: '/figures/a.png',
        workspacePath: 'figures/a.png',
        entityType: 'file',
        entityId: 'file-1',
        binary: true,
        exported: true,
        policy: 'copy',
      },
      {
        path: '/main.tex',
        workspacePath: 'main.tex',
        entityType: 'doc',
        entityId: 'doc-1',
        baseVersion: 7,
        encoding: 'utf8',
      },
    ])
    expect(manifest.files[1].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(
      await fs.readFile(
        path.join(workspaceRoot, '.overleaf-snapshot-manifest.json'),
        'utf8'
      )
    ).toContain('"projectId": "project-1"')
  })

  it('supports manifest-only binary export policy', async () => {
    const downloadProjectFile = vi.fn()
    const exporter = new ProjectSnapshotExporter({
      binaryPolicy: 'manifest-only',
      projectAdapter: {
        getEntities: vi.fn().mockResolvedValue({
          docs: [],
          files: [
            {
              id: 'file-1',
              path: '/image.pdf',
              name: 'image.pdf',
              size: 123,
              sha256: 'abc',
            },
          ],
        }),
      },
      documentAdapter: {
        getDocumentContent: vi.fn(),
      },
      fileStoreAdapter: { downloadProjectFile },
    })

    const manifest = await exporter.exportProject('project-1', workspaceRoot)

    expect(downloadProjectFile).not.toHaveBeenCalled()
    expect(manifest.files[0]).toMatchObject({
      path: '/image.pdf',
      binary: true,
      exported: false,
      policy: 'manifest-only',
      size: 123,
      sha256: 'abc',
    })
  })

  it('rejects duplicate normalized paths', async () => {
    const exporter = new ProjectSnapshotExporter({
      projectAdapter: {
        getEntities: vi.fn().mockResolvedValue({
          docs: [
            { id: 'doc-1', path: '/main.tex', name: 'main.tex' },
            { id: 'doc-2', path: 'chapters/../main.tex', name: 'main.tex' },
          ],
          files: [],
        }),
      },
      documentAdapter: {
        getDocumentContent: vi.fn().mockResolvedValue({
          content: '',
          version: 1,
        }),
      },
    })

    try {
      await exporter.exportProject('project-1', workspaceRoot)
      expect.unreachable('Expected duplicate path failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectSnapshotExportError)
    }
  })
})
