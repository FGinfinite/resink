import logger from '@overleaf/logger'
import AdminPanelController from './AdminPanelController.mjs'
import RuntimeConfigController from './RuntimeConfigController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'

export default {
  apply(webRouter) {
    logger.debug({}, 'Init AdminPanel router')

    // Page routes
    webRouter.get(
      '/admin/users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.usersPage
    )
    webRouter.get(
      '/admin/users/:userId',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.userDetailPage
    )

    // API routes
    webRouter.get(
      '/admin/api/users',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.listUsers
    )
    webRouter.get(
      '/admin/api/users/:userId',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.getUser
    )
    webRouter.post(
      '/admin/api/users/:userId/toggle-admin',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.toggleAdmin
    )
    webRouter.post(
      '/admin/api/users/:userId/suspend',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.suspendUser
    )
    webRouter.post(
      '/admin/api/users/:userId/unsuspend',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.unsuspendUser
    )
    webRouter.delete(
      '/admin/api/users/:userId',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.deleteUser
    )
    webRouter.get(
      '/admin/api/users/:userId/projects',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.getUserProjects
    )
    webRouter.post(
      '/admin/api/users/:userId/projects/:projectId/transfer',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.transferProject
    )
    webRouter.get(
      '/admin/api/users/:userId/deleted-projects',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.getDeletedProjects
    )
    webRouter.post(
      '/admin/api/users/:userId/deleted-projects/:projectId/restore',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.restoreProject
    )
    webRouter.get(
      '/admin/api/users/:userId/audit-log',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.getAuditLog
    )

    webRouter.get(
      '/admin/ai-models',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminPanelController.aiModelsPage
    )
    webRouter.get(
      '/admin/config',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      RuntimeConfigController.configPage
    )
    webRouter.get(
      '/admin/api/config/services',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      RuntimeConfigController.listServices
    )
    webRouter.get(
      '/admin/api/config/:service/entries',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      RuntimeConfigController.listEntries
    )
    webRouter.get(
      '/admin/api/config/:service/revisions/:key',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      RuntimeConfigController.getEntryRevisions
    )
    webRouter.put(
      '/admin/api/config/:service/values/:key',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      RuntimeConfigController.updateEntry
    )
    webRouter.delete(
      '/admin/api/config/:service/values/:key',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      RuntimeConfigController.resetEntry
    )
    webRouter.post(
      '/admin/api/config/:service/revisions/:key/rollback',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      RuntimeConfigController.rollbackEntry
    )
  },
}
