import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import OError from '@overleaf/o-error'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Blob } from 'node:buffer'

export class FileStoreError extends OError {}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/

/**
 * FileStoreAdapter handles communication with Web service for AI attachment storage.
 * Follows the same pattern as ProjectAdapter (constructor reads from settings.apis.web).
 */
export class FileStoreAdapter {
  constructor(options = {}) {
    const apiConfig = settings.apis || {}
    this.webServiceUrl =
      options.webServiceUrl || apiConfig.web?.url || 'http://127.0.0.1:3000'
    this.timeout = options.timeout || settings.fileStoreAdapter?.timeoutMs || 60000

    // Basic auth credentials for internal API (same as ProjectAdapter)
    this.authCredentials = options.authCredentials || {
      user: apiConfig.web?.user || 'overleaf',
      pass: apiConfig.web?.pass || '',
    }
  }

  /**
   * Build Basic Auth headers for internal API calls
   * @returns {object} Headers object with Authorization if credentials are set
   */
  _makeAuthHeaders() {
    const headers = {}
    if (this.authCredentials.pass) {
      const auth = Buffer.from(
        `${this.authCredentials.user}:${this.authCredentials.pass}`
      ).toString('base64')
      headers.Authorization = `Basic ${auth}`
    }
    return headers
  }

  /**
   * Compute HMAC-SHA256 signature for the given userId.
   * Returns the hex signature string, or null if proxySecret is not configured.
   */
  _computeUserSig(userId) {
    const secret = settings.internal?.proxySecret
    if (!secret || !userId) return null
    return crypto.createHmac('sha256', secret).update(userId).digest('hex')
  }

  /**
   * Upload an attachment to the web internal API
   * @param {string} filePath - Local file path to upload
   * @param {object} metadata - Upload metadata
   * @param {string} metadata.userId - User ID
   * @param {string} metadata.sessionId - Session ID
   * @param {string} metadata.attachmentId - Attachment ID
   * @param {string} [metadata.filename] - Original filename (for Content-Type detection)
   * @param {string} [metadata.mimeType] - MIME type of the file
   * @returns {Promise<{storageKey: string}>}
   */
  async uploadAttachment(filePath, metadata) {
    const url = `${this.webServiceUrl}/internal/ai/attachment`

    logger.debug(
      { filePath, metadata, url },
      'Uploading attachment to filestore'
    )

    // Path traversal protection: resolve symlinks and verify the file
    // resides within the system temp directory or a configured upload directory
    const realPath = await fs.realpath(filePath)
    const allowedDirs = []
    // Normalize allowedDirs through realpath too, so symlinked tmp/upload dirs
    // don't cause false negatives.
    try {
      allowedDirs.push(await fs.realpath(os.tmpdir()))
    } catch {
      allowedDirs.push(path.resolve(os.tmpdir()))
    }
    const configuredUploadDir = settings.image?.uploadDir
    if (configuredUploadDir) {
      try {
        allowedDirs.push(await fs.realpath(configuredUploadDir))
      } catch {
        allowedDirs.push(path.resolve(configuredUploadDir))
      }
    }
    const isAllowed = allowedDirs.some(dir => realPath.startsWith(dir + path.sep) || realPath === dir)
    if (!isAllowed) {
      throw new FileStoreError(
        'File path is outside allowed upload directories',
        { realPath, allowedDirs }
      )
    }

    // Validate file size and read using a single file handle to avoid TOCTOU race
    const maxSize = settings.fileStoreAdapter?.uploadMaxSize || settings.image?.maxSize || 5 * 1024 * 1024
    let fileBuffer
    let fileHandle
    try {
      fileHandle = await fs.open(realPath, 'r')
      const stat = await fileHandle.stat()

      if (!stat.isFile()) {
        throw new FileStoreError(
          'Path does not point to a regular file',
          { realPath }
        )
      }

      if (stat.size > maxSize) {
        throw new FileStoreError(
          `File too large: ${stat.size} bytes (max ${maxSize})`,
          { size: stat.size, maxSize }
        )
      }

      fileBuffer = await fileHandle.readFile()
    } finally {
      await fileHandle?.close()
    }
    const mimeType = metadata.mimeType || 'application/octet-stream'
    const fileBlob = new Blob([fileBuffer], { type: mimeType })
    const filename = metadata.filename || 'attachment'

    const formData = new FormData()
    formData.append('file', fileBlob, filename)
    formData.append('userId', metadata.userId)
    if (metadata.sessionId) {
      formData.append('sessionId', metadata.sessionId)
    }
    formData.append('attachmentId', metadata.attachmentId)

    const headers = {
      ...this._makeAuthHeaders(),
    }
    if (metadata.userId) {
      headers['x-user-id'] = metadata.userId
      const sig = this._computeUserSig(metadata.userId)
      if (sig) {
        headers['x-user-sig'] = sig
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error({ errorText, statusCode: response.status, filePath }, 'FileStore upload failed')
      throw new FileStoreError('Failed to upload attachment', { status: response.status })
    }

    const data = await response.json()
    return { storageKey: data.storageKey }
  }

  /**
   * Download an attachment from the web internal API
   * @param {string} storageKey - Storage key of the attachment
   * @param {string} [userId] - User ID for ownership verification
   * @returns {Promise<Buffer>}
   */
  async downloadAttachment(storageKey, userId) {
    let url = `${this.webServiceUrl}/internal/ai/attachment?key=${encodeURIComponent(storageKey)}`
    if (userId) {
      url += `&userId=${encodeURIComponent(userId)}`
    }

    logger.debug({ storageKey, url }, 'Downloading attachment from filestore')

    const headers = {
      ...this._makeAuthHeaders(),
    }
    if (userId) {
      headers['x-user-id'] = userId
      const sig = this._computeUserSig(userId)
      if (sig) {
        headers['x-user-sig'] = sig
      }
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error({ errorText, statusCode: response.status, storageKey }, 'FileStore download failed')
      throw new FileStoreError('Failed to download attachment', { status: response.status })
    }

    // Handle empty responses
    if (!response.body) {
      return Buffer.alloc(0)
    }

    // Guard against oversized responses before buffering into memory
    const maxDownloadSize = settings.fileStoreAdapter?.downloadMaxSize || settings.image?.maxSize || 5 * 1024 * 1024
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
    if (contentLength === 0 && response.headers.has('content-length')) {
      return Buffer.alloc(0)
    }
    if (contentLength > maxDownloadSize) {
      await response.body?.cancel()
      throw new FileStoreError(
        `Download too large: ${contentLength} bytes (max ${maxDownloadSize})`,
        { contentLength, maxDownloadSize }
      )
    }

    // When Content-Length is present and within limit, read directly
    if (contentLength > 0) {
      const arrayBuffer = await response.arrayBuffer()
      return Buffer.from(arrayBuffer)
    }

    // No Content-Length — read in chunks with size guard
    const chunks = []
    let totalSize = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalSize += value.length
        if (totalSize > maxDownloadSize) {
          reader.cancel()
          throw new FileStoreError(
            `Download exceeds size limit: ${totalSize}+ bytes (max ${maxDownloadSize})`,
            { totalSize, maxDownloadSize }
          )
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }

  /**
   * Download a project file (binary) from the web internal API
   * @param {string} projectId - Project ID
   * @param {string} fileId - File ID
   * @param {string} [userId] - User ID for authorization
   * @returns {Promise<Buffer>}
   */
  async downloadProjectFile(projectId, fileId, userId) {
    // Validate IDs to prevent injection via crafted path segments
    if (!OBJECT_ID_RE.test(projectId)) {
      throw new FileStoreError('Invalid projectId format', { projectId })
    }
    if (!OBJECT_ID_RE.test(fileId)) {
      throw new FileStoreError('Invalid fileId format', { fileId })
    }

    const url = `${this.webServiceUrl}/internal/project/${projectId}/file/${fileId}/content`

    logger.debug({ projectId, fileId, url }, 'Downloading project file')

    const headers = {
      ...this._makeAuthHeaders(),
    }
    if (userId) {
      headers['x-user-id'] = userId
      const sig = this._computeUserSig(userId)
      if (sig) {
        headers['x-user-sig'] = sig
      }
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error({ errorText, statusCode: response.status, projectId, fileId }, 'FileStore project file download failed')
      throw new FileStoreError('Failed to download project file', { status: response.status })
    }

    // Handle empty responses
    if (!response.body) {
      return Buffer.alloc(0)
    }

    // Guard against oversized responses before buffering into memory
    const maxDownloadSize = settings.fileStore?.maxProjectFileDownloadSize || settings.image?.maxSize || 5 * 1024 * 1024
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
    if (contentLength === 0 && response.headers.has('content-length')) {
      return Buffer.alloc(0)
    }
    if (contentLength > maxDownloadSize) {
      await response.body?.cancel()
      throw new FileStoreError(
        `Download too large: ${contentLength} bytes (max ${maxDownloadSize})`,
        { contentLength, maxDownloadSize }
      )
    }

    // When Content-Length is present and within limit, read directly
    if (contentLength > 0) {
      const arrayBuffer = await response.arrayBuffer()
      return Buffer.from(arrayBuffer)
    }

    // No Content-Length — read in chunks with size guard
    const chunks = []
    let totalSize = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalSize += value.length
        if (totalSize > maxDownloadSize) {
          reader.cancel()
          throw new FileStoreError(
            `Download exceeds size limit: ${totalSize}+ bytes (max ${maxDownloadSize})`,
            { totalSize, maxDownloadSize }
          )
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }

  /**
   * Delete an attachment from the web internal API
   * @param {string} storageKey - Storage key of the attachment
   * @param {string} [userId] - User ID for ownership verification
   */
  async deleteAttachment(storageKey, userId) {
    let url = `${this.webServiceUrl}/internal/ai/attachment?key=${encodeURIComponent(storageKey)}`
    if (userId) {
      url += `&userId=${encodeURIComponent(userId)}`
    }

    logger.debug({ storageKey, url }, 'Deleting attachment from filestore')

    const headers = {
      ...this._makeAuthHeaders(),
    }
    if (userId) {
      headers['x-user-id'] = userId
      const sig = this._computeUserSig(userId)
      if (sig) {
        headers['x-user-sig'] = sig
      }
    }

    const response = await fetch(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error({ errorText, statusCode: response.status, storageKey }, 'FileStore delete failed')
      throw new FileStoreError('Failed to delete attachment', { status: response.status })
    }
  }

  /**
   * Batch delete attachments by their storage keys
   * @param {Array<{storageKey: string}>} attachments - Array of attachment objects with storageKey
   * @param {string} [userId] - User ID for ownership verification
   */
  async deleteSessionAttachments(attachments, userId) {
    if (!attachments || attachments.length === 0) return

    const errors = []
    for (const attachment of attachments) {
      if (!attachment.storageKey) continue
      try {
        await this.deleteAttachment(attachment.storageKey, userId)
      } catch (err) {
        logger.warn(
          { storageKey: attachment.storageKey, err: err.message },
          'Failed to delete attachment from filestore'
        )
        errors.push(err)
      }
    }

    if (errors.length > 0) {
      logger.warn(
        { errorCount: errors.length, totalCount: attachments.length },
        'Some attachments failed to delete from filestore'
      )
    }
  }
}

export default FileStoreAdapter
