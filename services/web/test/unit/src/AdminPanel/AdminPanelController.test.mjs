import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const modulePath =
  '../../../../modules/admin-panel/app/src/AdminPanelController.mjs'

class FakeObjectId {
  constructor(value) {
    this.value = value
  }

  static isValid(value) {
    return Boolean(value) && !String(value).startsWith('invalid')
  }

  toString() {
    return String(this.value)
  }
}

describe('AdminPanelController', function () {
  beforeEach(async function (ctx) {
    ctx.adminId = 'admin-id'
    ctx.userId = 'user-id'
    ctx.projectId = 'project-id'
    ctx.targetUserId = 'target-user-id'
    ctx.ipAddress = '10.0.0.1'

    ctx.SessionManager = {
      getLoggedInUserId: sinon.stub().returns(ctx.adminId),
    }

    ctx.UserUpdater = {
      promises: {
        suspendUser: sinon.stub().resolves(),
      },
    }

    ctx.UserGetter = {
      promises: {
        getUser: sinon.stub().resolves(),
        getUserByMainEmail: sinon.stub().resolves(),
      },
    }

    ctx.UserDeleter = {
      promises: {
        deleteUser: sinon.stub().resolves(),
        ensureCanDeleteUser: sinon.stub().resolves(),
      },
    }

    ctx.ProjectGetter = {
      promises: {
        findAllUsersProjects: sinon.stub().resolves({
          owned: [],
          readAndWrite: [],
          readOnly: [],
          tokenReadAndWrite: [],
          tokenReadOnly: [],
        }),
        getProject: sinon.stub().resolves({
          owner_ref: new FakeObjectId(ctx.userId),
        }),
      },
    }

    ctx.ProjectDeleter = {
      promises: {
        undeleteProject: sinon.stub().resolves(),
      },
    }

    ctx.OwnershipTransferHandler = {
      promises: {
        transferOwnership: sinon.stub().resolves(),
      },
    }

    ctx.UserAuditLogHandler = {
      promises: {
        addEntry: sinon.stub().resolves(),
      },
    }

    ctx.ProjectAuditLogHandler = {
      addEntryIfManagedInBackground: sinon.stub(),
    }

    ctx.db = {
      deletedProjects: {
        findOne: sinon.stub().resolves({}),
      },
    }

    vi.doMock('../../../../app/src/infrastructure/mongodb.mjs', () => ({
      db: ctx.db,
      ObjectId: FakeObjectId,
    }))

    vi.doMock(
      '../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({
        default: ctx.SessionManager,
      })
    )

    vi.doMock('../../../../app/src/Features/User/UserUpdater.mjs', () => ({
      default: ctx.UserUpdater,
    }))

    vi.doMock('../../../../app/src/Features/User/UserGetter.mjs', () => ({
      default: ctx.UserGetter,
    }))

    vi.doMock('../../../../app/src/Features/User/UserDeleter.mjs', () => ({
      default: ctx.UserDeleter,
    }))

    vi.doMock('../../../../app/src/Features/Project/ProjectGetter.mjs', () => ({
      default: ctx.ProjectGetter,
    }))

    vi.doMock('../../../../app/src/Features/Project/ProjectDeleter.mjs', () => ({
      default: ctx.ProjectDeleter,
    }))

    vi.doMock(
      '../../../../app/src/Features/Collaborators/OwnershipTransferHandler.mjs',
      () => ({
        default: ctx.OwnershipTransferHandler,
      })
    )

    vi.doMock('../../../../app/src/Features/User/UserAuditLogHandler.mjs', () => ({
      default: ctx.UserAuditLogHandler,
    }))

    vi.doMock(
      '../../../../app/src/Features/Project/ProjectAuditLogHandler.mjs',
      () => ({
        default: ctx.ProjectAuditLogHandler,
      })
    )

    ctx.AdminPanelController = (await import(modulePath)).default
    ctx.res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
    }
    ctx.next = sinon.stub()
  })

  describe('suspendUser', function () {
    it('should reject invalid user id', async function (ctx) {
      ctx.req = {
        params: { userId: 'invalid-user-id' },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.suspendUser(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.UserUpdater.promises.suspendUser
      ).to.not.have.been.called
    })

    it('should block self-suspension', async function (ctx) {
      ctx.req = {
        params: { userId: ctx.adminId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.suspendUser(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.UserUpdater.promises.suspendUser
      ).to.not.have.been.called
    })
  })

  describe('restoreProject', function () {
    it('should reject invalid user id', async function (ctx) {
      ctx.req = {
        params: { userId: 'invalid-user-id', projectId: ctx.projectId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.restoreProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.ProjectDeleter.promises.undeleteProject
      ).to.not.have.been.called
    })

    it('should reject invalid project id', async function (ctx) {
      ctx.req = {
        params: { userId: ctx.userId, projectId: 'invalid-project-id' },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.restoreProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.ProjectDeleter.promises.undeleteProject
      ).to.not.have.been.called
    })

    it('should return not found when deleted project is missing', async function (ctx) {
      ctx.db.deletedProjects.findOne.resolves(null)
      ctx.req = {
        params: { userId: ctx.userId, projectId: ctx.projectId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.restoreProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(404)
      expect(
        ctx.ProjectDeleter.promises.undeleteProject
      ).to.not.have.been.called
    })

    it('should restore project ownership to the target user', async function (ctx) {
      ctx.req = {
        params: { userId: ctx.userId, projectId: ctx.projectId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.restoreProject(ctx.req, ctx.res, ctx.next)

      expect(
        ctx.ProjectDeleter.promises.undeleteProject
      ).to.have.been.calledWith(
        ctx.projectId,
        sinon.match({
          userId: sinon.match.instanceOf(FakeObjectId),
        })
      )
    })
  })

  describe('transferProject', function () {
    it('should reject invalid user id', async function (ctx) {
      ctx.req = {
        params: { userId: 'invalid-user-id', projectId: ctx.projectId },
        body: { targetUserId: ctx.targetUserId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.transferProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.OwnershipTransferHandler.promises.transferOwnership
      ).to.not.have.been.called
    })

    it('should reject invalid project id', async function (ctx) {
      ctx.req = {
        params: { userId: ctx.userId, projectId: 'invalid-project-id' },
        body: { targetUserId: ctx.targetUserId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.transferProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.OwnershipTransferHandler.promises.transferOwnership
      ).to.not.have.been.called
    })

    it('should reject invalid target user id', async function (ctx) {
      ctx.req = {
        params: { userId: ctx.userId, projectId: ctx.projectId },
        body: { targetUserId: 'invalid-target-id' },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.transferProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.OwnershipTransferHandler.promises.transferOwnership
      ).to.not.have.been.called
    })

    it('should return not found when project is missing', async function (ctx) {
      ctx.ProjectGetter.promises.getProject.resolves(null)
      ctx.req = {
        params: { userId: ctx.userId, projectId: ctx.projectId },
        body: { targetUserId: ctx.targetUserId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.transferProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(404)
      expect(
        ctx.OwnershipTransferHandler.promises.transferOwnership
      ).to.not.have.been.called
    })

    it('should reject when project does not belong to user', async function (ctx) {
      ctx.ProjectGetter.promises.getProject.resolves({
        owner_ref: new FakeObjectId('other-user-id'),
      })
      ctx.req = {
        params: { userId: ctx.userId, projectId: ctx.projectId },
        body: { targetUserId: ctx.targetUserId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.transferProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(400)
      expect(
        ctx.OwnershipTransferHandler.promises.transferOwnership
      ).to.not.have.been.called
    })

    it('should return not found when target email does not exist', async function (ctx) {
      ctx.UserGetter.promises.getUserByMainEmail.resolves(null)
      ctx.req = {
        params: { userId: ctx.userId, projectId: ctx.projectId },
        body: { targetUserId: 'missing@example.com' },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.transferProject(ctx.req, ctx.res, ctx.next)

      expect(ctx.res.status).to.have.been.calledWith(404)
      expect(
        ctx.OwnershipTransferHandler.promises.transferOwnership
      ).to.not.have.been.called
    })

    it('should include ipAddress for audit trail', async function (ctx) {
      ctx.req = {
        params: { userId: ctx.userId, projectId: ctx.projectId },
        body: { targetUserId: ctx.targetUserId },
        session: {},
        ip: ctx.ipAddress,
      }

      await ctx.AdminPanelController.transferProject(ctx.req, ctx.res, ctx.next)

      expect(
        ctx.OwnershipTransferHandler.promises.transferOwnership
      ).to.have.been.calledWith(ctx.projectId, ctx.targetUserId, {
        allowTransferToNonCollaborators: true,
        sessionUserId: ctx.adminId,
        ipAddress: ctx.ipAddress,
      })
    })
  })
})
