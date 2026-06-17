import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, ObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../app/src/Features/User/UserUpdater.mjs'
import UserDeleter from '../../../../app/src/Features/User/UserDeleter.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectDeleter from '../../../../app/src/Features/Project/ProjectDeleter.mjs'
import OwnershipTransferHandler from '../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import ProjectAuditLogHandler from '../../../../app/src/Features/Project/ProjectAuditLogHandler.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { expressify } from '@overleaf/promise-utils'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))
const MAX_PAGE_LIMIT = 100

function isSameId(left, right) {
  if (!left || !right) {
    return false
  }
  return left.toString() === right.toString()
}

function parseObjectIdParam(res, value, label) {
  if (!ObjectId.isValid(value)) {
    res.status(400).json({ error: `invalid ${label}` })
    return null
  }
  return new ObjectId(value)
}

function usersPage(req, res) {
  res.render(Path.resolve(__dirname, '../views/admin/users'))
}

function userDetailPage(req, res) {
  res.render(Path.resolve(__dirname, '../views/admin/user-detail'), {
    adminUserId: req.params.userId,
  })
}

async function listUsers(req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const rawLimit = parseInt(req.query.limit, 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_LIMIT) : 20
  const query = req.query.query

  const escapedQuery = query
    ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : null
  // Anchor regex to prefix (^) to leverage the email index
  const filter = escapedQuery
    ? { email: { $regex: '^' + escapedQuery, $options: 'i' } }
    : {}

  const skip = (page - 1) * limit
  // Fetch limit+1 rows to detect whether a next page exists,
  // avoiding an expensive countDocuments call on large collections
  const rows = await db.users
    .find(filter, {
      projection: {
        email: 1,
        first_name: 1,
        last_name: 1,
        isAdmin: 1,
        suspended: 1,
        createdAt: 1,
        lastLoggedIn: 1,
      },
    })
    .skip(skip)
    .limit(limit + 1)
    .toArray()

  const hasMore = rows.length > limit
  const users = hasMore ? rows.slice(0, limit) : rows

  res.json({
    users,
    hasMore,
  })
}

async function getUser(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const user = await UserGetter.promises.getUser(userId, {
    email: 1,
    first_name: 1,
    last_name: 1,
    isAdmin: 1,
    suspended: 1,
    createdAt: 1,
    lastLoggedIn: 1,
    loginCount: 1,
    lastLoginIp: 1,
    features: 1,
  })

  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }

  res.json(user)
}

async function toggleAdmin(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const adminId = SessionManager.getLoggedInUserId(req.session)

  if (isSameId(userId, adminId)) {
    return res
      .status(400)
      .json({ error: 'cannot modify your own admin privileges' })
  }

  const user = await UserGetter.promises.getUser(userId, { isAdmin: 1 })

  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }

  await UserUpdater.promises.updateUser(userId.toString(), {
    $set: { isAdmin: !user.isAdmin },
  })

  await UserAuditLogHandler.promises.addEntry(
    userId.toString(),
    'toggle-admin',
    adminId,
    req.ip,
    { isAdmin: !user.isAdmin }
  )

  res.json({ success: true, isAdmin: !user.isAdmin })
}

async function suspendUser(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const adminId = SessionManager.getLoggedInUserId(req.session)

  if (isSameId(userId, adminId)) {
    return res
      .status(400)
      .json({ error: 'cannot suspend your own account' })
  }

  await UserUpdater.promises.suspendUser(userId.toString(), {
    initiatorId: adminId,
    ip: req.ip,
  })

  res.json({ success: true })
}

async function unsuspendUser(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const adminId = SessionManager.getLoggedInUserId(req.session)

  await UserUpdater.promises.unsuspendUser(userId.toString(), {
    initiatorId: adminId,
    ip: req.ip,
  })

  res.json({ success: true })
}

async function deleteUser(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const adminId = SessionManager.getLoggedInUserId(req.session)

  if (isSameId(userId, adminId)) {
    return res.status(400).json({ error: 'cannot delete your own account' })
  }

  const user = await UserGetter.promises.getUser(userId, {
    email: 1,
    _id: 1,
  })

  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }

  await UserDeleter.promises.ensureCanDeleteUser(user)
  await UserDeleter.promises.deleteUser(userId, {
    deleterUser: { _id: adminId },
    ipAddress: req.ip,
  })

  res.json({ success: true })
}

async function getUserProjects(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return

  const allProjects = await ProjectGetter.promises.findAllUsersProjects(
    userId.toString(),
    'name lastUpdated owner_ref'
  )

  const projects = [
    ...allProjects.owned,
    ...allProjects.readAndWrite,
    ...allProjects.readOnly,
    ...allProjects.tokenReadAndWrite,
    ...allProjects.tokenReadOnly,
  ]

  res.json({ projects })
}

async function transferProject(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const projectId = parseObjectIdParam(res, req.params.projectId, 'project id')
  if (!projectId) return
  const { targetUserId: targetInput } = req.body
  const adminId = SessionManager.getLoggedInUserId(req.session)

  if (!targetInput || !targetInput.trim()) {
    return res.status(400).json({ error: 'target user email or ID is required' })
  }

  let resolvedUserId = targetInput.trim()
  // If input contains '@', treat as email and look up the user ID
  if (resolvedUserId.includes('@')) {
    const targetUser = await UserGetter.promises.getUserByMainEmail(
      resolvedUserId,
      { _id: 1 }
    )
    if (!targetUser) {
      return res
        .status(404)
        .json({ error: `no user found with email: ${resolvedUserId}` })
    }
    resolvedUserId = targetUser._id.toString()
  } else if (!ObjectId.isValid(resolvedUserId)) {
    return res.status(400).json({ error: 'invalid target user id' })
  }

  const project = await ProjectGetter.promises.getProject(projectId, {
    owner_ref: 1,
  })
  if (!project) {
    return res.status(404).json({ error: 'project not found' })
  }
  if (!isSameId(project.owner_ref, userId)) {
    return res.status(400).json({ error: 'project does not belong to user' })
  }

  await OwnershipTransferHandler.promises.transferOwnership(
    projectId.toString(),
    resolvedUserId,
    {
      allowTransferToNonCollaborators: true,
      sessionUserId: adminId,
      ipAddress: req.ip,
    }
  )

  res.json({ success: true })
}

async function getDeletedProjects(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return

  const deletedProjects = await db.deletedProjects
    .find(
      { 'deleterData.deletedProjectOwnerId': userId },
      {
        projection: {
          'deleterData.deletedAt': 1,
          'project._id': 1,
          'project.name': 1,
        },
      }
    )
    .sort({ 'deleterData.deletedAt': -1 })
    .toArray()

  res.json({ deletedProjects })
}

async function restoreProject(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const projectId = parseObjectIdParam(res, req.params.projectId, 'project id')
  if (!projectId) return
  const adminId = SessionManager.getLoggedInUserId(req.session)

  const deletedProject = await db.deletedProjects.findOne({
    'deleterData.deletedProjectId': projectId,
    'deleterData.deletedProjectOwnerId': userId,
  })

  if (!deletedProject) {
    return res.status(404).json({ error: 'deleted project not found' })
  }

  await ProjectDeleter.promises.undeleteProject(projectId.toString(), {
    userId,
  })
  ProjectAuditLogHandler.addEntryIfManagedInBackground(
    projectId,
    'project-restored',
    adminId,
    req.ip,
    { restoredOwnerId: userId.toString() }
  )

  res.json({ success: true })
}

async function getAuditLog(req, res) {
  const userId = parseObjectIdParam(res, req.params.userId, 'user id')
  if (!userId) return
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const rawLimit = parseInt(req.query.limit, 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_LIMIT) : 20

  const [entries, totalEntries] = await Promise.all([
    db.userAuditLogEntries
      .find({ userId })
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    db.userAuditLogEntries.countDocuments({
      userId,
    }),
  ])

  res.json({
    entries,
    totalEntries,
    totalPages: Math.ceil(totalEntries / limit),
  })
}

function aiModelsPage(req, res) {
  res.render(Path.resolve(__dirname, '../views/admin/ai-models'), {
    title: 'AI Model Management',
  })
}

export default {
  aiModelsPage,
  usersPage,
  userDetailPage,
  listUsers: expressify(listUsers),
  getUser: expressify(getUser),
  toggleAdmin: expressify(toggleAdmin),
  suspendUser: expressify(suspendUser),
  unsuspendUser: expressify(unsuspendUser),
  deleteUser: expressify(deleteUser),
  getUserProjects: expressify(getUserProjects),
  transferProject: expressify(transferProject),
  getDeletedProjects: expressify(getDeletedProjects),
  restoreProject: expressify(restoreProject),
  getAuditLog: expressify(getAuditLog),
}
