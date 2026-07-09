import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveWorkspacePath } from '../util/project-path.js'

export class ProjectDiffCollectorError extends Error {}

const MANIFEST_NAME = '.overleaf-snapshot-manifest.json'
const RUNTIME_WORKSPACE_PREFIXES = ['.agent/', '.skills/']

export class ProjectDiffCollector {
  async collect(workspaceRoot, manifest) {
    const root = path.resolve(workspaceRoot)
    const snapshot = manifest || await this._readManifest(root)
    const manifestByPath = new Map(snapshot.files.map(file => [file.path, file]))
    const currentFiles = await listWorkspaceFiles(root)
    currentFiles.delete(MANIFEST_NAME)

    const created = []
    const modified = []
    const deleted = []
    const binaryChanged = []
    const unifiedDiffs = []

    for (const entry of snapshot.files) {
      const currentRelativePath = entry.workspacePath || entry.path.slice(1)
      if (!currentFiles.has(currentRelativePath)) {
        if (entry.binary && entry.exported === false) {
          continue
        }
        deleted.push(toChange(entry))
        continue
      }

      const absolutePath = resolveWorkspacePath(root, entry.path)
      const currentBuffer = await fs.readFile(absolutePath)
      const currentHash = sha256(currentBuffer)

      if (currentHash === entry.sha256) {
        continue
      }

      if (entry.binary) {
        binaryChanged.push({
          ...toChange(entry),
          oldSha256: entry.sha256,
          newSha256: currentHash,
          oldSize: entry.size,
          newSize: currentBuffer.length,
        })
        continue
      }

      const oldText = await readBaseText(root, currentRelativePath, entry.path)
      const newText = currentBuffer.toString('utf8')
      const diff = createUnifiedDiff(entry.path, oldText, newText)
      modified.push({
        ...toChange(entry),
        oldText,
        newText,
        oldSha256: entry.sha256,
        newSha256: currentHash,
        diff,
      })
      unifiedDiffs.push(diff)
    }

    for (const relativePath of [...currentFiles].sort()) {
      if (isRuntimeWorkspacePath(relativePath)) {
        continue
      }
      const projectPath = '/' + relativePath
      if (manifestByPath.has(projectPath)) {
        continue
      }

      const absolutePath = resolveWorkspacePath(root, projectPath)
      const buffer = await fs.readFile(absolutePath)
      const binary = isLikelyBinary(buffer)
      const change = {
        path: projectPath,
        workspacePath: relativePath,
        entityType: null,
        entityId: null,
        binary,
        size: buffer.length,
        sha256: sha256(buffer),
      }

      if (!binary) {
        change.content = buffer.toString('utf8')
        change.diff = createUnifiedDiff(projectPath, '', change.content)
        unifiedDiffs.push(change.diff)
      }
      created.push(change)
    }

    return {
      manifestVersion: snapshot.version,
      projectId: snapshot.projectId,
      created,
      modified,
      deleted,
      binaryChanged,
      unifiedDiff: unifiedDiffs.filter(Boolean).join('\n'),
    }
  }

  async _readManifest(root) {
    const manifestPath = path.join(root, MANIFEST_NAME)
    const rawManifest = await fs.readFile(manifestPath, 'utf8')
    return JSON.parse(rawManifest)
  }
}

export async function writeBaseSnapshot(workspaceRoot, manifest) {
  const root = path.resolve(workspaceRoot)
  const baseRoot = path.join(root, '.overleaf-snapshot-base')
  await fs.rm(baseRoot, { recursive: true, force: true })

  for (const entry of manifest.files) {
    if (entry.binary) {
      continue
    }
    const sourcePath = resolveWorkspacePath(root, entry.path)
    const targetPath = path.join(
      baseRoot,
      entry.workspacePath || entry.path.slice(1)
    )
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
  }
}

function toChange(entry) {
  return {
    path: entry.path,
    workspacePath: entry.workspacePath,
    entityType: entry.entityType,
    entityId: entry.entityId,
    baseVersion: entry.baseVersion,
    oldSha256: entry.sha256,
    oldSize: entry.size,
    binary: Boolean(entry.binary),
  }
}

async function listWorkspaceFiles(root, dir = '') {
  const result = new Set()
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (relativePath === '.overleaf-snapshot-base') {
        continue
      }
      for (const child of await listWorkspaceFiles(root, relativePath)) {
        result.add(child)
      }
    } else if (entry.isFile()) {
      result.add(relativePath)
    }
  }
  return result
}

function isRuntimeWorkspacePath(relativePath) {
  return RUNTIME_WORKSPACE_PREFIXES.some(prefix => relativePath.startsWith(prefix))
}

function createUnifiedDiff(projectPath, oldText, newText) {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const oldRange = oldLines.length || 0
  const newRange = newLines.length || 0
  const lines = [
    `--- a${projectPath}`,
    `+++ b${projectPath}`,
    `@@ -1,${oldRange} +1,${newRange} @@`,
  ]

  for (const line of oldLines) {
    lines.push(`-${line}`)
  }
  for (const line of newLines) {
    lines.push(`+${line}`)
  }
  return lines.join('\n') + '\n'
}

async function readBaseText(root, relativePath, projectPath) {
  try {
    return await fs.readFile(
      path.join(root, '.overleaf-snapshot-base', relativePath),
      'utf8'
    )
  } catch (error) {
    throw new ProjectDiffCollectorError(
      `Missing base snapshot for text file: ${projectPath}`,
      { cause: error }
    )
  }
}

function splitLines(text) {
  if (text === '') {
    return []
  }
  return text.replace(/\n$/, '').split('\n')
}

function isLikelyBinary(buffer) {
  return buffer.includes(0)
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
