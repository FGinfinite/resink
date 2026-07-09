import crypto from 'node:crypto'

export class PatchToPendingChangesError extends Error {}

const DEFAULT_SOURCE = 'sandbox-patch'
const DEFAULT_ANCHOR_LEN = 100

export class PatchToPendingChanges {
  constructor(options = {}) {
    this.anchorLength = options.anchorLength ?? DEFAULT_ANCHOR_LEN
    this.idGenerator = options.idGenerator || randomId
    this.now = options.now || (() => Date.now())
  }

  convert(diffResult, manifest, options = {}) {
    if (!diffResult) {
      throw new PatchToPendingChangesError('diffResult is required')
    }
    if (!manifest?.files) {
      throw new PatchToPendingChangesError('manifest with files is required')
    }

    const projectId =
      options.projectId || diffResult.projectId || manifest.projectId
    if (!projectId) {
      throw new PatchToPendingChangesError('projectId is required')
    }

    const manifestByPath = new Map(
      manifest.files.map((file) => [file.path, file])
    )
    const contentsByPath = normalizeContentMap(options.contentsByPath)
    const changes = []

    for (const change of diffResult.modified || []) {
      changes.push(
        this._modifiedDocToTextEdit(change, manifestByPath, contentsByPath, {
          projectId,
          source: options.source
        })
      )
    }

    for (const change of diffResult.created || []) {
      changes.push(
        this._createdToProposal(change, manifestByPath, contentsByPath, {
          projectId,
          source: options.source
        })
      )
    }

    for (const change of diffResult.deleted || []) {
      changes.push(
        this._deletedToProposal(change, manifestByPath, contentsByPath, {
          projectId,
          source: options.source
        })
      )
    }

    for (const change of diffResult.binaryChanged || []) {
      changes.push(
        this._binaryToArtifact(change, manifestByPath, {
          projectId,
          source: options.source
        })
      )
    }

    return changes
  }

  _modifiedDocToTextEdit(change, manifestByPath, contentsByPath, options) {
    const manifestEntry = requireKnownManifestEntry(change, manifestByPath)
    assertSupportedEntity(manifestEntry, ['doc'], change.path)
    assertTextDoc(manifestEntry, change.path)

    const oldText = getText(
      change,
      'oldText',
      contentsByPath,
      change.path,
      'old',
      {
        expectedSha256: change.oldSha256 ?? manifestEntry.sha256
      }
    )
    const newText = getText(
      change,
      'newText',
      contentsByPath,
      change.path,
      'new',
      {
        expectedSha256: change.newSha256
      }
    )

    return {
      ...this._commonFields(options.projectId, change.path, options.source),
      type: 'edit',
      docId: manifestEntry.entityId,
      entityType: 'doc',
      entityId: manifestEntry.entityId,
      baseVersion: change.baseVersion ?? manifestEntry.baseVersion,
      position: { start: 0, end: oldText.length },
      oldText,
      newText,
      contextHash: hashContext('', ''),
      oldSha256: change.oldSha256 ?? manifestEntry.sha256,
      newSha256: change.newSha256,
      liveConflictBase: {
        baseVersion: change.baseVersion ?? manifestEntry.baseVersion,
        oldSha256: change.oldSha256 ?? manifestEntry.sha256,
        path: change.path
      }
    }
  }

  _createdToProposal(change, manifestByPath, contentsByPath, options) {
    assertUnknownPath(change, manifestByPath)

    const content = getText(
      change,
      'content',
      contentsByPath,
      change.path,
      'new',
      {
        optional: Boolean(change.binary),
        expectedSha256: change.sha256 ?? change.newSha256
      }
    )

    if (change.binary) {
      return this._binaryArtifactProposal(change, {
        projectId: options.projectId,
        source: options.source,
        artifactType: 'created-binary'
      })
    }

    return {
      ...this._commonFields(options.projectId, change.path, options.source),
      type: 'create',
      proposalOnly: true,
      entityType: 'doc',
      entityId: null,
      docId: null,
      content,
      baseVersion: 0,
      status: 'pending',
      artifact: false,
      newSha256: change.sha256 ?? change.newSha256,
      liveConflictBase: {
        baseVersion: 0,
        oldSha256: null,
        path: change.path
      }
    }
  }

  _deletedToProposal(change, manifestByPath, contentsByPath, options) {
    const manifestEntry = requireKnownManifestEntry(change, manifestByPath)
    assertSupportedEntity(manifestEntry, ['doc', 'file'], change.path)

    if (manifestEntry.binary || manifestEntry.entityType === 'file') {
      return {
        ...this._commonFields(options.projectId, change.path, options.source),
        type: 'delete',
        proposalOnly: true,
        entityType: manifestEntry.entityType,
        entityId: manifestEntry.entityId,
        docId: null,
        isBinary: Boolean(manifestEntry.binary),
        deletedContent: null,
        baseVersion: manifestEntry.baseVersion,
        artifact: true,
        oldSha256: change.oldSha256 ?? manifestEntry.sha256,
        oldSize: change.oldSize ?? manifestEntry.size,
        liveConflictBase: {
          baseVersion: manifestEntry.baseVersion,
          oldSha256: change.oldSha256 ?? manifestEntry.sha256,
          path: change.path
        }
      }
    }

    const deletedContent = getText(
      change,
      'deletedContent',
      contentsByPath,
      change.path,
      'old',
      {
        expectedSha256: change.oldSha256 ?? manifestEntry.sha256
      }
    )

    return {
      ...this._commonFields(options.projectId, change.path, options.source),
      type: 'delete',
      proposalOnly: true,
      entityType: 'doc',
      entityId: manifestEntry.entityId,
      docId: manifestEntry.entityId,
      deletedContent,
      baseVersion: change.baseVersion ?? manifestEntry.baseVersion,
      artifact: false,
      oldSha256: change.oldSha256 ?? manifestEntry.sha256,
      liveConflictBase: {
        baseVersion: change.baseVersion ?? manifestEntry.baseVersion,
        oldSha256: change.oldSha256 ?? manifestEntry.sha256,
        path: change.path
      }
    }
  }

  _binaryToArtifact(change, manifestByPath, options) {
    const manifestEntry = requireKnownManifestEntry(change, manifestByPath)
    assertSupportedEntity(manifestEntry, ['file'], change.path)

    return this._binaryArtifactProposal(
      {
        ...change,
        entityType: manifestEntry.entityType,
        entityId: manifestEntry.entityId,
        oldSha256: change.oldSha256 ?? manifestEntry.sha256,
        oldSize: change.oldSize ?? manifestEntry.size
      },
      {
        projectId: options.projectId,
        source: options.source,
        artifactType: 'modified-binary'
      }
    )
  }

  _binaryArtifactProposal(change, options) {
    return {
      ...this._commonFields(options.projectId, change.path, options.source),
      type: 'artifact',
      proposalOnly: true,
      artifact: true,
      artifactType: options.artifactType,
      entityType: change.entityType || 'file',
      entityId: change.entityId ?? null,
      docId: null,
      isBinary: true,
      baseVersion: change.baseVersion,
      oldSha256: change.oldSha256,
      newSha256: change.newSha256 ?? change.sha256,
      oldSize: change.oldSize,
      newSize: change.newSize ?? change.size,
      liveConflictBase: {
        baseVersion: change.baseVersion,
        oldSha256: change.oldSha256,
        path: change.path
      }
    }
  }

  _commonFields(projectId, filePath, source) {
    return {
      id: this.idGenerator(),
      projectId,
      path: filePath,
      docPath: filePath,
      status: 'pending',
      source: source || DEFAULT_SOURCE,
      createdAt: this.now()
    }
  }
}

function normalizeContentMap(contentsByPath) {
  if (!contentsByPath) {
    return new Map()
  }
  if (contentsByPath instanceof Map) {
    return contentsByPath
  }
  return new Map(Object.entries(contentsByPath))
}

function getText(
  change,
  directKey,
  contentsByPath,
  filePath,
  version,
  options = {}
) {
  if (typeof change[directKey] === 'string') {
    return change[directKey]
  }
  if (typeof change.diff === 'string') {
    const parsedDiff = parseFullFileUnifiedDiff(change.diff)
    const candidates = parsedDiff[version]
    if (candidates?.length > 0) {
      return chooseTextCandidate(candidates, options.expectedSha256)
    }
  }
  const contentEntry = contentsByPath.get(filePath)
  if (typeof contentEntry === 'string') {
    return contentEntry
  }
  if (contentEntry && typeof contentEntry[version] === 'string') {
    return contentEntry[version]
  }
  if (options.optional) {
    return null
  }
  throw new PatchToPendingChangesError(
    `Missing ${version} text content for ${filePath}`
  )
}

function requireKnownManifestEntry(change, manifestByPath) {
  const manifestEntry = manifestByPath.get(change.path)
  if (!manifestEntry) {
    throw new PatchToPendingChangesError(`Unknown project path: ${change.path}`)
  }
  return manifestEntry
}

function assertUnknownPath(change, manifestByPath) {
  if (manifestByPath.has(change.path)) {
    throw new PatchToPendingChangesError(
      `Created path already exists in manifest: ${change.path}`
    )
  }
}

function assertSupportedEntity(entry, expectedTypes, filePath) {
  if (!expectedTypes.includes(entry.entityType)) {
    throw new PatchToPendingChangesError(
      `Unsupported entity type for ${filePath}: ${entry.entityType}`
    )
  }
  if (!entry.entityId) {
    throw new PatchToPendingChangesError(`Missing entity id for ${filePath}`)
  }
}

function assertTextDoc(entry, filePath) {
  if (entry.binary) {
    throw new PatchToPendingChangesError(
      `Binary document changes are not supported as text edits: ${filePath}`
    )
  }
}

function hashContext(contextBefore, contextAfter) {
  return crypto
    .createHash('sha256')
    .update(contextBefore)
    .update('\0')
    .update(contextAfter)
    .digest('hex')
    .slice(0, 16)
}

function randomId() {
  return crypto.randomBytes(12).toString('hex')
}

function parseFullFileUnifiedDiff(diff) {
  const oldLines = []
  const newLines = []
  let inHunk = false

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@ ')) {
      inHunk = true
      continue
    }
    if (!inHunk || line === '') {
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue
    }

    const marker = line[0]
    const text = line.slice(1)
    if (marker === '-') {
      oldLines.push(text)
    } else if (marker === '+') {
      newLines.push(text)
    } else if (marker === ' ') {
      oldLines.push(text)
      newLines.push(text)
    }
  }

  return {
    old: textCandidates(oldLines),
    new: textCandidates(newLines)
  }
}

function textCandidates(lines) {
  if (lines.length === 0) {
    return ['']
  }
  const withoutTrailingNewline = lines.join('\n')
  return [withoutTrailingNewline, `${withoutTrailingNewline}\n`]
}

function chooseTextCandidate(candidates, expectedSha256) {
  if (expectedSha256) {
    const matched = candidates.find(
      (candidate) => sha256Text(candidate) === expectedSha256
    )
    if (matched !== undefined) {
      return matched
    }
  }
  return candidates[candidates.length - 1]
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
