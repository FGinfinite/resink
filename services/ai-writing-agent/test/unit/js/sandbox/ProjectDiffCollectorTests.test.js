import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ProjectDiffCollector,
  writeBaseSnapshot,
} from '../../../../app/js/sandbox/ProjectDiffCollector.js'

describe('ProjectDiffCollector', () => {
  let workspaceRoot

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-diff-'))
  })

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  it('classifies created, modified, deleted, and binary changed files', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'figures'), { recursive: true })
    await fs.writeFile(path.join(workspaceRoot, 'main.tex'), 'Hello\n', 'utf8')
    await fs.writeFile(path.join(workspaceRoot, 'old.tex'), 'Old\n', 'utf8')
    await fs.writeFile(
      path.join(workspaceRoot, 'figures/a.png'),
      Buffer.from([0, 1, 2])
    )

    const manifest = {
      version: 1,
      projectId: 'project-1',
      files: [
        textEntry('/main.tex', 'Hello\n', 'doc-1', 4),
        textEntry('/old.tex', 'Old\n', 'doc-2', 1),
        binaryEntry('/figures/a.png', Buffer.from([0, 1, 2]), 'file-1'),
      ],
    }
    await writeBaseSnapshot(workspaceRoot, manifest)

    await fs.writeFile(
      path.join(workspaceRoot, 'main.tex'),
      'Hello sandbox\n',
      'utf8'
    )
    await fs.rm(path.join(workspaceRoot, 'old.tex'))
    await fs.writeFile(path.join(workspaceRoot, 'new.tex'), 'New file\n', 'utf8')
    await fs.writeFile(
      path.join(workspaceRoot, 'figures/a.png'),
      Buffer.from([0, 1, 3])
    )

    const result = await new ProjectDiffCollector().collect(workspaceRoot, manifest)

    expect(result.modified).toHaveLength(1)
    expect(result.modified[0]).toMatchObject({
      path: '/main.tex',
      entityId: 'doc-1',
      baseVersion: 4,
      binary: false,
    })
    expect(result.deleted).toMatchObject([
      {
        path: '/old.tex',
        entityId: 'doc-2',
      },
    ])
    expect(result.created).toMatchObject([
      {
        path: '/new.tex',
        entityId: null,
        binary: false,
      },
    ])
    expect(result.binaryChanged).toHaveLength(1)
    expect(result.binaryChanged[0]).toMatchObject({
      path: '/figures/a.png',
      entityId: 'file-1',
      binary: true,
      oldSize: 3,
      newSize: 3,
    })
    expect(result.unifiedDiff).toContain('--- a/main.tex')
    expect(result.unifiedDiff).toContain('+++ b/main.tex')
    expect(result.unifiedDiff).toContain('-Hello')
    expect(result.unifiedDiff).toContain('+Hello sandbox')
    expect(result.unifiedDiff).toContain('--- a/new.tex')
    expect(result.unifiedDiff).not.toContain('figures/a.png')
  })


  it('ignores sandbox runtime helper files when collecting created changes', async () => {
    await fs.mkdir(path.join(workspaceRoot, '.agent/tmp'), { recursive: true })
    await fs.mkdir(path.join(workspaceRoot, '.skills/polish/scripts'), { recursive: true })
    await fs.writeFile(path.join(workspaceRoot, 'main.tex'), 'Hello\n', 'utf8')
    await fs.writeFile(path.join(workspaceRoot, '.agent/tmp/script.py'), 'print(1)\n', 'utf8')
    await fs.writeFile(path.join(workspaceRoot, '.skills/polish/scripts/a.py'), 'print(2)\n', 'utf8')
    await fs.writeFile(path.join(workspaceRoot, 'notes.tex'), 'Keep me\n', 'utf8')

    const manifest = {
      version: 1,
      projectId: 'project-1',
      files: [textEntry('/main.tex', 'Hello\n', 'doc-1', 4)],
    }
    await writeBaseSnapshot(workspaceRoot, manifest)

    const result = await new ProjectDiffCollector().collect(workspaceRoot, manifest)

    expect(result.created.map(change => change.path)).toEqual(['/notes.tex'])
    expect(result.unifiedDiff).not.toContain('.agent/tmp/script.py')
    expect(result.unifiedDiff).not.toContain('.skills/polish/scripts/a.py')
  })

  it('can read manifest from the workspace', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'main.tex'), 'Hello\n', 'utf8')
    const manifest = {
      version: 1,
      projectId: 'project-1',
      files: [textEntry('/main.tex', 'Hello\n', 'doc-1', 4)],
    }
    await writeBaseSnapshot(workspaceRoot, manifest)
    await fs.writeFile(
      path.join(workspaceRoot, '.overleaf-snapshot-manifest.json'),
      JSON.stringify(manifest),
      'utf8'
    )

    const result = await new ProjectDiffCollector().collect(workspaceRoot)

    expect(result.projectId).toBe('project-1')
    expect(result.modified).toEqual([])
    expect(result.created).toEqual([])
    expect(result.deleted).toEqual([])
    expect(result.binaryChanged).toEqual([])
  })
})

function textEntry(projectPath, content, entityId, baseVersion) {
  return {
    path: projectPath,
    workspacePath: projectPath.slice(1),
    entityType: 'doc',
    entityId,
    baseVersion,
    encoding: 'utf8',
    size: Buffer.byteLength(content, 'utf8'),
    sha256: sha256(Buffer.from(content, 'utf8')),
  }
}

function binaryEntry(projectPath, buffer, entityId) {
  return {
    path: projectPath,
    workspacePath: projectPath.slice(1),
    entityType: 'file',
    entityId,
    binary: true,
    exported: true,
    policy: 'copy',
    size: buffer.length,
    sha256: sha256(buffer),
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
