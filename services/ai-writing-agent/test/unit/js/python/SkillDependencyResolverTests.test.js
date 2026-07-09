import { describe, expect, it, vi } from 'vitest'

const { SkillDependencyResolver } = await import(
  '../../../../app/js/python/SkillDependencyResolver.js'
)

describe('SkillDependencyResolver', () => {
  it('builds a normalized skill dependency request from skill package metadata', async () => {
    const skillRegistry = {
      get: vi.fn().mockReturnValue({
        name: 'table-analysis',
        scripts: [{ name: 'analyze.py' }],
      }),
      readPackageFile: vi.fn(async (_skill, file) => {
        if (file === 'skill.json') {
          return {
            content: JSON.stringify({
              runtime: {
                python: {
                  environment: 'skill',
                  pythonVersion: '3.12',
                  lockfile: 'uv.lock',
                  projectFile: 'pyproject.toml',
                  network: 'none',
                  dependencies: ['pandas==2.2.3'],
                },
              },
            }),
          }
        }
        if (file === 'uv.lock') return { content: 'version = 1\n' }
        return undefined
      }),
      readScript: vi.fn(async () => ({
        relativePath: 'scripts/analyze.py',
        content: `# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "pypdf==5.0.0",
# ]
# ///
print("ok")
`,
      })),
    }
    const resolver = new SkillDependencyResolver({ skillRegistry })

    const result = await resolver.resolve('table-analysis')

    expect(result.required).toBe(true)
    expect(result.status).toBe('missing')
    expect(result.packages.map(pkg => pkg.raw)).toEqual([
      'pandas==2.2.3',
      'pypdf==5.0.0',
    ])
    expect(result.sourceFiles.map(file => file.kind)).toEqual([
      'skill-json',
      'uv-lock',
      'pep723',
    ])
    expect(result.dependencyRequest.fingerprint).toMatch(/^sha256:/)
  })

  it('returns no dependency requirement when no metadata exists', async () => {
    const resolver = new SkillDependencyResolver({
      skillRegistry: {
        get: vi.fn().mockReturnValue({ name: 'plain', scripts: [] }),
        readPackageFile: vi.fn().mockResolvedValue(undefined),
      },
    })

    const result = await resolver.resolve('plain')

    expect(result).toEqual({
      required: false,
      skillName: 'plain',
      status: 'none',
      packages: [],
      policyFindings: [],
      sourceFiles: [],
    })
  })
})
