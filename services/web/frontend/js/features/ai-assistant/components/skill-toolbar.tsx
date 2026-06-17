/**
 * Skill Quick-Start Toolbar
 * Shown in the empty state of the AI Assistant panel.
 * Each button inserts a /command into the editor so the user can add context
 * before sending.
 */

import { memo } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import { SKILL_DEFINITIONS, type SkillDefinition } from './chat-input/skill-registry'

interface SkillToolbarProps {
  onSkillSelect: (skillName: string) => void
  disabled: boolean
}

// ── Pill groups (compact, self-explanatory, high-frequency) ──

const EDIT_NAMES = new Set(['polish', 'condense', 'expand', 'humanize'])
const TRANSLATE_NAMES = new Set(['zh2en', 'en2zh'])
const WRITE_NAMES = new Set(['abstract', 'outline', 'continuation', 'related-work', 'figure-caption'])
const CHECK_NAMES = new Set(['review', 'logic-check', 'consistency-check', 'experiment-analysis', 'pre-submit'])

const SKILL_GROUPS: { label: string; skills: SkillDefinition[] }[] = [
  {
    label: '编辑',
    skills: SKILL_DEFINITIONS.filter(s => EDIT_NAMES.has(s.name)),
  },
  {
    label: '翻译',
    skills: SKILL_DEFINITIONS.filter(s => TRANSLATE_NAMES.has(s.name)),
  },
  {
    label: '撰写',
    skills: SKILL_DEFINITIONS.filter(s => WRITE_NAMES.has(s.name)),
  },
  {
    label: '审查',
    skills: SKILL_DEFINITIONS.filter(s => CHECK_NAMES.has(s.name)),
  },
]

// ── Featured cards (with description, for complex / less obvious skills) ──

const FEATURED_NAMES = new Set(['writing-coach', 'strengthen', 'rebuttal'])
const FEATURED_SKILLS = SKILL_DEFINITIONS.filter(s => FEATURED_NAMES.has(s.name))

function SkillToolbar({ onSkillSelect, disabled }: SkillToolbarProps) {
  return (
    <div className="ai-skill-toolbar">
      <div className="ai-skill-groups">
        {SKILL_GROUPS.map((group) => (
          <div key={group.label} className="ai-skill-group">
            <span className="ai-skill-group-label">{group.label}</span>
            <div className="ai-skill-pills">
              {group.skills.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  className="ai-skill-pill"
                  disabled={disabled}
                  onClick={() => onSkillSelect(skill.name)}
                  data-tooltip={skill.description || undefined}
                >
                  <MaterialIcon type={skill.icon} />
                  <span>{skill.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="ai-skill-featured-list">
        {FEATURED_SKILLS.map((skill) => (
          <button
            key={skill.name}
            type="button"
            className="ai-skill-featured"
            disabled={disabled}
            onClick={() => onSkillSelect(skill.name)}
          >
            <MaterialIcon type={skill.icon} />
            <div className="ai-skill-featured-text">
              <span className="ai-skill-featured-label">{skill.label}</span>
              {skill.description && (
                <span className="ai-skill-featured-desc">{skill.description}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default memo(SkillToolbar)
