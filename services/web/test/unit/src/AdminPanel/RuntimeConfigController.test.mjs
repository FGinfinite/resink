import { beforeEach, describe, expect, it, vi } from 'vitest'
import sinon from 'sinon'

const modulePath =
  '../../../../modules/admin-panel/app/src/RuntimeConfigController.mjs'

describe('RuntimeConfigController', function () {
  beforeEach(async function (ctx) {
    vi.resetModules()

    ctx.updatedBy = 'admin-user-id'
    ctx.services = ['web', 'ai-writing-agent', 'clsi']
    ctx.manager = {
      listResolvedEntries: sinon.stub().resolves([{ key: 'site.isOpen' }]),
      getRevisions: sinon.stub().resolves([{ version: 1 }]),
      setRuntimeValue: sinon.stub().resolves({ key: 'site.isOpen' }),
      resetRuntimeValue: sinon.stub().resolves(),
      rollbackRuntimeValue: sinon.stub().resolves({ key: 'site.isOpen' }),
    }

    ctx.SessionManager = {
      getLoggedInUserId: sinon.stub().returns(ctx.updatedBy),
    }

    ctx.listRuntimeConfigServices = sinon.stub().returns(ctx.services)
    ctx.getRuntimeConfigManager = sinon.stub().returns(ctx.manager)

    vi.doMock(
      '../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({
        default: ctx.SessionManager,
      })
    )

    vi.doMock('../../../../app/src/infrastructure/RuntimeConfigManager.mjs', () => ({
      getRuntimeConfigManager: ctx.getRuntimeConfigManager,
      listRuntimeConfigServices: ctx.listRuntimeConfigServices,
    }))

    ctx.RuntimeConfigController = (await import(modulePath)).default
    ctx.res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      sendStatus: sinon.stub(),
      render: sinon.stub(),
    }
    ctx.next = sinon.stub()
  })

  it('should list runtime config services', async function (ctx) {
    await ctx.RuntimeConfigController.listServices({}, ctx.res, ctx.next)

    expect(ctx.res.json).to.have.been.calledWith({ services: ctx.services })
  })

  it('should reject unknown services before reading entries', async function (ctx) {
    const req = {
      params: {
        service: 'unknown-service',
      },
    }

    await ctx.RuntimeConfigController.listEntries(req, ctx.res, ctx.next)

    expect(ctx.res.status).to.have.been.calledWith(404)
    expect(ctx.res.json).to.have.been.calledWith({
      error: 'unknown config service',
    })
    expect(ctx.manager.listResolvedEntries).to.not.have.been.called
  })

  it('should pass session user and payload to updateEntry', async function (ctx) {
    const req = {
      params: {
        service: 'web',
        key: 'site.isOpen',
      },
      body: {
        value: false,
        comment: 'close site',
      },
      session: {},
    }

    await ctx.RuntimeConfigController.updateEntry(req, ctx.res, ctx.next)

    expect(ctx.manager.setRuntimeValue).to.have.been.calledWith({
      key: 'site.isOpen',
      value: false,
      comment: 'close site',
      updatedBy: ctx.updatedBy,
    })
    expect(ctx.res.json).to.have.been.calledWith({
      entry: { key: 'site.isOpen' },
    })
  })

  it('should reject rollback requests without a numeric version', async function (ctx) {
    const req = {
      params: {
        service: 'web',
        key: 'site.isOpen',
      },
      body: {
        version: 'invalid-version',
      },
      session: {},
    }

    await ctx.RuntimeConfigController.rollbackEntry(req, ctx.res, ctx.next)

    expect(ctx.res.status).to.have.been.calledWith(400)
    expect(ctx.res.json).to.have.been.calledWith({
      error: 'version is required',
    })
    expect(ctx.manager.rollbackRuntimeValue).to.not.have.been.called
  })
})
