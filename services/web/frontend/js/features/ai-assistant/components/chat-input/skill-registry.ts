/**
 * Shared skill definitions used by slash-command plugin, skill toolbar,
 * command-node matching, and dynamic placeholder.
 */

export interface SkillDefinition {
  name: string
  label: string
  icon: string
  trigger: string
  hint: string
  description?: string
}

export const SKILL_DEFINITIONS: SkillDefinition[] = [
  // ── Edit ──
  {
    name: 'polish',
    label: '润色',
    icon: 'auto_fix_high',
    trigger: '请帮我润色当前选中的内容',
    hint: '请 @选中要润色的内容',
    description: '改善语言表达、学术用语和句式流畅度',
  },
  {
    name: 'condense',
    label: '缩写',
    icon: 'compress',
    trigger: '请帮我精简当前选中的内容',
    hint: '请 @选中要精简的内容',
    description: '压缩篇幅，去除冗余表达',
  },
  {
    name: 'expand',
    label: '扩写',
    icon: 'expand',
    trigger: '请帮我扩写当前选中的内容',
    hint: '请 @选中要扩写的内容',
    description: '补充论据、解释和上下文',
  },
  {
    name: 'humanize',
    label: '去AI味',
    icon: 'psychology_alt',
    trigger: '请帮我改写以降低 AI 痕迹，使文本更接近人类自然表达',
    hint: '请 @选中要去AI味的内容',
    description: '降低 AI 痕迹，使文本更接近人类写作',
  },
  // ── Translate ──
  {
    name: 'zh2en',
    label: '中→英',
    icon: 'translate',
    trigger: '请将选中内容翻译为英文',
    hint: '请 @选中要翻译的内容',
    description: '学术论文中译英，规避中式英语',
  },
  {
    name: 'en2zh',
    label: '英→中',
    icon: 'translate',
    trigger: '请将选中内容翻译为中文',
    hint: '请 @选中要翻译的内容',
    description: '学术论文英译中，避免欧化中文',
  },
  // ── Featured ──
  {
    name: 'review',
    label: '深度审阅',
    icon: 'rate_review',
    trigger: '请对整篇论文进行深度审阅',
    hint: '可 @引用文件，或直接发送以审阅全文',
    description: '对整篇论文进行多维度审阅',
  },
  {
    name: 'outline',
    label: '大纲规划',
    icon: 'account_tree',
    trigger: '请帮我规划论文大纲和结构',
    hint: '可直接发送，AI 将分析全文生成大纲',
    description: '规划论文结构，生成章节骨架',
  },
  {
    name: 'continuation',
    label: '续写',
    icon: 'arrow_forward',
    trigger: '请帮我继续往下写',
    hint: '可 @引用文件，AI 将续写内容',
    description: '从当前位置继续向下写作',
  },
  {
    name: 'rebuttal',
    label: '审稿回复',
    icon: 'reply_all',
    trigger: '请帮我撰写审稿回复，以下是审稿人意见：',
    hint: '请 @引用审稿意见文件',
    description: '根据审稿意见逐条生成回复',
  },
  {
    name: 'logic-check',
    label: '逻辑检查',
    icon: 'fact_check',
    trigger: '请检查论文的逻辑一致性',
    hint: '可 @引用文件，或直接发送以检查全文',
    description: '检测前后矛盾、术语混乱和歧义语病',
  },
  {
    name: 'experiment-analysis',
    label: '实验分析',
    icon: 'analytics',
    trigger: '请分析实验结果并生成分析段落',
    hint: '可 @引用包含实验数据的文件',
    description: '基于表格数据生成 LaTeX 分析段落',
  },
  // ── New Skills ──
  {
    name: 'abstract',
    label: '摘要写作',
    icon: 'summarize',
    trigger: '请帮我撰写或改写论文摘要',
    hint: '可 @引用论文文件，AI 将提取核心贡献生成摘要',
    description: '按 5 句公式生成结构化学术摘要',
  },
  {
    name: 'writing-coach',
    label: '写作指导',
    icon: 'school',
    trigger: '请分析我的写作质量并给出改进建议',
    hint: '可 @引用文件，AI 将基于专业写作原则给出分析报告',
    description: '基于 Gopen-Swan 等原则诊断写作问题',
  },
  {
    name: 'strengthen',
    label: '论证强化',
    icon: 'fitness_center',
    trigger: '请帮我强化论文中的薄弱论点',
    hint: '可 @引用文件，AI 将识别并强化薄弱声明',
    description: '识别薄弱声明，强化论证逻辑和说服力',
  },
  {
    name: 'related-work',
    label: '相关工作',
    icon: 'hub',
    trigger: '请帮我撰写或改进 Related Work 部分',
    hint: '可 @引用论文文件和 .bib 文件',
    description: '组织引文结构，撰写定位清晰的相关工作',
  },
  {
    name: 'figure-caption',
    label: '图表标题',
    icon: 'image',
    trigger: '请帮我撰写或改进图表的 caption',
    hint: '可 @引用包含图表的文件',
    description: '写自足性强的图表标题（What-How-Finding）',
  },
  {
    name: 'consistency-check',
    label: '一致性检查',
    icon: 'rule',
    trigger: '请检查论文的格式一致性（记号、时态、排版风格）',
    hint: '可 @引用文件，或直接发送以检查全文',
    description: '检测记号、时态、排版风格的不一致',
  },
  {
    name: 'pre-submit',
    label: '投稿检查',
    icon: 'checklist',
    trigger: '请对论文进行投稿前质量检查',
    hint: '可 @引用文件，或直接发送以检查全文',
    description: '投稿前质量检查（会议清单、匿名化、格式）',
  },
]

export const SKILL_NAME_SET: Set<string> = new Set(
  SKILL_DEFINITIONS.map(s => s.name)
)

export function getSkillByName(name: string): SkillDefinition | undefined {
  return SKILL_DEFINITIONS.find(s => s.name === name)
}

export function getSkillHint(name: string): string {
  return getSkillByName(name)?.hint ?? ''
}
