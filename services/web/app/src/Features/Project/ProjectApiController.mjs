/* eslint-disable
    max-len,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import ProjectDetailsHandler from './ProjectDetailsHandler.mjs'
import ProjectEntityHandler from './ProjectEntityHandler.mjs'
import ProjectGetter from './ProjectGetter.mjs'

import logger from '@overleaf/logger'

export default {
  getProjectDetails(req, res, next) {
    const { project_id: projectId } = req.params
    return ProjectDetailsHandler.getDetails(
      projectId,
      function (err, projDetails) {
        if (err != null) {
          return next(err)
        }
        return res.json(projDetails)
      }
    )
  },

  async getProjectEntitiesForAi(req, res) {
    const { Project_id: projectId } = req.params
    const project = await ProjectGetter.promises.getProject(projectId)
    const { docs, files } =
      ProjectEntityHandler.getAllEntitiesFromProject(project)

    res.json({
      docs: docs.map(({ path, doc }) => ({
        id: doc._id.toString(),
        name: doc.name,
        path,
      })),
      files: files.map(({ path, file }) => ({
        id: file._id.toString(),
        name: file.name,
        path,
      })),
    })
  },
}
