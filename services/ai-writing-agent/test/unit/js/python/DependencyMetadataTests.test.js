import { describe, expect, it } from 'vitest'

const {
  parsePep723ScriptMetadata,
  parsePyprojectToml,
  parseSkillJson,
} = await import('../../../../app/js/python/DependencyMetadata.js')

describe('DependencyMetadata', () => {
  it('parses skill.json python runtime metadata without installing packages', () => {
    const parsed = parseSkillJson(JSON.stringify({
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
      scripts: [
        { name: 'analyze', path: 'scripts/analyze.py', runtime: 'python' },
      ],
    }))

    expect(parsed.python).toMatchObject({
      environment: 'skill',
      pythonVersion: '3.12',
      lockfile: 'uv.lock',
    })
    expect(parsed.packages).toEqual([
      expect.objectContaining({
        name: 'pandas',
        specifier: '==2.2.3',
        sourceHint: 'index',
      }),
    ])
  })

  it('detects denied dependency source shapes in pyproject metadata', () => {
    const parsed = parsePyprojectToml(`
[project]
requires-python = ">=3.12,<3.13"
dependencies = [
  "safe-package==1.0.0",
  "evil @ https://example.com/evil.whl",
  "repo @ git+https://example.com/repo.git",
]

[tool.uv]
index-strategy = "unsafe-best-match"
`)

    expect(parsed.requestedPythonVersion).toBe('>=3.12,<3.13')
    expect(parsed.packages.map(pkg => pkg.name)).toContain('safe-package')
    expect(parsed.findings.map(finding => finding.code)).toEqual([
      'DIRECT_URL_DEPENDENCY',
      'VCS_DEPENDENCY',
      'UNSAFE_UV_INDEX_STRATEGY',
    ])
  })

  it('parses PEP 723 inline dependencies and reports malformed blocks', () => {
    const parsed = parsePep723ScriptMetadata(`# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "pypdf==5.0.0",
# ]
# ///
print("ok")
`)

    expect(parsed.found).toBe(true)
    expect(parsed.requestedPythonVersion).toBe('>=3.12,<3.13')
    expect(parsed.packages).toEqual([
      expect.objectContaining({ name: 'pypdf', specifier: '==5.0.0' }),
    ])

    const malformed = parsePep723ScriptMetadata('# /// script\n# dependencies = ["pandas"]\n')
    expect(malformed.malformed).toBe(true)
    expect(malformed.findings[0].code).toBe('PEP723_UNCLOSED_BLOCK')
  })
})
