import { describe, expect, it } from 'vitest'

const { DependencyPolicyEngine, normalizePolicyConfig } = await import(
  '../../../../app/js/python/DependencyPolicyEngine.js'
)

describe('DependencyPolicyEngine', () => {
  it('approves empty requests and records policy version', () => {
    const engine = new DependencyPolicyEngine({
      config: { policyVersion: 'test-policy' },
    })

    const decision = engine.evaluateRequest({
      requestedPackages: [],
      policyFindings: [],
      requestedNetworkPolicy: 'none',
    })

    expect(decision).toMatchObject({
      status: 'approved',
      riskTier: 'low',
      policyVersion: 'test-policy',
      findings: [],
    })
  })

  it('denies direct URL and VCS sources while preserving findings', () => {
    const engine = new DependencyPolicyEngine()

    const decision = engine.evaluateRequest({
      requestedPackages: [
        {
          name: 'unsafe',
          sourceHint: 'direct-url',
          raw: 'unsafe @ https://example.com/unsafe.whl',
        },
        {
          name: 'gitdep',
          sourceHint: 'vcs',
          raw: 'gitdep @ git+https://example.com/repo.git',
        },
      ],
      policyFindings: [{
        code: 'DIRECT_URL_DEPENDENCY',
        severity: 'high',
        message: 'Direct URL dependencies require broker policy review.',
        packageName: 'unsafe',
      }],
    })

    expect(decision.status).toBe('denied')
    expect(decision.riskTier).toBe('high')
    expect(decision.findings.map(finding => finding.code)).toEqual([
      'DIRECT_URL_DEPENDENCY',
      'DENIED_DEPENDENCY_SOURCE',
      'UNAPPROVED_DEPENDENCY_SOURCE',
      'DENIED_DEPENDENCY_SOURCE',
      'UNAPPROVED_DEPENDENCY_SOURCE',
    ])
  })

  it('marks runtime network requests and package count overages for review', () => {
    const engine = new DependencyPolicyEngine({
      config: { maxPackageCount: 1 },
    })

    const decision = engine.evaluateRequest({
      requestedPackages: [
        { name: 'pandas', sourceHint: 'index', raw: 'pandas==2.2.3' },
        { name: 'numpy', sourceHint: 'index', raw: 'numpy==2.0.0' },
      ],
      requestedNetworkPolicy: 'limited',
    })

    expect(decision.status).toBe('denied')
    expect(decision.findings.map(finding => finding.code)).toContain(
      'PACKAGE_COUNT_LIMIT_EXCEEDED'
    )
    expect(decision.findings.map(finding => finding.code)).toContain(
      'RUNTIME_NETWORK_REQUIRES_APPROVAL'
    )
  })

  it('normalizes config defaults as immutable sets for policy checks', () => {
    const config = normalizePolicyConfig({
      allowedSourceKinds: ['index', 'local-path'],
      deniedSourceKinds: ['vcs'],
    })

    expect(config.allowedSourceKinds.has('local-path')).toBe(true)
    expect(config.deniedSourceKinds.has('vcs')).toBe(true)
    expect(config.deniedRuntimeCommands).toContain('uv pip')
  })
})
