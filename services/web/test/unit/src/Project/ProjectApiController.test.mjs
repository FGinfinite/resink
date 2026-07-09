import { vi } from 'vitest'
import sinon from 'sinon'

const modulePath = '../../../../app/src/Features/Project/ProjectApiController'

describe('Project api controller', function () {
  beforeEach(async function (ctx) {
    ctx.ProjectDetailsHandler = { getDetails: sinon.stub() }
    ctx.ProjectEntityHandler = { getAllEntitiesFromProject: sinon.stub() }
    ctx.ProjectGetter = {
      promises: {
        getProject: sinon.stub(),
      },
    }

    vi.doMock(
      '../../../../app/src/Features/Project/ProjectDetailsHandler',
      () => ({
        default: ctx.ProjectDetailsHandler,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectEntityHandler',
      () => ({
        default: ctx.ProjectEntityHandler,
      })
    )
    vi.doMock('../../../../app/src/Features/Project/ProjectGetter', () => ({
      default: ctx.ProjectGetter,
    }))

    ctx.controller = (await import(modulePath)).default
    ctx.project_id = '321l3j1kjkjl'
    ctx.req = {
      params: {
        project_id: ctx.project_id,
      },
      session: {
        destroy: sinon.stub(),
      },
    }
    ctx.res = {}
    ctx.next = sinon.stub()
    return (ctx.projDetails = { name: 'something' })
  })

  describe('getProjectDetails', function () {
    it('should ask the project details handler for proj details', async function (ctx) {
      await new Promise(resolve => {
        ctx.ProjectDetailsHandler.getDetails.callsArgWith(
          1,
          null,
          ctx.projDetails
        )
        ctx.res.json = data => {
          ctx.ProjectDetailsHandler.getDetails
            .calledWith(ctx.project_id)
            .should.equal(true)
          data.should.deep.equal(ctx.projDetails)
          return resolve()
        }
        return ctx.controller.getProjectDetails(ctx.req, ctx.res)
      })
    })

    it('should send a 500 if there is an error', function (ctx) {
      ctx.ProjectDetailsHandler.getDetails.callsArgWith(1, 'error')
      ctx.controller.getProjectDetails(ctx.req, ctx.res, ctx.next)
      return ctx.next.calledWith('error').should.equal(true)
    })
  })

  describe('getProjectEntitiesForAi', function () {
    it('should return document and file ids with paths', async function (ctx) {
      const project = { _id: ctx.project_id }
      ctx.req.params = { Project_id: ctx.project_id }
      ctx.ProjectGetter.promises.getProject.resolves(project)
      ctx.ProjectEntityHandler.getAllEntitiesFromProject
        .withArgs(project)
        .returns({
          docs: [
            {
              path: '/main.tex',
              doc: { _id: { toString: () => 'doc-id' }, name: 'main.tex' },
            },
          ],
          files: [
            {
              path: '/figures/plot.pdf',
              file: { _id: { toString: () => 'file-id' }, name: 'plot.pdf' },
            },
          ],
        })

      ctx.res.json = sinon.stub()
      await ctx.controller.getProjectEntitiesForAi(ctx.req, ctx.res)

      ctx.ProjectGetter.promises.getProject
        .calledWith(ctx.project_id)
        .should.equal(true)
      ctx.res.json.calledWith({
        docs: [{ id: 'doc-id', name: 'main.tex', path: '/main.tex' }],
        files: [
          { id: 'file-id', name: 'plot.pdf', path: '/figures/plot.pdf' },
        ],
      }).should.equal(true)
    })
  })
})
