import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import {
  fetchStream,
  fetchNothing,
  RequestFailedError,
} from '@overleaf/fetch-utils'
import { expressify } from '@overleaf/promise-utils'
import ProjectLocator from '../Project/ProjectLocator.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import Errors from '../Errors/Errors.js'

const KEY_PATTERN = /^[0-9a-f]{24}\/[0-9a-f]{24}$/
const USER_ID_RE = /^[0-9a-fA-F]{24}$/

/**
 * Extract and validate userId from the x-user-id header
 * (injected by AIAssistantProxy, never from the client directly).
 *
 * When Settings.aiAssistant.proxySecret is configured, the caller must also
 * provide an x-user-sig header containing HMAC-SHA256(secret, userId) in hex.
 * This prevents forged x-user-id headers if BasicAuth credentials leak.
 *
 * Returns the userId string or null if invalid/missing/signature mismatch.
 */
function getVerifiedUserId(req) {
  const userId = req.headers['x-user-id']
  if (!userId || !USER_ID_RE.test(userId)) {
    return null
  }

  const secret = Settings.aiAssistant?.proxySecret
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      // Refuse unauthenticated requests in production
      logger.warn({}, 'aiAssistant.proxySecret not configured in production — rejecting x-user-id')
      return null
    }
    // No secret configured in dev — degrade gracefully (compatible with existing deployments)
    return userId
  }

  const sig = req.headers['x-user-sig']
  if (!sig) {
    return null
  }

  // Validate hex format: SHA-256 HMAC produces exactly 64 hex characters
  if (!/^[0-9a-f]{64}$/i.test(sig)) {
    return null
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(userId)
    .digest('hex')

  const sigBuf = Buffer.from(sig, 'hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  if (sigBuf.length !== expectedBuf.length) {
    return null
  }

  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null
  }

  return userId
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

const SAFE_ATTACHMENT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function getFilestoreUrl() {
  return Settings.apis.filestore.url
}

function getFilestoreWriteHeaders() {
  const secret = Settings.apis.filestore.writeSecret
  if (!secret) return {}
  return { 'x-filestore-write-secret': secret }
}

function getFilestoreReadHeaders() {
  const secret = Settings.apis.filestore.readSecret
  if (!secret) return {}
  return { 'x-filestore-read-secret': secret }
}

const FILE_TOO_LARGE = 'FILE_TOO_LARGE'

/**
 * Create a Transform stream that enforces a maximum byte size.
 * Once the cumulative bytes exceed `maxSize`, the transform emits an error
 * with message FILE_TOO_LARGE, which the caller can catch and handle.
 */
function createSizeGuard(maxSize) {
  let streamed = 0
  return new Transform({
    transform(chunk, _enc, cb) {
      streamed += chunk.length
      if (streamed > maxSize) {
        cb(new Error(FILE_TOO_LARGE))
        return
      }
      cb(null, chunk)
    },
  })
}

async function uploadAttachment(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'no file uploaded' })
  }

  const userId = getVerifiedUserId(req)
  if (!userId) {
    // Clean up the uploaded temp file
    fs.unlink(req.file.path, () => {})
    return res.status(401).json({ error: 'invalid or missing userId' })
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase()
  const safeMimeType = SAFE_ATTACHMENT_MIME[ext]
  if (!safeMimeType) {
    fs.unlink(req.file.path, () => {})
    return res.status(400).json({ error: 'unsupported attachment type' })
  }

  const attachmentId = crypto.randomBytes(12).toString('hex') // 24 hex chars
  const storageKey = `${userId}/${attachmentId}`

  try {
    const fileStream = fs.createReadStream(req.file.path)
    const filestoreUrl = `${getFilestoreUrl()}/bucket/${Settings.aiAssistant?.attachmentsBucket || 'ai_attachments'}/key/${storageKey}`

    try {
      await fetchNothing(filestoreUrl, {
        method: 'POST',
        body: fileStream,
        headers: {
          'Content-Type': safeMimeType,
          ...getFilestoreWriteHeaders(),
        },
      })
    } catch (uploadErr) {
      // Ensure stream is destroyed on upload failure to prevent FD leak
      fileStream.destroy()
      throw uploadErr
    }

    res.json({
      attachmentId,
      storageKey,
      fileName: req.file.originalname,
      mimeType: safeMimeType,
      size: req.file.size,
    })
  } catch (err) {
    logger.err({ err, userId, attachmentId }, 'error uploading AI attachment')
    res.status(500).json({ error: 'failed to upload attachment' })
  } finally {
    // Clean up the temp file
    fs.unlink(req.file.path, () => {})
  }
}

async function downloadAttachment(req, res) {
  const storageKey = req.query.key
  if (!storageKey || !KEY_PATTERN.test(storageKey)) {
    return res.status(400).json({ error: 'invalid storage key' })
  }

  const userId = getVerifiedUserId(req)
  if (!userId) {
    return res.status(401).json({ error: 'invalid or missing userId' })
  }
  const keyUserId = storageKey.split('/')[0]
  if (keyUserId !== userId) {
    return res.status(403).json({ error: 'storage key does not belong to requesting user' })
  }

  try {
    const maxSize =
      Settings.aiAssistant?.attachmentDownloadMaxSize || 10 * 1024 * 1024 // 10 MB
    const filestoreUrl = `${getFilestoreUrl()}/bucket/${Settings.aiAssistant?.attachmentsBucket || 'ai_attachments'}/key/${storageKey}`
    const stream = await fetchStream(filestoreUrl, {
      headers: getFilestoreReadHeaders(),
    })
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', 'attachment')
    res.setHeader('X-Content-Type-Options', 'nosniff')

    const sizeGuard = createSizeGuard(maxSize)
    try {
      await pipeline(stream, sizeGuard, res)
    } catch (err) {
      if (err.message === FILE_TOO_LARGE) {
        if (!res.headersSent) {
          return res.status(413).json({ error: 'file_too_large' })
        }
        res.destroy()
        return
      }
      throw err
    }
  } catch (err) {
    if (res.headersSent) {
      // Data already piped — cannot send an error response
      logger.err({ err, storageKey }, 'error during AI attachment stream (headers already sent)')
      return
    }
    if (err instanceof RequestFailedError && err.response.status === 404) {
      return res.status(404).json({ error: 'attachment not found' })
    }
    logger.err({ err, storageKey }, 'error downloading AI attachment')
    res.status(500).json({ error: 'failed to download attachment' })
  }
}

async function deleteAttachment(req, res) {
  const storageKey = req.query.key
  if (!storageKey || !KEY_PATTERN.test(storageKey)) {
    return res.status(400).json({ error: 'invalid storage key' })
  }

  const userId = getVerifiedUserId(req)
  if (!userId) {
    return res.status(401).json({ error: 'invalid or missing userId' })
  }
  const keyUserId = storageKey.split('/')[0]
  if (keyUserId !== userId) {
    return res.status(403).json({ error: 'storage key does not belong to requesting user' })
  }

  try {
    const filestoreUrl = `${getFilestoreUrl()}/bucket/${Settings.aiAssistant?.attachmentsBucket || 'ai_attachments'}/key/${storageKey}`
    await fetchNothing(filestoreUrl, { method: 'DELETE', headers: getFilestoreWriteHeaders() })
    res.sendStatus(204)
  } catch (err) {
    if (err instanceof RequestFailedError && err.response.status === 404) {
      // Already deleted, treat as success
      return res.sendStatus(204)
    }
    logger.err({ err, storageKey }, 'error deleting AI attachment')
    res.status(500).json({ error: 'failed to delete attachment' })
  }
}

async function getProjectFileContent(req, res) {
  const projectId = req.params.Project_id
  const fileId = req.params.file_id

  if (!USER_ID_RE.test(projectId) || !USER_ID_RE.test(fileId)) {
    return res.status(400).json({ error: 'invalid projectId or fileId format' })
  }

  const userId = getVerifiedUserId(req)
  if (!userId) {
    return res.status(401).json({ error: 'invalid or missing userId' })
  }

  const canRead = await AuthorizationManager.promises.canUserReadProject(
    userId,
    projectId,
    null
  )
  if (!canRead) {
    return res
      .status(403)
      .json({ error: 'user does not have read access to project' })
  }

  let file
  let filePath
  try {
    ;({ element: file, path: filePath } = await ProjectLocator.promises.findElement({
      project_id: projectId,
      element_id: fileId,
      type: 'file',
    }))
  } catch (err) {
    if (err instanceof Errors.NotFoundError) {
      return res.status(404).json({ error: 'file not found' })
    }
    logger.err(
      { err, projectId, fileId },
      'error finding file for AI attachment'
    )
    return res.status(500).json({ error: 'failed to find file' })
  }

  try {
    // Set Content-Type based on file extension
    const ext = path.extname(file.name || filePath || '').toLowerCase()
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)

    if (!file.hash) {
      return res.status(404).json({ error: 'file content not available (no hash)' })
    }

    const maxSize =
      Settings.aiAssistant?.projectFileDownloadMaxSize || 10 * 1024 * 1024 // 10 MB

    const { stream, contentLength } =
      await HistoryManager.promises.requestBlobWithProjectId(
        projectId,
        file.hash,
        'GET'
      )

    if (contentLength && contentLength > maxSize) {
      // Consume and discard the stream to free the underlying connection
      stream.resume()
      return res
        .status(413)
        .json({ error: `file too large (${contentLength} bytes, limit ${maxSize})` })
    }

    if (contentLength) {
      res.setHeader('Content-Length', contentLength)
    }

    // Always enforce size limit via Transform guard, even when Content-Length
    // is missing, to prevent unbounded memory / bandwidth consumption.
    const sizeGuard = createSizeGuard(maxSize)
    try {
      await pipeline(stream, sizeGuard, res)
    } catch (err) {
      if (err.message === FILE_TOO_LARGE) {
        if (!res.headersSent) {
          return res.status(413).json({ error: 'file_too_large' })
        }
        res.destroy()
        return
      }
      throw err
    }
  } catch (err) {
    if (res.headersSent) {
      logger.err({ err, projectId, fileId }, 'error during project file stream (headers already sent)')
      return
    }
    if (err instanceof Errors.NotFoundError) {
      return res.status(404).json({ error: 'file content not found' })
    }
    logger.err(
      { err, projectId, fileId },
      'error fetching file content for AI attachment'
    )
    res.status(500).json({ error: 'failed to fetch file content' })
  }
}

export default {
  uploadAttachment: expressify(uploadAttachment),
  downloadAttachment: expressify(downloadAttachment),
  deleteAttachment: expressify(deleteAttachment),
  getProjectFileContent: expressify(getProjectFileContent),
}
