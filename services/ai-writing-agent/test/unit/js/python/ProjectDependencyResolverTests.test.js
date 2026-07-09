import { describe, expect, it } from 'vitest'

const { ProjectDependencyResolver } = await import(
  '../../../../app/js/python/ProjectDependencyResolver.js'
)

describe('ProjectDependencyResolver', () => {
  it('discovers locked project Python metadata without installing dependencies', async () => {
    const resolver = new ProjectDependencyResolver()

    const result = await resolver.resolveFromFiles([
      {
        path: 'pyproject.toml',
        content: `
[project]
requires-python = ">=3.12,<3.13"
dependencies = ["pandas==2.2.3"]
`,
      },
      { path: 'uv.lock', content: 'version = 1\n' },
    ])

    expect(result.required).toBe(true)
    expect(result.status).toBe('locked')
    expect(result.packages).toEqual([
      expect.objectContaining({ name: 'pandas', specifier: '==2.2.3' }),
    ])
    expect(result.sourceFiles.map(file => file.path)).toEqual([
      'pyproject.toml',
      'uv.lock',
    ])
  })

  it('reports PEP 723 script dependencies and skips path escapes', async () => {
    const resolver = new ProjectDependencyResolver()

    const result = await resolver.resolveFromFiles([
      { path: '../escape.py', content: 'dependencies = ["evil"]' },
      {
        path: 'scripts/analyze.py',
        content: `# /// script
# dependencies = [
#   "evil @ https://example.com/evil.whl",
# ]
# ///
`,
      },
    ])

    expect(result.status).toBe('missing-lock')
    expect(result.packages).toEqual([
      expect.objectContaining({ name: 'evil', sourceHint: 'direct-url' }),
    ])
    expect(result.policyFindings[0]).toMatchObject({
      code: 'DIRECT_URL_DEPENDENCY',
      scriptPath: 'scripts/analyze.py',
    })
  })
})
