import { describe, expect, it, vi } from 'vitest'

vi.mock('@overleaf/logger', () => ({
  default: {
    warn: vi.fn(),
  },
}))

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(async p => p),
}))

const { readdir, readFile } = await import('node:fs/promises')
const {
  ProfileRegistry,
  buildProfilePrompt,
} = await import('../../../../app/js/runtime/ProfileRegistry.js')

describe('ProfileRegistry', () => {
  it('loads runtime profiles with list metadata', async () => {
    readdir.mockResolvedValue(['compile-fixer.md'])
    readFile.mockResolvedValue(`---
name: compile-fixer
description: Compile fixes
artifactGlobs: *.log, *.pdf
commandHints: latexmk -pdf main.tex, pdftotext main.pdf -
outputFormat: Summary
---
Compile instructions`)
    const registry = new ProfileRegistry('/profiles')

    await registry.loadAll()

    expect(registry.get('compile-fixer')).toMatchObject({
      name: 'compile-fixer',
      artifactGlobs: ['*.log', '*.pdf'],
      commandHints: ['latexmk -pdf main.tex', 'pdftotext main.pdf -'],
      outputFormat: 'Summary',
      instructions: 'Compile instructions',
    })
  })

  it('builds a runtime prompt with profile instructions and user prompt', () => {
    const prompt = buildProfilePrompt(
      {
        name: 'paper-reviewer',
        instructions: 'Review carefully.',
        commandHints: ['latexmk -pdf main.tex'],
        artifactGlobs: ['*.pdf'],
        outputFormat: 'Findings',
      },
      'Check the paper.'
    )

    expect(prompt).toContain('Runtime profile: paper-reviewer')
    expect(prompt).toContain('Review carefully.')
    expect(prompt).toContain('- latexmk -pdf main.tex')
    expect(prompt).toContain('- *.pdf')
    expect(prompt).toContain('User request:\nCheck the paper.')
  })
})
