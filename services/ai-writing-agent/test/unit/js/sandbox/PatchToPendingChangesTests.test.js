import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import {
  PatchToPendingChanges,
  PatchToPendingChangesError
} from '../../../../app/js/sandbox/PatchToPendingChanges.js'

describe('PatchToPendingChanges', () => {
  it('converts a single tex modification into a pending text edit', () => {
    const converter = newConverter()

    const changes = converter.convert(
      {
        projectId: 'project-1',
        modified: [
          {
            path: '/main.tex',
            oldSha256: 'old-hash',
            newSha256: 'new-hash'
          }
        ]
      },
      manifest(),
      {
        contentsByPath: {
          '/main.tex': {
            old: 'Hello world\n',
            new: 'Hello Overleaf\n'
          }
        }
      }
    )

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      id: 'change-1',
      projectId: 'project-1',
      type: 'edit',
      status: 'pending',
      source: 'sandbox-patch',
      path: '/main.tex',
      docPath: '/main.tex',
      docId: 'doc-1',
      entityType: 'doc',
      entityId: 'doc-1',
      baseVersion: 7,
      position: { start: 0, end: 12 },
      oldText: 'Hello world\n',
      newText: 'Hello Overleaf\n',
      oldSha256: 'old-hash',
      newSha256: 'new-hash'
    })
    expect(changes[0].contextHash).toMatch(/^[0-9a-f]{16}$/)
    expect(changes[0].liveConflictBase).toEqual({
      baseVersion: 7,
      oldSha256: 'old-hash',
      path: '/main.tex'
    })
  })

  it('preserves live baseVersion from the collector change', () => {
    const converter = newConverter()

    const [change] = converter.convert(
      {
        projectId: 'project-1',
        modified: [
          {
            path: '/main.tex',
            baseVersion: 9,
            oldText: 'A',
            newText: 'B'
          }
        ]
      },
      manifest()
    )

    expect(change.baseVersion).toBe(9)
    expect(change.liveConflictBase.baseVersion).toBe(9)
  })

  it('can derive text edit content from collector unified diff', () => {
    const converter = newConverter()
    const oldText = 'Hello\nWorld'
    const newText = 'Hello\nSandbox'

    const [change] = converter.convert(
      {
        projectId: 'project-1',
        modified: [
          {
            path: '/main.tex',
            oldSha256: sha256Text(oldText),
            newSha256: sha256Text(newText),
            diff: [
              '--- a/main.tex',
              '+++ b/main.tex',
              '@@ -1,2 +1,2 @@',
              '-Hello',
              '-World',
              '+Hello',
              '+Sandbox',
              ''
            ].join('\n')
          }
        ]
      },
      manifest()
    )

    expect(change.oldText).toBe(oldText)
    expect(change.newText).toBe(newText)
    expect(change.position).toEqual({ start: 0, end: 11 })
  })

  it('converts created and deleted text docs into proposal-only changes', () => {
    const converter = newConverter()

    const changes = converter.convert(
      {
        projectId: 'project-1',
        created: [
          {
            path: '/sections/new.tex',
            entityType: null,
            entityId: null,
            binary: false,
            sha256: 'created-hash',
            content: '\\section{New}\n'
          }
        ],
        deleted: [
          {
            path: '/old.tex',
            oldSha256: 'deleted-hash',
            deletedContent: 'Old text\n'
          }
        ]
      },
      manifest({
        files: [
          docEntry('/main.tex', 'doc-1', 7),
          docEntry('/old.tex', 'doc-2', 3, { sha256: 'deleted-hash' })
        ]
      })
    )

    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({
      type: 'create',
      proposalOnly: true,
      projectId: 'project-1',
      path: '/sections/new.tex',
      entityType: 'doc',
      entityId: null,
      docId: null,
      content: '\\section{New}\n',
      baseVersion: 0,
      status: 'pending',
      artifact: false,
      newSha256: 'created-hash'
    })
    expect(changes[1]).toMatchObject({
      type: 'delete',
      proposalOnly: true,
      projectId: 'project-1',
      path: '/old.tex',
      entityType: 'doc',
      entityId: 'doc-2',
      docId: 'doc-2',
      deletedContent: 'Old text\n',
      baseVersion: 3,
      status: 'pending',
      artifact: false,
      oldSha256: 'deleted-hash'
    })
  })

  it('converts binary changes into artifact-only proposal changes', () => {
    const converter = newConverter()

    const changes = converter.convert(
      {
        projectId: 'project-1',
        binaryChanged: [
          {
            path: '/figures/a.png',
            oldSha256: 'old-bin',
            newSha256: 'new-bin',
            oldSize: 10,
            newSize: 12
          }
        ]
      },
      manifest({
        files: [
          docEntry('/main.tex', 'doc-1', 7),
          fileEntry('/figures/a.png', 'file-1')
        ]
      })
    )

    expect(changes).toEqual([
      expect.objectContaining({
        id: 'change-1',
        type: 'artifact',
        proposalOnly: true,
        artifact: true,
        artifactType: 'modified-binary',
        projectId: 'project-1',
        path: '/figures/a.png',
        entityType: 'file',
        entityId: 'file-1',
        docId: null,
        isBinary: true,
        oldSha256: 'old-bin',
        newSha256: 'new-bin',
        oldSize: 10,
        newSize: 12,
        status: 'pending'
      })
    ])
  })

  it('throws for unknown modified paths', () => {
    const converter = newConverter()

    expect(() =>
      converter.convert(
        {
          projectId: 'project-1',
          modified: [
            {
              path: '/missing.tex',
              oldText: 'A',
              newText: 'B'
            }
          ]
        },
        manifest()
      )
    ).toThrow(PatchToPendingChangesError)
  })

  it('throws for unsupported modified entities', () => {
    const converter = newConverter()

    expect(() =>
      converter.convert(
        {
          projectId: 'project-1',
          modified: [
            {
              path: '/metadata.json',
              oldText: '{}',
              newText: '{"x":true}'
            }
          ]
        },
        manifest({
          files: [
            {
              path: '/metadata.json',
              workspacePath: 'metadata.json',
              entityType: 'folder',
              entityId: 'folder-1',
              baseVersion: 1,
              sha256: 'old-hash'
            }
          ]
        })
      )
    ).toThrow(/Unsupported entity type/)
  })
})

function newConverter() {
  let nextId = 1
  return new PatchToPendingChanges({
    idGenerator: () => `change-${nextId++}`,
    now: () => 1710000000000
  })
}

function manifest(overrides = {}) {
  return {
    version: 1,
    projectId: 'project-1',
    files: [docEntry('/main.tex', 'doc-1', 7)],
    ...overrides
  }
}

function docEntry(projectPath, entityId, baseVersion, overrides = {}) {
  return {
    path: projectPath,
    workspacePath: projectPath.slice(1),
    entityType: 'doc',
    entityId,
    baseVersion,
    encoding: 'utf8',
    sha256: 'manifest-hash',
    ...overrides
  }
}

function fileEntry(projectPath, entityId, overrides = {}) {
  return {
    path: projectPath,
    workspacePath: projectPath.slice(1),
    entityType: 'file',
    entityId,
    binary: true,
    size: 10,
    sha256: 'manifest-binary-hash',
    ...overrides
  }
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
