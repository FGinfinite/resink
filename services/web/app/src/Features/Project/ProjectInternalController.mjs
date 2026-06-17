import { expressify } from '@overleaf/promise-utils'
import ProjectEntityHandler from './ProjectEntityHandler.mjs'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'

/**
 * Get all entities (docs and files) in a project with their paths
 * Used by AI Writing Agent to resolve file paths to document IDs
 */
async function getEntities(req, res) {
  const { Project_id: projectId } = req.params

  const entities = await ProjectEntityHandler.promises.getAllEntities(projectId)

  // Transform to simplified format for AI service consumption
  const response = {
    docs: entities.docs.map(({ path, doc }) => ({
      id: doc._id.toString(),
      path,
      name: doc.name,
    })),
    files: entities.files.map(({ path, file }) => ({
      id: file._id.toString(),
      path,
      name: file.name,
    })),
  }

  res.json(response)
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/

/**
 * Check if a user has read access to a project
 * Used by AI Writing Agent to verify membership before operations
 */
async function checkMembership(req, res) {
  const { projectId, userId } = req.params
  if (!OBJECT_ID_RE.test(projectId) || !OBJECT_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'invalid id' })
  }
  const canRead = await AuthorizationManager.promises.canUserReadProject(
    userId,
    projectId,
    null
  )
  return canRead ? res.sendStatus(204) : res.sendStatus(403)
}

/**
 * Check if a user has write access to a project
 * Used by AI Writing Agent to verify write permission before mutations (e.g. project rules)
 */
async function checkWriteMembership(req, res) {
  const { projectId, userId } = req.params
  if (!OBJECT_ID_RE.test(projectId) || !OBJECT_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'invalid id' })
  }
  const canWrite =
    await AuthorizationManager.promises.canUserWriteProjectContent(
      userId,
      projectId,
      null
    )
  return canWrite ? res.sendStatus(204) : res.sendStatus(403)
}

export default {
  getEntities: expressify(getEntities),
  checkMembership: expressify(checkMembership),
  checkWriteMembership: expressify(checkWriteMembership),
}
