import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sha256Hex } from './DependencyMetadata.js'

const DEFAULT_ROOT = path.join(os.tmpdir(), 'resink-python-env-store')
const ENVIRONMENT_ID_RE = /^pyenv_[a-zA-Z0-9_.-]+$/

export class SandboxEnvironmentStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || DEFAULT_ROOT)
    this.now = options.now || (() => new Date())
  }

  async putSnapshot(input = {}) {
    const environmentId = normalizeEnvironmentId(input.environmentId)
    const files = normalizeSnapshotFiles(input.files || [])
    const snapshotDir = this.snapshotDir(environmentId)
    await rm(snapshotDir, { recursive: true, force: true })
    await mkdir(snapshotDir, { recursive: true, mode: 0o700 })

    const manifestFiles = []
    for (const file of files) {
      const absolutePath = path.join(snapshotDir, file.path)
      await mkdir(path.dirname(absolutePath), { recursive: true })
      const content = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(String(file.content || ''), 'utf-8')
      await writeFile(absolutePath, content)
      manifestFiles.push({
        path: file.path,
        size: content.length,
        hash: `sha256:${sha256Hex(content)}`,
        mode: file.mode || '0644',
      })
    }

    const manifest = {
      environmentId,
      scope: input.scope || 'skill',
      skillName: input.skillName || null,
      projectId: input.projectId || null,
      lockHash: input.lockHash || null,
      manifestHash: input.manifestHash || null,
      sbomHash: input.sbomHash || null,
      pythonVersion: input.pythonVersion || null,
      uvVersion: input.uvVersion || null,
      policyDecision: input.policyDecision || null,
      runtime: normalizeRuntime(input.runtime),
      approvedBy: input.approvedBy || null,
      approvedAt: input.approvedAt || null,
      createdAt: this.now().toISOString(),
      files: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
    }
    await writeFile(
      path.join(snapshotDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf-8'
    )
    return manifest
  }

  async getSnapshot(environmentId) {
    const normalizedId = normalizeEnvironmentId(environmentId)
    const manifestPath = path.join(this.snapshotDir(normalizedId), 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    return {
      manifest,
      async readFile(filePath) {
        return readSnapshotFile({
          snapshotDir: path.dirname(manifestPath),
          filePath,
          expectedFile: null,
        })
      },
      async readVerifiedFile(file) {
        return readSnapshotFile({
          snapshotDir: path.dirname(manifestPath),
          filePath: file.path,
          expectedFile: file,
        })
      },
    }
  }

  async hasSnapshot(environmentId) {
    try {
      await stat(path.join(this.snapshotDir(normalizeEnvironmentId(environmentId)), 'manifest.json'))
      return true
    } catch {
      return false
    }
  }

  async describeSnapshot(environmentId) {
    return this.describeSnapshotDir(normalizeEnvironmentId(environmentId))
  }

  async listSnapshots() {
    let entries
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const snapshots = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !ENVIRONMENT_ID_RE.test(entry.name)) continue
      try {
        snapshots.push(await this.describeSnapshotDir(entry.name))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return snapshots.sort((a, b) => {
      const byCreated = a.createdAt.localeCompare(b.createdAt)
      return byCreated || a.environmentId.localeCompare(b.environmentId)
    })
  }

  async cleanup(options = {}) {
    const keepEnvironmentIds = new Set(
      (options.keepEnvironmentIds || []).map(normalizeEnvironmentId)
    )
    const snapshots = await this.listSnapshots()
    const removed = []
    const kept = []
    const nowMs = this.now().getTime()
    const olderThanMs = Number.isFinite(options.olderThanMs)
      ? Math.max(0, options.olderThanMs)
      : null

    for (const snapshot of snapshots) {
      if (keepEnvironmentIds.has(snapshot.environmentId)) {
        kept.push({ ...snapshot, keepReason: 'explicit-keep' })
        continue
      }
      const createdAtMs = Date.parse(snapshot.createdAt)
      const expired = olderThanMs !== null &&
        Number.isFinite(createdAtMs) &&
        nowMs - createdAtMs > olderThanMs
      if (!expired) {
        kept.push(snapshot)
        continue
      }
      await this.removeSnapshot(snapshot.environmentId)
      removed.push({ ...snapshot, reason: 'expired' })
    }

    const maxTotalBytes = Number.isFinite(options.maxTotalBytes)
      ? Math.max(0, options.maxTotalBytes)
      : null
    if (maxTotalBytes !== null) {
      let totalBytes = kept.reduce((sum, snapshot) => sum + snapshot.totalBytes, 0)
      const candidates = kept
        .filter(snapshot => !keepEnvironmentIds.has(snapshot.environmentId))
        .sort((a, b) => {
          const byCreated = a.createdAt.localeCompare(b.createdAt)
          return byCreated || a.environmentId.localeCompare(b.environmentId)
        })
      for (const snapshot of candidates) {
        if (totalBytes <= maxTotalBytes) break
        await this.removeSnapshot(snapshot.environmentId)
        totalBytes -= snapshot.totalBytes
        removed.push({ ...snapshot, reason: 'max-total-bytes' })
        const index = kept.findIndex(item => item.environmentId === snapshot.environmentId)
        if (index >= 0) kept.splice(index, 1)
      }
    }

    return {
      removed,
      kept,
      totalBytes: kept.reduce((sum, snapshot) => sum + snapshot.totalBytes, 0),
    }
  }

  async describeSnapshotDir(environmentId) {
    const snapshotDir = this.snapshotDir(environmentId)
    const manifestPath = path.join(snapshotDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    const totalBytes = await directorySize(snapshotDir)
    return {
      environmentId,
      manifest,
      createdAt: manifest.createdAt || new Date(0).toISOString(),
      totalBytes,
      fileCount: manifest.files.length + 1,
    }
  }

  async removeSnapshot(environmentId) {
    await rm(this.snapshotDir(normalizeEnvironmentId(environmentId)), {
      recursive: true,
      force: true,
    })
  }

  snapshotDir(environmentId) {
    return path.join(this.rootDir, normalizeEnvironmentId(environmentId))
  }
}

async function readSnapshotFile({ snapshotDir, filePath, expectedFile }) {
  const normalizedPath = normalizeRelativePath(filePath)
  const absolutePath = path.join(snapshotDir, normalizedPath)
  if (!isInside(snapshotDir, absolutePath)) {
    throw new Error(`Snapshot file path escapes environment root: ${filePath}`)
  }
  const content = await readFile(absolutePath)
  if (expectedFile?.hash) {
    const actualHash = `sha256:${sha256Hex(content)}`
    if (actualHash !== expectedFile.hash) {
      throw new Error(`Python environment snapshot hash mismatch: ${normalizedPath}`)
    }
  }
  if (
    Number.isFinite(expectedFile?.size) &&
    content.length !== expectedFile.size
  ) {
    throw new Error(`Python environment snapshot size mismatch: ${normalizedPath}`)
  }
  return content
}

function isInside(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function normalizeEnvironmentId(environmentId) {
  if (typeof environmentId !== 'string' || !ENVIRONMENT_ID_RE.test(environmentId)) {
    throw new Error(`Invalid Python environment id: ${environmentId}`)
  }
  return environmentId
}

export function normalizeSnapshotFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Python environment snapshot must include at least one file')
  }
  return files.map(file => ({
    path: normalizeRelativePath(file.path),
    content: file.content,
    mode: file.mode,
  }))
}

function normalizeRuntime(runtime = {}) {
  return {
    sitePackages: Array.isArray(runtime.sitePackages)
      ? runtime.sitePackages.map(normalizeRelativePath)
      : [],
  }
}

export function normalizeRelativePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('Snapshot file path is required')
  }
  if (rawPath.includes('\\') || path.posix.isAbsolute(rawPath)) {
    throw new Error(`Snapshot file path must be relative: ${rawPath}`)
  }
  const normalized = path.posix.normalize(rawPath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Snapshot file path escapes environment root: ${rawPath}`)
  }
  return normalized
}

async function directorySize(rootDir) {
  let total = 0
  const entries = await readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(entryPath)
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size
    }
  }
  return total
}

export default SandboxEnvironmentStore
