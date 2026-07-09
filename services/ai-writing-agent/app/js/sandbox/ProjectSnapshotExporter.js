import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeProjectPath, resolveWorkspacePath } from '../util/project-path.js'

export class ProjectSnapshotExportError extends Error {}

const DEFAULT_BINARY_POLICY = 'copy'

export class ProjectSnapshotExporter {
  constructor(options = {}) {
    this.projectAdapter = options.projectAdapter
    this.documentAdapter = options.documentAdapter
    this.fileStoreAdapter = options.fileStoreAdapter
    this.binaryPolicy = options.binaryPolicy || DEFAULT_BINARY_POLICY
  }

  async exportProject(projectId, workspaceRoot, options = {}) {
    if (!this.projectAdapter) {
      throw new ProjectSnapshotExportError('projectAdapter is required')
    }
    if (!this.documentAdapter) {
      throw new ProjectSnapshotExportError('documentAdapter is required')
    }

    const root = path.resolve(workspaceRoot)
    const baseRoot = path.join(root, '.overleaf-snapshot-base')
    await fs.mkdir(root, { recursive: true })
    await fs.rm(baseRoot, { recursive: true, force: true })

    const entities = await this.projectAdapter.getEntities(projectId)
    const seenPaths = new Map()
    const manifest = {
      version: 1,
      projectId,
      exportedAt: new Date().toISOString(),
      binaryPolicy: this.binaryPolicy,
      files: [],
    }

    for (const doc of entities.docs || []) {
      const projectPath = this._normalizeUniquePath(doc, seenPaths)
      const targetPath = resolveWorkspacePath(root, projectPath)
      const document = await this.documentAdapter.getDocumentContent(projectId, doc.id)
      const content = document.content ?? ''

      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, content, 'utf8')
      const basePath = path.join(baseRoot, projectPath.slice(1))
      await fs.mkdir(path.dirname(basePath), { recursive: true })
      await fs.writeFile(basePath, content, 'utf8')

      manifest.files.push({
        path: projectPath,
        workspacePath: projectPath.slice(1),
        entityType: 'doc',
        entityId: doc.id,
        baseVersion: document.version ?? 0,
        encoding: 'utf8',
        size: Buffer.byteLength(content, 'utf8'),
        sha256: sha256(Buffer.from(content, 'utf8')),
      })
    }

    for (const file of entities.files || []) {
      const projectPath = this._normalizeUniquePath(file, seenPaths)
      const targetPath = resolveWorkspacePath(root, projectPath)
      let buffer = Buffer.alloc(0)
      let exported = false

      if (this.binaryPolicy === 'copy') {
        if (!this.fileStoreAdapter?.downloadProjectFile) {
          throw new ProjectSnapshotExportError(
            'fileStoreAdapter.downloadProjectFile is required for binary copy policy'
          )
        }
        buffer = await this.fileStoreAdapter.downloadProjectFile(
          projectId,
          file.id,
          options.userId
        )
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, buffer)
        exported = true
      } else if (this.binaryPolicy !== 'manifest-only') {
        throw new ProjectSnapshotExportError(
          `Unsupported binary policy: ${this.binaryPolicy}`
        )
      }

      manifest.files.push({
        path: projectPath,
        workspacePath: projectPath.slice(1),
        entityType: 'file',
        entityId: file.id,
        binary: true,
        exported,
        policy: this.binaryPolicy,
        size: exported ? buffer.length : file.size,
        sha256: exported ? sha256(buffer) : file.sha256,
      })
    }

    manifest.files.sort((a, b) => a.path.localeCompare(b.path))
    await fs.writeFile(
      path.join(root, '.overleaf-snapshot-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8'
    )

    return manifest
  }

  _normalizeUniquePath(entity, seenPaths) {
    const rawPath = entity.path || entity.name
    let normalizedPath
    try {
      normalizedPath = normalizeProjectPath(rawPath)
    } catch (error) {
      throw new ProjectSnapshotExportError(error.message, {
        cause: error,
      })
    }

    const owner = seenPaths.get(normalizedPath)
    if (owner) {
      throw new ProjectSnapshotExportError(
        `Duplicate project path after normalization: ${normalizedPath}`
      )
    }
    seenPaths.set(normalizedPath, entity.id)
    return normalizedPath
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
