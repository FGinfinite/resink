import {
  AgentTaskResultError,
  normalizeAgentTaskResult,
} from './AgentTaskResult.js'

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'question']
const ISSUE_HEADINGS = {
  critical: 'Critical Issues',
  major: 'Major Issues',
  minor: 'Minor Issues',
  question: 'Questions for Authors',
}

export class AgentResultReducer {
  reduce(input = {}) {
    const reviewerResults = Array.isArray(input.reviewerResults)
      ? input.reviewerResults
      : []
    const unresolvedQuestions = []
    const findingsByKey = new Map()

    for (const reviewer of reviewerResults) {
      let normalized
      try {
        normalized = normalizeAgentTaskResult({
          status: 'completed',
          ...(reviewer.result || {}),
        })
      } catch (error) {
        if (error instanceof AgentTaskResultError) {
          unresolvedQuestions.push(
            `Reviewer result from ${reviewer.taskId || reviewer.agentName || 'unknown'} was ignored: ${error.message}`
          )
          continue
        }
        throw error
      }

      for (const finding of normalized.findings) {
        const key = findingKey(finding)
        const existing = findingsByKey.get(key)
        if (!existing) {
          findingsByKey.set(key, {
            ...finding,
            sourceTaskIds: compactStrings([
              finding.sourceTaskId,
              reviewer.taskId,
            ]),
            sourceAgents: compactStrings([reviewer.agentName]),
            duplicateOf: null,
          })
          continue
        }
        existing.evidenceRefs = mergeEvidenceRefs(
          existing.evidenceRefs,
          finding.evidenceRefs
        )
        existing.sourceTaskIds = uniqueStrings([
          ...existing.sourceTaskIds,
          finding.sourceTaskId,
          reviewer.taskId,
        ])
        existing.sourceAgents = uniqueStrings([
          ...existing.sourceAgents,
          reviewer.agentName,
        ])
        existing.confidence = Math.max(
          Number(existing.confidence || 0),
          Number(finding.confidence || 0)
        )
      }
    }

    const findings = [...findingsByKey.values()].sort(compareFindings)
    return {
      status: 'completed',
      summary: `${findings.length} unique findings reduced from ${reviewerResults.length} reviewer results.`,
      findings,
      proposedEdits: [],
      artifacts: [],
      evidenceRefs: findings.flatMap(finding => finding.evidenceRefs),
      unresolvedQuestions,
      confidence: findings.length ? averageConfidence(findings) : null,
      nextActions: findings
        .filter(finding => ['critical', 'major'].includes(finding.severity))
        .map(finding => ({
          title: finding.suggestedFix || finding.title,
          priority: finding.severity === 'critical' ? 'critical' : 'high',
          findingTitle: finding.title,
        })),
    }
  }

  criticReview(input = {}) {
    const normalized = normalizeAgentTaskResult({
      status: 'completed',
      ...input,
    })
    const criticNotes = []
    const findings = normalized.findings.map(finding => {
      if (
        ['critical', 'major'].includes(finding.severity) &&
        hasWeakEvidence(finding)
      ) {
        criticNotes.push(
          `Finding "${finding.title}" downgraded because evidence is too weak for ${finding.severity} severity.`
        )
        return { ...finding, severity: 'minor' }
      }
      return finding
    })
    return {
      ...normalized,
      findings,
      criticNotes,
      summary: criticNotes.length
        ? `${normalized.summary} Critic adjusted ${criticNotes.length} finding(s).`
        : normalized.summary,
    }
  }

  renderFinalReport(input = {}) {
    const findings = Array.isArray(input.findings) ? input.findings : []
    const lines = [
      '# Deep Review Report',
      '',
      input.summary || 'Deep Review completed.',
      '',
      '## Review Findings',
    ]
    for (const severity of SEVERITY_ORDER) {
      const items = findings.filter(finding => finding.severity === severity)
      lines.push('', `## ${ISSUE_HEADINGS[severity]}`)
      if (items.length === 0) {
        lines.push('None identified.')
        continue
      }
      items.forEach((finding, index) => {
        lines.push(
          `${index + 1}. **${finding.title}** (${finding.category || 'other'})`
        )
        lines.push(`   ${finding.description}`)
        if (finding.evidenceRefs?.length) {
          const evidence = finding.evidenceRefs
            .map(ref => [ref.path, ref.locator].filter(Boolean).join(':'))
            .join('; ')
          lines.push(`   Evidence: ${evidence}`)
        }
        if (finding.suggestedFix) {
          lines.push(`   Suggested fix: ${finding.suggestedFix}`)
        }
      })
    }
    if (Array.isArray(input.criticNotes) && input.criticNotes.length > 0) {
      lines.push('', '## Critic Validation')
      input.criticNotes.forEach(note => lines.push(`- ${note}`))
    }
    return lines.join('\n')
  }
}

function findingKey(finding) {
  return `${finding.category}:${finding.title}`.toLowerCase()
}

function mergeEvidenceRefs(left = [], right = []) {
  const seen = new Set()
  const merged = []
  for (const ref of [...left, ...right]) {
    const key = `${ref.path}:${ref.locator || ''}:${ref.quote || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(ref)
  }
  return merged
}

function compareFindings(left, right) {
  const leftSeverity = SEVERITY_ORDER.indexOf(left.severity)
  const rightSeverity = SEVERITY_ORDER.indexOf(right.severity)
  if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity
  return left.title.localeCompare(right.title)
}

function hasWeakEvidence(finding) {
  return (
    !Array.isArray(finding.evidenceRefs) ||
    finding.evidenceRefs.length === 0 ||
    finding.evidenceRefs.every(ref => !ref.locator && !ref.quote)
  )
}

function averageConfidence(findings) {
  const values = findings
    .map(finding => finding.confidence)
    .filter(value => typeof value === 'number')
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function compactStrings(values) {
  return uniqueStrings(values.filter(value => typeof value === 'string' && value))
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value))]
}

export default AgentResultReducer
