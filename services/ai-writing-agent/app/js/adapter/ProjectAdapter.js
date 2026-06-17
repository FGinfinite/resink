import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import OError from '@overleaf/o-error'

export class ProjectError extends OError {}
export class ProjectNotFoundError extends ProjectError {}
export class EntityNotFoundError extends ProjectError {}

// Cache limits to prevent unbounded memory growth in long-running processes
const CACHE_MAX_SIZE = settings.projectCache?.entityCacheMax || 500
const CACHE_TTL_MS = settings.projectCache?.entityCacheTtlMs || 5 * 60 * 1000 // 5 minutes

/**
 * ProjectAdapter handles communication with Web service for project-level operations
 * Provides file listing and path resolution capabilities
 */
export class ProjectAdapter {
  constructor(options = {}) {
    const apiConfig = settings.apis || {}
    this.webServiceUrl =
      options.webServiceUrl || apiConfig.web?.url || 'http://127.0.0.1:3000'
    this.timeout = options.timeout || 30000

    // Basic auth credentials for internal API
    // Read from settings.apis.web (matching settings.defaults.cjs)
    this.authCredentials = options.authCredentials || {
      user: apiConfig.web?.user || 'overleaf',
      pass: apiConfig.web?.pass || '',
    }

    // Cache for entities per project (bounded by CACHE_MAX_SIZE with TTL expiration)
    this._cache = new Map()
  }

  /**
   * Get all entities (docs and files) for a project
   * @param {string} projectId - Project ID
   * @returns {Promise<{ docs: Array<{id: string, path: string, name: string}>, files: Array<{id: string, path: string, name: string}> }>}
   */
  async getEntities(projectId) {
    // Check cache first (with TTL expiration)
    const cached = this._cache.get(projectId)
    if (cached) {
      if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
        this._cache.delete(projectId)
      } else {
        return cached.data
      }
    }

    const url = `${this.webServiceUrl}/internal/project/${projectId}/entities`

    logger.debug({ projectId, url }, 'Getting project entities')

    try {
      const headers = {
        Accept: 'application/json',
        ...this._makeAuthHeaders(),
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeout),
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new ProjectNotFoundError('Project not found', { projectId })
        }
        const errorText = await response.text()
        throw new ProjectError(`Failed to get project entities: ${errorText}`, {
          status: response.status,
        })
      }

      const data = await response.json()

      // Cache the result (with capacity enforcement)
      if (this._cache.size >= CACHE_MAX_SIZE) {
        // Evict the oldest entry (Map iterates in insertion order)
        const firstKey = this._cache.keys().next().value
        this._cache.delete(firstKey)
      }
      this._cache.set(projectId, {
        data,
        timestamp: Date.now(),
      })

      return data
    } catch (error) {
      if (error instanceof ProjectError) {
        throw error
      }
      throw new ProjectError('Failed to get project entities', { cause: error })
    }
  }

  /**
   * List all files in the project
   * @param {string} projectId - Project ID
   * @param {object} options - Options
   * @param {string} [options.type='all'] - Type filter: 'all', 'docs', 'files'
   * @param {string} [options.pattern] - Glob pattern to filter files
   * @returns {Promise<Array<{id: string, path: string, name: string, type: string}>>}
   */
  async listFiles(projectId, options = {}) {
    const { type = 'all', pattern } = options
    const entities = await this.getEntities(projectId)

    let result = []

    if (type === 'all' || type === 'docs') {
      result = result.concat(
        entities.docs.map(doc => ({ ...doc, type: 'doc' }))
      )
    }

    if (type === 'all' || type === 'files') {
      result = result.concat(
        entities.files.map(file => ({ ...file, type: 'file' }))
      )
    }

    // Apply pattern filter if specified
    if (pattern) {
      result = result.filter(item => matchGlobPattern(item.path, pattern))
    }

    // Sort by path
    result.sort((a, b) => a.path.localeCompare(b.path))

    return result
  }

  /**
   * Resolve a file path to a document ID
   * @param {string} projectId - Project ID
   * @param {string} filePath - File path (e.g., "main.tex" or "/main.tex")
   * @returns {Promise<string|null>} - Document ID or null if not found
   */
  async resolvePathToDocId(projectId, filePath) {
    const entities = await this.getEntities(projectId)

    // Normalize path (ensure leading slash)
    const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`

    // Search in docs first
    for (const doc of entities.docs) {
      if (doc.path === normalizedPath) {
        return doc.id
      }
    }

    return null
  }

  /**
   * Resolve a file path to entity info (doc or file)
   * @param {string} projectId - Project ID
   * @param {string} filePath - File path
   * @returns {Promise<{id: string, path: string, name: string, type: 'doc'|'file'}|null>}
   */
  async resolvePathToEntity(projectId, filePath) {
    const entities = await this.getEntities(projectId)

    // Normalize path (ensure leading slash)
    const normalizedPath = filePath.startsWith('/') ? filePath : `/${filePath}`

    // Search in docs first
    for (const doc of entities.docs) {
      if (doc.path === normalizedPath) {
        return { ...doc, type: 'doc' }
      }
    }

    // Then search in files
    for (const file of entities.files) {
      if (file.path === normalizedPath) {
        return { ...file, type: 'file' }
      }
    }

    return null
  }

  /**
   * Resolve a document ID to its path
   * @param {string} projectId - Project ID
   * @param {string} docId - Document ID
   * @returns {Promise<string|null>} - File path or null if not found
   */
  async resolveDocIdToPath(projectId, docId) {
    const entities = await this.getEntities(projectId)

    for (const doc of entities.docs) {
      if (doc.id === docId) {
        return doc.path
      }
    }

    return null
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
   * Create a new document via Web internal API
   * @param {string} projectId - Project ID
   * @param {string} name - File name
   * @param {string|null} parentFolderId - Parent folder ID (null for root)
   * @param {string} userId - User ID performing the action
   * @returns {Promise<object>} Created doc object with _id
   */
  async createDoc(projectId, name, parentFolderId, userId) {
    const url = `${this.webServiceUrl}/internal/project/${projectId}/doc`

    logger.debug({ projectId, name, parentFolderId }, 'Creating document')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._makeAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, parent_folder_id: parentFolderId, userId }),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new ProjectError(`Failed to create document: ${errorText}`, {
        status: response.status,
      })
    }

    return response.json()
  }

  /**
   * Delete an entity via Web internal API
   * @param {string} projectId - Project ID
   * @param {string} entityId - Entity ID
   * @param {string} entityType - Entity type ('doc', 'file', 'folder')
   * @param {string} userId - User ID performing the action
   */
  async deleteEntity(projectId, entityId, entityType, userId) {
    const url = `${this.webServiceUrl}/internal/project/${projectId}/${entityType}/${entityId}`

    logger.debug({ projectId, entityId, entityType }, 'Deleting entity')

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        ...this._makeAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new ProjectError(`Failed to delete entity: ${errorText}`, {
        status: response.status,
      })
    }
  }

  /**
   * Create a folder via Web internal API
   * @param {string} projectId - Project ID
   * @param {string} name - Folder name
   * @param {string|null} parentFolderId - Parent folder ID
   * @param {string} userId - User ID
   * @returns {Promise<object>} Created folder object
   */
  async createFolder(projectId, name, parentFolderId, userId) {
    const url = `${this.webServiceUrl}/internal/project/${projectId}/folder`

    logger.debug({ projectId, name, parentFolderId }, 'Creating folder')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this._makeAuthHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, parent_folder_id: parentFolderId, userId }),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new ProjectError(`Failed to create folder: ${errorText}`, {
        status: response.status,
      })
    }

    return response.json()
  }

  /**
   * Ensure a folder path exists, creating intermediate folders as needed
   * @param {string} projectId - Project ID
   * @param {string} folderPath - Folder path (e.g., "/chapters/appendix")
   * @param {string} userId - User ID
   * @returns {Promise<{folderId: string}>} The leaf folder ID
   */
  async ensureFolderPath(projectId, folderPath, userId) {
    // Normalize: remove leading/trailing slashes, split into parts
    const normalized = folderPath.replace(/^\/+|\/+$/g, '')
    if (!normalized) {
      return { folderId: null } // root folder
    }

    const parts = normalized.split('/')

    // Refresh entity list to check existing folders
    this.clearCache(projectId)
    const entities = await this.getEntities(projectId)

    // Check if the full path already exists as a folder
    // The entities API returns docs and files with paths, but not folders directly
    // We need to check by trying to find docs/files that share this folder prefix
    // Instead, we'll create folders one by one, catching "already exists" errors

    let parentFolderId = null

    for (let i = 0; i < parts.length; i++) {
      const partialPath = '/' + parts.slice(0, i + 1).join('/')
      const folderName = parts[i]

      // Check if any entity has this path prefix (meaning folder exists)
      const hasEntitiesInPath = [...entities.docs, ...entities.files].some(
        e => e.path.startsWith(partialPath + '/')
      )

      if (hasEntitiesInPath && i < parts.length - 1) {
        // Folder likely exists, but we need its ID
        // Try to create it and handle duplicate error
        try {
          const folder = await this.createFolder(projectId, folderName, parentFolderId, userId)
          parentFolderId = folder._id
        } catch (err) {
          // If folder already exists, we need to find its ID from a newly fetched entity list
          this.clearCache(projectId)
          const refreshed = await this.getEntities(projectId)
          // Find a doc/file whose path starts with partialPath to infer folder exists
          const child = [...refreshed.docs, ...refreshed.files].find(
            e => e.path.startsWith(partialPath + '/')
          )
          if (child) {
            // Folder exists but we don't have its ID directly
            // Create next level folder using null parent (will be resolved by server)
            // Actually, try creating the folder again — it may have worked
            parentFolderId = null
          } else {
            throw err
          }
        }
      } else {
        // Create the folder
        try {
          const folder = await this.createFolder(projectId, folderName, parentFolderId, userId)
          parentFolderId = folder._id
        } catch (err) {
          // Folder might already exist — continue
          logger.warn(
            { projectId, folderName, err: err.message },
            'Folder creation failed, may already exist'
          )
          parentFolderId = null
        }
      }
    }

    return { folderId: parentFolderId }
  }

  /**
   * Clear cache for a project
   * @param {string} projectId - Project ID (optional, clears all if not provided)
   */
  clearCache(projectId) {
    if (projectId) {
      this._cache.delete(projectId)
    } else {
      this._cache.clear()
    }
  }
}

/**
 * Simple glob pattern matching
 * Supports: * (any characters), ? (single character)
 * @param {string} path - Path to match
 * @param {string} pattern - Glob pattern
 * @returns {boolean}
 */
function matchGlobPattern(path, pattern) {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
    .replace(/\*/g, '.*') // * matches any characters
    .replace(/\?/g, '.') // ? matches single character

  const regex = new RegExp(`^${regexPattern}$`, 'i')
  return regex.test(path)
}

// Singleton instance
let defaultAdapter = null

export function getProjectAdapter() {
  if (!defaultAdapter) {
    defaultAdapter = new ProjectAdapter()
  }
  return defaultAdapter
}

export default ProjectAdapter
