#!/usr/bin/env node

/**
 * AI Writing Agent — Model Stress Test
 *
 * 模型无关的复杂场景压力测试，用于验证 LLM 在生产工作流下的表现。
 * 适用于模型切换评估、回归测试等场景。
 *
 * 配置来源（优先级从高到低）：
 *   1. CLI 参数:  --api-base=... --api-key=... --model=... --temperature=... --max-tokens=... --delay=...
 *   2. 环境变量:  OPENAI_API_BASE, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_TEMPERATURE, OPENAI_MAX_TOKENS
 *   3. .env 文件: 自动从 services/ai-writing-agent/.env 读取
 *
 * 用法示例：
 *   # 使用 .env 中的默认配置
 *   node test/manual/model-stress-test.mjs
 *
 *   # 指定模型和温度
 *   node test/manual/model-stress-test.mjs --model=gpt-4o --temperature=0.3
 *
 *   # 完整自定义
 *   node test/manual/model-stress-test.mjs \
 *     --api-base=https://api.openai.com/v1 \
 *     --api-key=sk-xxx \
 *     --model=gpt-4o \
 *     --temperature=0.5 \
 *     --max-tokens=4096 \
 *     --delay=3000
 *
 * 测试类别：
 *   E: Complex editing scenarios (nested LaTeX, multi-file, math)
 *   F: Error recovery (tool errors → model retry/adapt)
 *   G: Ambiguous requests (tool vs text decision-making)
 *   H: Long conversations & doom loop resistance
 *   I: Temperature stability (repeated runs consistency)
 */

import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const serviceRoot = join(__dirname, '..', '..')

// ========== Configuration resolution ==========

// Parse CLI args: --key=value
function parseCliArgs() {
  const args = {}
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([a-z-]+)=(.+)$/i)
    if (match) args[match[1]] = match[2]
  }
  return args
}

// Load .env file (simple key=value parser, ignores comments and empty lines)
function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {}
  const vars = {}
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
  }
  return vars
}

const cli = parseCliArgs()
const dotenv = loadDotEnv(join(serviceRoot, '.env'))

function resolve(cliKey, envKey, dotenvKey, fallback) {
  return cli[cliKey] || process.env[envKey] || dotenv[dotenvKey || envKey] || fallback
}

const API_BASE = resolve('api-base', 'OPENAI_API_BASE', null, 'https://api.openai.com/v1')
const API_KEY = resolve('api-key', 'OPENAI_API_KEY', null, '')
const MODEL = resolve('model', 'OPENAI_MODEL', null, 'gpt-4o')
const MAX_TOKENS = Number(resolve('max-tokens', 'OPENAI_MAX_TOKENS', null, '64000'))
const TEMPERATURE = Number(resolve('temperature', 'OPENAI_TEMPERATURE', null, '0.5'))
const CALL_DELAY = Number(cli['delay'] || '5000')  // ms between API calls (rate-limit protection)

// Load production system prompt (post-migration templates)
const templates = ['base', 'academic', 'tools', 'safety']
const systemPrompt = templates
  .map(t => readFileSync(join(serviceRoot, 'app/js/prompt/templates', `${t}.txt`), 'utf-8'))
  .join('\n\n---\n\n')

// Production tool definitions (matching ToolRegistry)
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: `List all files in the project.\nReturns file paths and types (doc or file).\nUse pattern to filter files (supports * and ? wildcards).\nUse type to show only documents or binary files.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to filter files' },
          type: { type: 'string', enum: ['all', 'docs', 'files'], description: 'File type filter' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: `Read the content of a document in the project.\nReturns the document text with line numbers.\nYou MUST read a document before editing it.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (e.g., "main.tex")' },
          maxLines: { type: 'number', description: 'Max lines to return' },
          section: { type: 'string', description: 'Extract a specific LaTeX section' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_document',
      description: `Edit a document by replacing specific text.\nRequires reading the document first.\nChanges become pending — user must confirm.\nThe edit will FAIL if oldText is not found or matches multiple locations.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          oldText: { type: 'string', description: 'Exact text to replace (must match document content precisely)' },
          newText: { type: 'string', description: 'Replacement text (must differ from oldText)' },
          replaceAll: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
        },
        required: ['oldText', 'newText'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: `Delete a file from the project.\nThe deletion is NOT immediate — the user must confirm.\nNEVER delete files unless the user explicitly asks.\nNEVER delete the main document unless explicitly instructed.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path of the file to delete (e.g., "old-draft.tex")' },
        },
        required: ['path'],
      },
    },
  },
]

// ========== Test fixtures ==========

const COMPLEX_DOC = `Line 1: \\documentclass[12pt,a4paper]{article}
Line 2: \\usepackage[UTF8]{ctex}
Line 3: \\usepackage{amsmath,amssymb,amsthm}
Line 4: \\usepackage{graphicx}
Line 5: \\usepackage{hyperref}
Line 6: \\usepackage{booktabs}
Line 7: \\usepackage[style=ieee]{biblatex}
Line 8: \\addbibresource{refs.bib}
Line 9:
Line 10: \\newtheorem{theorem}{Theorem}
Line 11: \\newtheorem{lemma}[theorem]{Lemma}
Line 12: \\newtheorem{definition}{Definition}
Line 13:
Line 14: \\title{Deep Learning for Medical Image Analysis: A Comprehensive Survey}
Line 15: \\author{Zhang Wei\\textsuperscript{1}, Li Ming\\textsuperscript{2} \\\\
Line 16:   \\textsuperscript{1}Tsinghua University \\\\
Line 17:   \\textsuperscript{2}Peking University}
Line 18: \\date{2024}
Line 19:
Line 20: \\begin{document}
Line 21: \\maketitle
Line 22:
Line 23: \\begin{abstract}
Line 24: This paper presents a comprehensive survey of deep learning techniques applied to medical image analysis. We review convolutional neural networks (CNNs), transformers, and generative models in the context of diagnosis, segmentation, and detection tasks. Our analysis covers 150 papers published between 2020 and 2024.
Line 25: \\end{abstract}
Line 26:
Line 27: \\section{Introduction}
Line 28: \\label{sec:intro}
Line 29: Medical image analysis has undergone a revolutionary transformation with the advent of deep learning. Traditional methods relied heavily on hand-crafted features and domain-specific knowledge \\cite{litjens2017survey}. In contrast, modern approaches leverage end-to-end learning to automatically extract discriminative representations.
Line 30:
Line 31: The key contributions of this survey are:
Line 32: \\begin{enumerate}
Line 33:   \\item A systematic taxonomy of deep learning architectures for medical imaging
Line 34:   \\item A critical comparison of state-of-the-art methods across five benchmark datasets
Line 35:   \\item Identification of open challenges and future research directions
Line 36: \\end{enumerate}
Line 37:
Line 38: \\section{Mathematical Framework}
Line 39: \\label{sec:math}
Line 40:
Line 41: \\begin{definition}
Line 42: A convolutional neural network $f: \\mathbb{R}^{H \\times W \\times C} \\to \\mathbb{R}^K$ maps an input image to a $K$-dimensional output space.
Line 43: \\end{definition}
Line 44:
Line 45: \\begin{theorem}
Line 46: For a sufficiently deep network with ReLU activations, the function $f$ can approximate any continuous function $g$ on a compact set $\\Omega$ with arbitrary precision:
Line 47: \\begin{equation}
Line 48:   \\|f(x) - g(x)\\| < \\epsilon, \\quad \\forall x \\in \\Omega, \\quad \\forall \\epsilon > 0
Line 49: \\end{equation}
Line 50: \\end{theorem}
Line 51:
Line 52: The loss function for multi-class classification is defined as:
Line 53: \\begin{equation}
Line 54:   \\mathcal{L}(\\theta) = -\\frac{1}{N} \\sum_{i=1}^{N} \\sum_{k=1}^{K} y_{ik} \\log \\hat{y}_{ik}(\\theta)
Line 55: \\end{equation}
Line 56: where $\\theta$ represents the network parameters, $y_{ik}$ is the ground truth label, and $\\hat{y}_{ik}$ is the predicted probability.
Line 57:
Line 58: \\section{Methods}
Line 59: \\label{sec:methods}
Line 60:
Line 61: \\subsection{CNN-based Approaches}
Line 62: We categorize CNN architectures into three families:
Line 63:
Line 64: \\begin{table}[h]
Line 65: \\centering
Line 66: \\caption{Comparison of CNN architectures}
Line 67: \\label{tab:cnn}
Line 68: \\begin{tabular}{llcc}
Line 69: \\toprule
Line 70: Architecture & Backbone & Parameters (M) & Top-1 Acc (\\%) \\\\
Line 71: \\midrule
Line 72: ResNet-50 & ResNet & 25.6 & 93.2 \\\\
Line 73: DenseNet-121 & DenseNet & 8.0 & 91.8 \\\\
Line 74: EfficientNet-B4 & EfficientNet & 19.3 & 94.5 \\\\
Line 75: \\bottomrule
Line 76: \\end{tabular}
Line 77: \\end{table}
Line 78:
Line 79: \\subsection{Transformer-based Approaches}
Line 80: Vision Transformers (ViT) have shown remarkable performance in medical imaging \\cite{dosovitskiy2020image}. The self-attention mechanism captures long-range dependencies:
Line 81: \\begin{equation}
Line 82:   \\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right) V
Line 83: \\end{equation}
Line 84:
Line 85: \\section{Results}
Line 86: \\label{sec:results}
Line 87: Our experiments demonstrate that transformer-based methods outperform CNN-based approaches on 3 out of 5 benchmarks. However, CNNs remain competitive for small-scale datasets.
Line 88:
Line 89: \\section{Conclusion}
Line 90: \\label{sec:conclusion}
Line 91: In this survey, we reviewed deep learning techniques for medical image analysis. Key findings include: (1) hybrid architectures combining CNNs and transformers achieve the best performance, (2) data augmentation is critical for medical imaging due to limited labeled data, (3) interpretability remains an open challenge.
Line 92:
Line 93: \\printbibliography
Line 94: \\end{document}`

const REFS_BIB = `Line 1: @article{litjens2017survey,
Line 2:   title={A survey on deep learning in medical image analysis},
Line 3:   author={Litjens, Geert and others},
Line 4:   journal={Medical Image Analysis},
Line 5:   volume={42},
Line 6:   pages={60--88},
Line 7:   year={2017}
Line 8: }
Line 9:
Line 10: @article{dosovitskiy2020image,
Line 11:   title={An image is worth 16x16 words: Transformers for image recognition at scale},
Line 12:   author={Dosovitskiy, Alexey and others},
Line 13:   journal={arXiv preprint arXiv:2010.11929},
Line 14:   year={2020}
Line 15: }`

const PROJECT_FILES = JSON.stringify([
  { path: 'main.tex', type: 'doc' },
  { path: 'chapters/intro.tex', type: 'doc' },
  { path: 'chapters/methods.tex', type: 'doc' },
  { path: 'chapters/results.tex', type: 'doc' },
  { path: 'refs.bib', type: 'doc' },
  { path: 'figures/fig1.png', type: 'file' },
  { path: 'figures/fig2.pdf', type: 'file' },
  { path: 'tables/data.csv', type: 'file' },
])

// ========== API helpers ==========

async function callStreaming(messages) {
  const start = Date.now()
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      stream: true,
    }),
  })

  if (!resp.ok) {
    const t = await resp.text()
    return { error: true, status: resp.status, body: t, elapsed: Date.now() - start }
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', content = ''
  const toolCalls = []
  let finishReason = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue
      try {
        const chunk = JSON.parse(trimmed.slice(6))
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content) content += delta.content
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: tc.function?.name || '', arguments: '' } }
            if (tc.function?.name) toolCalls[idx].function.name = tc.function.name
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
            if (tc.id) toolCalls[idx].id = tc.id
          }
        }
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason
      } catch {}
    }
  }

  return { content, toolCalls: toolCalls.filter(Boolean), finishReason, elapsed: Date.now() - start }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }
function parseTcArgs(tc) { try { return JSON.parse(tc.function?.arguments || '{}') } catch { return { _parseError: true } } }
function isChineseText(t) { const ch = (t.match(/[\u4e00-\u9fff]/g) || []).length; const total = t.replace(/\s/g, '').length; return total > 0 && ch / total > 0.15 }

// ========== Test infrastructure ==========

const ALL_TESTS = []
const results = { pass: 0, fail: 0, warn: 0, details: [] }

function test(name, category, fn) {
  ALL_TESTS.push({ name: `${category}: ${name}`, fn })
}

function record(name, pass, details = {}) {
  const status = pass === true ? 'PASS' : pass === 'warn' ? 'WARN' : 'FAIL'
  results.details.push({ name, status, ...details })
  if (status === 'PASS') results.pass++
  else if (status === 'WARN') results.warn++
  else results.fail++
  const icon = status === 'PASS' ? '  [PASS]' : status === 'WARN' ? '  [WARN]' : '  [FAIL]'
  console.log(`${icon} ${name}`)
}

// Helper: run multi-turn conversation
async function runConversation(messages, opts = {}) {
  const { maxTurns = 8, toolResultProvider } = opts
  const turns = []

  for (let turn = 1; turn <= maxTurns; turn++) {
    const r = await callStreaming(messages)
    if (r.error) {
      turns.push({ turn, error: true, status: r.status })
      break
    }

    const tools = r.toolCalls.map(tc => tc.function.name)
    const hasText = r.content.trim().length > 0

    turns.push({
      turn,
      tools,
      content: r.content,
      toolCalls: r.toolCalls,
      finishReason: r.finishReason,
      hasText,
    })

    // Check for terminal states:
    // - No tool calls + stop → model is done (text-only reply or end of workflow)
    if (tools.length === 0 && r.finishReason === 'stop') break

    // Provide tool results and continue
    if (r.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls })
      for (const tc of r.toolCalls) {
        const result = toolResultProvider
          ? toolResultProvider(tc.function.name, parseTcArgs(tc), tc)
          : 'OK'
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
    }

    await delay(CALL_DELAY)
  }

  return turns
}

// ========== E: Complex editing scenarios ==========

test('Nested LaTeX structure editing (table + math)', 'E1', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请在 main.tex 的 CNN-based Approaches 下方的表格中添加一行 "ConvNeXt-T & ConvNeXt & 28.6 & 95.1"。保持表格格式不变。 [rid:${Date.now()}]` },
  ]

  const turns = await runConversation(messages, {
    toolResultProvider: (name, args) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'edit_document') {
        const hasBottomrule = args.newText?.includes('\\bottomrule')
        const hasConvNext = args.newText?.includes('ConvNeXt')
        if (hasBottomrule && hasConvNext) return 'Edit applied successfully.'
        return `Edit applied. Warning: verify table formatting.`
      }
      return 'OK'
    },
  })

  const readTurn = turns.find(t => t.tools.includes('read_document'))
  const editTurn = turns.find(t => t.tools.includes('edit_document'))
  const editArgs = editTurn ? parseTcArgs(editTurn.toolCalls.find(tc => tc.function.name === 'edit_document')) : {}

  console.log(`    Turns: ${turns.length}, Read: ${!!readTurn}, Edit: ${!!editTurn}`)
  console.log(`    oldText preview: "${(editArgs.oldText || '').substring(0, 80).replace(/\n/g, '\\n')}"`)
  console.log(`    newText preview: "${(editArgs.newText || '').substring(0, 80).replace(/\n/g, '\\n')}"`)

  // Quality checks
  const hasRead = !!readTurn
  const hasEdit = !!editTurn
  const preservesTableStructure = (editArgs.newText || '').includes('\\\\') && (editArgs.newText || '').includes('&')
  const containsConvNext = (editArgs.newText || '').includes('ConvNeXt')
  const preservesBottomrule = (editArgs.newText || '').includes('\\bottomrule')

  console.log(`    Preserves table: ${preservesTableStructure}, Has ConvNeXt: ${containsConvNext}, Bottomrule: ${preservesBottomrule}`)

  if (hasRead && hasEdit && preservesTableStructure && containsConvNext && preservesBottomrule) {
    return record('E1', true, { editQuality: 'excellent' })
  }
  if (hasRead && hasEdit && containsConvNext) {
    return record('E1', 'warn', { editQuality: 'acceptable', preservesTable: preservesTableStructure })
  }
  return record('E1', false, { reason: `read=${hasRead} edit=${hasEdit} convnext=${containsConvNext}` })
})

test('Math equation editing (modify loss function)', 'E2', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请把 main.tex 中的 cross-entropy loss 公式改成 focal loss 公式。Focal loss 的公式是: L = -1/N * sum_{i=1}^{N} sum_{k=1}^{K} alpha_k (1 - y_hat_{ik})^gamma * y_{ik} * log(y_hat_{ik})，其中 alpha 和 gamma 是超参数。请同时在公式下方添加说明文字解释 alpha 和 gamma 的含义。 [rid:${Date.now()}]` },
  ]

  const turns = await runConversation(messages, {
    toolResultProvider: (name, args) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'edit_document') return 'Edit applied successfully.'
      return 'OK'
    },
  })

  const editTurns = turns.filter(t => t.tools.includes('edit_document'))
  const allEditArgs = editTurns.flatMap(t =>
    t.toolCalls.filter(tc => tc.function.name === 'edit_document').map(parseTcArgs)
  )

  console.log(`    Turns: ${turns.length}, Edit turns: ${editTurns.length}`)
  for (const ea of allEditArgs) {
    console.log(`    Edit: "${(ea.oldText || '').substring(0, 60).replace(/\n/g, '\\n')}" → "${(ea.newText || '').substring(0, 60).replace(/\n/g, '\\n')}"`)
  }

  const hasRead = turns.some(t => t.tools.includes('read_document'))
  const hasEdit = editTurns.length > 0
  const hasMathSyntax = allEditArgs.some(ea =>
    (ea.newText || '').includes('\\alpha') || (ea.newText || '').includes('\\gamma') || (ea.newText || '').includes('focal')
  )
  const preservesEquationEnv = allEditArgs.some(ea =>
    (ea.newText || '').includes('\\begin{equation}') || (ea.newText || '').includes('equation')
  )

  console.log(`    Read: ${hasRead}, Edit: ${hasEdit}, Math: ${hasMathSyntax}, EqEnv: ${preservesEquationEnv}`)

  if (hasRead && hasEdit && hasMathSyntax) {
    return record('E2', true, { editCount: allEditArgs.length, hasMath: true })
  }
  if (hasRead && hasEdit) {
    return record('E2', 'warn', { editCount: allEditArgs.length, hasMath: hasMathSyntax })
  }
  return record('E2', false, { reason: `read=${hasRead} edit=${hasEdit} math=${hasMathSyntax}` })
})

test('Multi-file awareness (edit needs context from another file)', 'E3', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `我想在 main.tex 的 Introduction 部分添加一个新的引用。请先看一下 refs.bib 有哪些已有的引用，然后帮我在 Introduction 中的 "Traditional methods relied heavily on hand-crafted features" 这句话后面添加引用 \\cite{litjens2017survey}，如果还没有的话。 [rid:${Date.now()}]` },
  ]

  let readCount = 0
  const filesRead = []
  const turns = await runConversation(messages, {
    toolResultProvider: (name, args) => {
      if (name === 'read_document') {
        readCount++
        const path = args.path || 'main.tex'
        filesRead.push(path)
        if (path.includes('bib') || path.includes('refs')) return REFS_BIB
        return COMPLEX_DOC
      }
      if (name === 'edit_document') return 'Edit applied successfully.'
      if (name === 'list_files') return PROJECT_FILES
      return 'OK'
    },
  })

  console.log(`    Turns: ${turns.length}, Reads: ${readCount}, Files read: [${filesRead}]`)
  console.log(`    Tools per turn: ${turns.map(t => t.tools.join(',')).join(' | ')}`)

  // The model should read at least one file, ideally both
  const readBib = filesRead.some(f => f.includes('bib') || f.includes('refs'))
  const readMain = filesRead.some(f => f.includes('main') || f === '' || !f.includes('.'))
  const hasEdit = turns.some(t => t.tools.includes('edit_document'))

  console.log(`    Read bib: ${readBib}, Read main: ${readMain}, Has edit: ${hasEdit}`)

  // The doc already has \cite{litjens2017survey}, so the model should notice this
  // and either not edit (smart) or confirm it's already there
  const editArgs = turns
    .filter(t => t.tools.includes('edit_document'))
    .flatMap(t => t.toolCalls.filter(tc => tc.function.name === 'edit_document').map(parseTcArgs))
  console.log(`    Edit count: ${editArgs.length}`)

  if (readCount >= 1) {
    return record('E3', true, { readBib, readMain, hasEdit, editCount: editArgs.length, filesRead })
  }
  return record('E3', false, { reason: `No reads performed` })
})

test('Complex multi-section rewrite with instructions', 'E4', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请帮我改进 main.tex 的摘要部分（abstract）。要求：1. 翻译成中文 2. 增加具体数据（比如"涵盖了X篇论文"改成"系统综述了150篇论文"） 3. 添加关键词，格式为"\\textbf{关键词：}深度学习、医学图像分析、卷积神经网络、Transformer" 4. 保持 LaTeX abstract 环境格式不变 [rid:${Date.now()}]` },
  ]

  const turns = await runConversation(messages, {
    toolResultProvider: (name, args) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'edit_document') return 'Edit applied successfully.'
      return 'OK'
    },
  })

  const editArgs = turns
    .filter(t => t.tools.includes('edit_document'))
    .flatMap(t => t.toolCalls.filter(tc => tc.function.name === 'edit_document').map(parseTcArgs))

  console.log(`    Turns: ${turns.length}, Edits: ${editArgs.length}`)
  for (const ea of editArgs) {
    console.log(`    oldText: ${(ea.oldText || '').substring(0, 80).replace(/\n/g, '\\n')}...`)
    console.log(`    newText: ${(ea.newText || '').substring(0, 80).replace(/\n/g, '\\n')}...`)
  }

  const hasRead = turns.some(t => t.tools.includes('read_document'))
  const hasEdit = editArgs.length > 0
  const hasChinese = editArgs.some(ea => isChineseText(ea.newText || ''))
  const hasKeywords = editArgs.some(ea => (ea.newText || '').includes('关键词'))
  const preservesAbstract = editArgs.some(ea =>
    (ea.newText || '').includes('abstract') || (ea.oldText || '').includes('abstract')
  )

  console.log(`    Chinese: ${hasChinese}, Keywords: ${hasKeywords}, Abstract env: ${preservesAbstract}`)

  if (hasRead && hasEdit && hasChinese && hasKeywords) {
    return record('E4', true, { requirements: { chinese: true, keywords: true, abstract: preservesAbstract } })
  }
  if (hasRead && hasEdit && hasChinese) {
    return record('E4', 'warn', { requirements: { chinese: true, keywords: hasKeywords } })
  }
  return record('E4', false, { reason: `read=${hasRead} edit=${hasEdit} chinese=${hasChinese}` })
})

// ========== F: Error recovery ==========

test('Recover from edit_document error (text not found)', 'F1', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `把 main.tex 中的 "deep learning techniques" 改成 "深度学习技术" [rid:${Date.now()}]` },
  ]

  let editAttempts = 0
  const turns = await runConversation(messages, {
    maxTurns: 6,
    toolResultProvider: (name, args) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'edit_document') {
        editAttempts++
        if (editAttempts === 1) {
          // First attempt: simulate exact match failure
          return 'Error: oldText not found in document. The text must match exactly, including whitespace and line breaks. Please read the document again and copy the exact text.'
        }
        return 'Edit applied successfully.'
      }
      return 'OK'
    },
  })

  console.log(`    Turns: ${turns.length}, Edit attempts: ${editAttempts}`)
  console.log(`    Turn tools: ${turns.map(t => t.tools.join(',')).join(' | ')}`)

  // Model should: read → edit (fail) → retry edit (or re-read then edit)
  const retried = editAttempts >= 2
  const hasText = turns.some(t => t.hasText && t.content.length > 10)

  console.log(`    Retried: ${retried}, Has explanatory text: ${hasText}`)

  if (retried) {
    return record('F1', true, { editAttempts, behavior: 'retried_after_error' })
  }
  if (editAttempts >= 1 && turns.length >= 3) {
    return record('F1', 'warn', { editAttempts, behavior: 'attempted_but_unclear_retry' })
  }
  return record('F1', false, { reason: `editAttempts=${editAttempts}, turns=${turns.length}` })
})

test('Recover from read_document error (file not found)', 'F2', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `帮我读一下 chapters/appendix.tex 的内容 [rid:${Date.now()}]` },
  ]

  const turns = await runConversation(messages, {
    toolResultProvider: (name, args) => {
      if (name === 'read_document') {
        if ((args.path || '').includes('appendix')) {
          return 'Error: File "chapters/appendix.tex" not found in project. Available files: main.tex, chapters/intro.tex, chapters/methods.tex, chapters/results.tex, refs.bib'
        }
        return COMPLEX_DOC
      }
      if (name === 'list_files') return PROJECT_FILES
      return 'OK'
    },
  })

  console.log(`    Turns: ${turns.length}`)
  console.log(`    Turn tools: ${turns.map(t => t.tools.join(',')).join(' | ')}`)

  // After file not found, model should inform user via text reply
  const lastTurn = turns[turns.length - 1]
  let finalText = lastTurn?.content?.trim() || ''

  console.log(`    Final response: "${finalText.substring(0, 150).replace(/\n/g, '\\n')}"`)

  const informsUser = finalText.length > 10
  const mentionsError = finalText.includes('找不到') || finalText.includes('不存在') || finalText.includes('not found') || finalText.includes('没有找到') || finalText.includes('无法')

  console.log(`    Informs user: ${informsUser}, Mentions error: ${mentionsError}`)

  if (informsUser && mentionsError) {
    return record('F2', true, { behavior: 'informed_user_about_missing_file' })
  }
  if (informsUser) {
    return record('F2', 'warn', { behavior: 'responded_but_unclear_error_mention' })
  }
  return record('F2', false, { reason: 'No useful response to user about missing file' })
})

test('Handle multiple tool errors gracefully', 'F3', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请把 main.tex 中的 "Introduction" 改成 "绪论"，然后把 "Conclusion" 改成 "总结" [rid:${Date.now()}]` },
  ]

  let editCount = 0
  const turns = await runConversation(messages, {
    maxTurns: 8,
    toolResultProvider: (name, args) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'edit_document') {
        editCount++
        if (editCount <= 2) {
          return `Error: Multiple matches found for "${args.oldText}". Please provide more surrounding context to make the match unique, or use replaceAll: true.`
        }
        return 'Edit applied successfully.'
      }
      return 'OK'
    },
  })

  console.log(`    Turns: ${turns.length}, Edit attempts: ${editCount}`)
  console.log(`    Turn tools: ${turns.map(t => t.tools.join(',')).join(' | ')}`)

  // Check if model adapted after errors (e.g., provided more context or used replaceAll)
  const editArgs = turns
    .filter(t => t.tools.includes('edit_document'))
    .flatMap(t => t.toolCalls.filter(tc => tc.function.name === 'edit_document').map(parseTcArgs))

  const usedReplaceAll = editArgs.some(ea => ea.replaceAll === true)
  const expandedContext = editArgs.length >= 3 && editArgs[2]?.oldText?.length > (editArgs[0]?.oldText?.length || 0)

  console.log(`    Used replaceAll: ${usedReplaceAll}, Expanded context: ${expandedContext}`)
  console.log(`    Edit args lengths: ${editArgs.map(ea => ea.oldText?.length || 0).join(', ')}`)

  if (editCount >= 3 && (usedReplaceAll || expandedContext)) {
    return record('F3', true, { behavior: 'adapted_strategy', usedReplaceAll, expandedContext })
  }
  if (editCount >= 2) {
    return record('F3', 'warn', { behavior: 'retried_but_unclear_adaptation', editCount })
  }
  return record('F3', false, { reason: `editCount=${editCount}` })
})

// ========== G: Ambiguous requests (tool vs text) ==========

test('Ambiguous: "帮我看看摘要写得怎么样" (review vs read)', 'G1', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `帮我看看 main.tex 的摘要写得怎么样？有什么可以改进的地方吗？ [rid:${Date.now()}]` },
  ]

  const turns = await runConversation(messages, {
    toolResultProvider: (name) => {
      if (name === 'read_document') return COMPLEX_DOC
      return 'OK'
    },
  })

  console.log(`    Turns: ${turns.length}`)
  console.log(`    Turn tools: ${turns.map(t => t.tools.join(',')).join(' | ')}`)

  // Model should: (1) read the document, (2) provide analysis/feedback in text
  const hasRead = turns.some(t => t.tools.includes('read_document'))
  const analysisText = turns.find(t => t.hasText && t.content.length > 50 && !t.tools.includes('edit_document'))

  let reviewContent = ''
  for (const t of turns) {
    if (t.hasText && t.content.length > 20) reviewContent += t.content
  }

  console.log(`    Read doc: ${hasRead}`)
  console.log(`    Review text: ${reviewContent.length} chars`)
  console.log(`    Preview: "${reviewContent.substring(0, 200).replace(/\n/g, '\\n')}"`)
  console.log(`    Chinese: ${isChineseText(reviewContent)}`)

  // Did NOT make unsolicited edits (important: user asked for review, not edit)
  const madeEdits = turns.some(t => t.tools.includes('edit_document'))
  console.log(`    Made unsolicited edits: ${madeEdits}`)

  if (hasRead && reviewContent.length > 50 && !madeEdits) {
    return record('G1', true, { behavior: 'read_then_review', chinese: isChineseText(reviewContent) })
  }
  if (hasRead && reviewContent.length > 20) {
    return record('G1', 'warn', { behavior: 'reviewed', madeEdits })
  }
  return record('G1', false, { reason: `read=${hasRead} review=${reviewContent.length}c edits=${madeEdits}` })
})

test('Ambiguous: user asks about LaTeX but could also mean "edit for me"', 'G2', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `我论文里的参考文献格式不对，应该用 IEEE 格式。 [rid:${Date.now()}]` },
  ]

  const turns = await runConversation(messages, {
    toolResultProvider: (name) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'list_files') return PROJECT_FILES
      if (name === 'edit_document') return 'Edit applied successfully.'
      return 'OK'
    },
  })

  console.log(`    Turns: ${turns.length}`)
  console.log(`    Turn tools: ${turns.map(t => t.tools.join(',')).join(' | ')}`)

  // Acceptable behaviors:
  // 1. Read document to check current state, then advise/edit (best)
  // 2. Just explain what to do in text (acceptable)
  // 3. Ask for clarification (acceptable)
  const hasRead = turns.some(t => t.tools.includes('read_document'))
  const hasEdit = turns.some(t => t.tools.includes('edit_document'))
  const hasText = turns.some(t => t.hasText && t.content.length > 30)

  let responseText = ''
  for (const t of turns) {
    if (t.hasText) responseText += t.content
  }

  console.log(`    Read: ${hasRead}, Edit: ${hasEdit}, Text: ${responseText.length}c`)
  console.log(`    Preview: "${responseText.substring(0, 200).replace(/\n/g, '\\n')}"`)

  // Note: the document already uses IEEE format (biblatex with style=ieee)
  // Smart model should notice this
  const noticesExisting = responseText.includes('ieee') || responseText.includes('IEEE') || responseText.includes('已经')

  if (hasRead && responseText.length > 30) {
    return record('G2', true, { behavior: hasEdit ? 'read_and_edit' : 'read_and_advise', noticesExisting })
  }
  if (responseText.length > 30) {
    return record('G2', 'warn', { behavior: 'text_advice_only' })
  }
  return record('G2', false, { reason: 'No meaningful response' })
})

test('Ambiguous: follow-up after edit without explicit request', 'G3', async () => {
  // Simulate: model just made an edit, user says "还有别的建议吗？"
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `把 main.tex 的标题改成中文 [rid:${Date.now()}]` },
  ]

  // First conversation: read → edit → respond
  const phase1 = await runConversation(messages, {
    maxTurns: 5,
    toolResultProvider: (name, args) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'edit_document') return 'Edit applied successfully.'
      return 'OK'
    },
  })

  console.log(`    Phase 1 turns: ${phase1.length}`)

  // Add the response to messages
  const lastTurn = phase1[phase1.length - 1]
  if (lastTurn?.toolCalls?.length > 0 && !messages.find(m => m.role === 'assistant' && m.tool_calls === lastTurn.toolCalls)) {
    messages.push({ role: 'assistant', content: lastTurn.content || null, tool_calls: lastTurn.toolCalls })
    for (const tc of lastTurn.toolCalls) {
      messages.push({ role: 'tool', tool_call_id: tc.id, content: parseTcArgs(tc).response || 'OK' })
    }
  } else if (lastTurn?.content && !lastTurn?.toolCalls?.length) {
    messages.push({ role: 'assistant', content: lastTurn.content })
  }

  await delay(CALL_DELAY)

  // Now ask follow-up
  messages.push({ role: 'user', content: `还有别的建议吗？ [rid:${Date.now()}]` })
  const r = await callStreaming(messages)

  if (r.error) {
    return record('G3', false, { error: r })
  }

  const tools = r.toolCalls.map(tc => tc.function.name)
  let responseText = r.content.trim()

  console.log(`    Follow-up: finish=${r.finishReason} tools=[${tools}]`)
  console.log(`    Response: "${responseText.substring(0, 200).replace(/\n/g, '\\n')}"`)
  console.log(`    Chinese: ${isChineseText(responseText)}`)

  // Model should either: give text suggestions, or read & suggest, NOT make unsolicited edits
  const madeEdits = tools.includes('edit_document')

  if (responseText.length > 20 && !madeEdits) {
    return record('G3', true, { behavior: 'gave_suggestions', chinese: isChineseText(responseText) })
  }
  if (responseText.length > 20) {
    return record('G3', 'warn', { behavior: 'gave_suggestions_with_edits' })
  }
  return record('G3', false, { reason: `response=${responseText.length}c edits=${madeEdits}` })
})

// ========== H: Long conversations & doom loop resistance ==========

test('5-turn conversation with alternating requests', 'H1', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
  ]

  const userMessages = [
    '你好，我正在写一篇深度学习的综述论文。',
    '帮我看看项目里有哪些文件。',
    '读一下 main.tex 的内容。',
    '摘要部分的英文写得怎么样？有语法问题吗？',
    '帮我把标题从英文改成中文"深度学习在医学图像分析中的综合综述"。',
  ]

  const expectedBehaviors = [
    'text',         // greeting/intro → text
    'list_files',   // list request → tool
    'read_document',// read request → tool
    'text',         // review request → text (after seeing doc from previous turn)
    'edit_document',// edit request → tool (read first since new turn)
  ]

  let turnResults = []

  for (let i = 0; i < userMessages.length; i++) {
    messages.push({ role: 'user', content: `${userMessages[i]} [rid:${Date.now()}-${i}]` })

    const r = await callStreaming(messages)
    if (r.error) {
      turnResults.push({ turn: i + 1, error: true })
      break
    }

    const tools = r.toolCalls.map(tc => tc.function.name)
    const hasText = r.content.trim().length > 0
    const docTools = tools.filter(n => ['list_files', 'read_document', 'edit_document'].includes(n))

    turnResults.push({
      turn: i + 1,
      tools,
      hasText,
      finishReason: r.finishReason,
      contentLen: r.content.length,
    })

    console.log(`    Turn ${i + 1}: tools=[${tools}] text=${r.content.length}c finish=${r.finishReason}`)

    // Add response and tool results to continue conversation
    if (r.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls })
      for (const tc of r.toolCalls) {
        const name = tc.function.name
        let result = 'OK'
        if (name === 'list_files') result = PROJECT_FILES
        else if (name === 'read_document') result = COMPLEX_DOC
        else if (name === 'edit_document') result = 'Edit applied successfully.'
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
    } else {
      messages.push({ role: 'assistant', content: r.content })
    }

    await delay(CALL_DELAY)
  }

  // Check each turn matches expected behavior
  let correct = 0
  for (let i = 0; i < turnResults.length; i++) {
    const tr = turnResults[i]
    if (tr.error) continue
    const expected = expectedBehaviors[i]
    const tools = tr.tools

    let ok = false
    if (expected === 'text') {
      ok = tr.hasText && tools.length === 0
    } else {
      ok = tools.includes(expected)
    }
    if (ok) correct++
    console.log(`    Turn ${i + 1}: expected=${expected} → ${ok ? 'OK' : 'MISMATCH'}`)
  }

  console.log(`    Score: ${correct}/${turnResults.length}`)

  if (correct >= 4) return record('H1', true, { score: `${correct}/${turnResults.length}` })
  if (correct >= 3) return record('H1', 'warn', { score: `${correct}/${turnResults.length}` })
  return record('H1', false, { score: `${correct}/${turnResults.length}` })
})

test('Doom loop resistance (repeated identical tool result)', 'H2', async () => {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请把 main.tex 中的 "Introduction" 改成 "引言" [rid:${Date.now()}]` },
  ]

  let editAttempts = 0
  const turns = await runConversation(messages, {
    maxTurns: 8,
    toolResultProvider: (name) => {
      if (name === 'read_document') return COMPLEX_DOC
      if (name === 'edit_document') {
        editAttempts++
        // Always return error - simulates persistent failure
        return 'Error: Document is currently locked by another user. Please try again later.'
      }
      return 'OK'
    },
  })

  console.log(`    Turns: ${turns.length}, Edit attempts: ${editAttempts}`)
  console.log(`    Turn tools: ${turns.map(t => t.tools.join(',')).join(' | ')}`)

  // Model should NOT loop endlessly on the same failing edit
  // It should: try once or twice, then inform the user about the lock

  let finalText = ''
  for (const t of turns) {
    if (t.hasText) finalText += t.content
  }

  console.log(`    Final text: "${finalText.substring(0, 200).replace(/\n/g, '\\n')}"`)

  if (editAttempts <= 3 && finalText.length > 20) {
    return record('H2', true, { editAttempts, behavior: 'stopped_and_informed_user' })
  }
  if (editAttempts <= 4) {
    return record('H2', 'warn', { editAttempts, behavior: 'retried_a_few_times' })
  }
  return record('H2', false, { reason: `Looped ${editAttempts} times without stopping` })
})

test('Context retention in long conversation', 'H3', async () => {
  // Test: after reading a file and making some edits, can the model recall
  // what it read when asked a question about the content?
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `读一下 main.tex [rid:${Date.now()}]` },
  ]

  // Turn 1: Read
  const r1 = await callStreaming(messages)
  if (r1.error) return record('H3', false, { error: 'turn 1 error' })

  const readTc = r1.toolCalls.find(tc => tc.function.name === 'read_document')
  if (!readTc) return record('H3', false, { reason: 'no read_document call' })

  messages.push({ role: 'assistant', content: r1.content || null, tool_calls: r1.toolCalls })
  messages.push({ role: 'tool', tool_call_id: readTc.id, content: COMPLEX_DOC })

  // Let model respond
  await delay(CALL_DELAY)
  const r1b = await callStreaming(messages)
  if (r1b.toolCalls.length > 0) {
    messages.push({ role: 'assistant', content: r1b.content || null, tool_calls: r1b.toolCalls })
    for (const tc of r1b.toolCalls) {
      messages.push({ role: 'tool', tool_call_id: tc.id, content: parseTcArgs(tc).response || 'OK' })
    }
  } else {
    messages.push({ role: 'assistant', content: r1b.content })
  }

  await delay(CALL_DELAY)

  // Turn 2: Ask about content (without re-reading)
  messages.push({
    role: 'user',
    content: `论文里提到了哪三种 CNN 架构？各自的准确率是多少？不需要再读文件了，你刚才已经读过了。 [rid:${Date.now()}]`,
  })

  const r2 = await callStreaming(messages)
  if (r2.error) return record('H3', false, { error: 'turn 2 error' })

  const t2Tools = r2.toolCalls.map(tc => tc.function.name)
  let response = r2.content.trim()

  console.log(`    Turn 2: tools=[${t2Tools}] finish=${r2.finishReason}`)
  console.log(`    Response: "${response.substring(0, 300).replace(/\n/g, '\\n')}"`)

  // Check if response mentions the three architectures from the table
  const mentionsResNet = response.includes('ResNet') || response.includes('resnet')
  const mentionsDenseNet = response.includes('DenseNet') || response.includes('densenet')
  const mentionsEfficient = response.includes('EfficientNet') || response.includes('efficient')
  const reRead = t2Tools.includes('read_document')

  console.log(`    ResNet: ${mentionsResNet}, DenseNet: ${mentionsDenseNet}, EfficientNet: ${mentionsEfficient}`)
  console.log(`    Re-read: ${reRead}`)

  const archCount = [mentionsResNet, mentionsDenseNet, mentionsEfficient].filter(Boolean).length

  if (archCount >= 2 && !reRead) {
    return record('H3', true, { behavior: 'recalled_from_context', archCount, reRead })
  }
  if (archCount >= 2) {
    return record('H3', 'warn', { behavior: 'answered_correctly_but_reread', archCount, reRead })
  }
  if (archCount >= 1) {
    return record('H3', 'warn', { behavior: 'partial_recall', archCount, reRead })
  }
  return record('H3', false, { reason: `archCount=${archCount}, reRead=${reRead}` })
})

// ========== I: Temperature stability ==========

test(`Tool selection consistency at temp=${TEMPERATURE} (5 runs)`, 'I1', async () => {
  const scenarios = [
    { msg: '你好！', expectedType: 'text', label: 'greeting' },
    { msg: '帮我列出项目文件', expectedType: 'tool', expectedTool: 'list_files', label: 'list' },
    { msg: '读一下 main.tex', expectedType: 'tool', expectedTool: 'read_document', label: 'read' },
  ]

  const results_per_scenario = {}

  for (const s of scenarios) {
    results_per_scenario[s.label] = { correct: 0, total: 0, modes: [] }

    for (let run = 0; run < 5; run++) {
      const msgs = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${s.msg} [rid:${Date.now()}-${run}]` },
      ]
      const r = await callStreaming(msgs)
      if (r.error) {
        results_per_scenario[s.label].modes.push('ERROR')
        continue
      }

      const tools = r.toolCalls.map(tc => tc.function.name)
      const hasText = r.content.trim().length > 0
      results_per_scenario[s.label].total++

      let correct = false
      let mode = ''
      if (s.expectedType === 'text') {
        correct = hasText && tools.length === 0
        mode = tools.length === 0 ? 'TEXT' : `TOOL:[${tools}]`
      } else {
        correct = tools.includes(s.expectedTool)
        mode = tools.length > 0 ? `TOOL:[${tools}]` : 'TEXT'
      }

      if (correct) results_per_scenario[s.label].correct++
      results_per_scenario[s.label].modes.push(mode)

      await delay(CALL_DELAY)
    }

    const sr = results_per_scenario[s.label]
    console.log(`    ${s.label}: ${sr.correct}/${sr.total} correct, modes=[${sr.modes.join(', ')}]`)
  }

  const totalCorrect = Object.values(results_per_scenario).reduce((a, b) => a + b.correct, 0)
  const totalRuns = Object.values(results_per_scenario).reduce((a, b) => a + b.total, 0)

  console.log(`    Total: ${totalCorrect}/${totalRuns}`)

  if (totalCorrect >= totalRuns * 0.9) {
    return record('I1', true, { accuracy: `${totalCorrect}/${totalRuns}`, detail: results_per_scenario })
  }
  if (totalCorrect >= totalRuns * 0.7) {
    return record('I1', 'warn', { accuracy: `${totalCorrect}/${totalRuns}`, detail: results_per_scenario })
  }
  return record('I1', false, { accuracy: `${totalCorrect}/${totalRuns}`, detail: results_per_scenario })
})

test(`Edit quality consistency at temp=${TEMPERATURE} (3 runs)`, 'I2', async () => {
  const qualities = []

  for (let run = 0; run < 3; run++) {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `请把 main.tex 的 abstract 翻译成中文 [rid:${Date.now()}-${run}]` },
    ]

    const turns = await runConversation(messages, {
      maxTurns: 5,
      toolResultProvider: (name) => {
        if (name === 'read_document') return COMPLEX_DOC
        if (name === 'edit_document') return 'Edit applied successfully.'
        return 'OK'
      },
    })

    const editArgs = turns
      .filter(t => t.tools?.includes('edit_document'))
      .flatMap(t => (t.toolCalls || []).filter(tc => tc.function.name === 'edit_document').map(parseTcArgs))

    const quality = {
      run,
      hasRead: turns.some(t => t.tools?.includes('read_document')),
      hasEdit: editArgs.length > 0,
      isChinese: editArgs.some(ea => isChineseText(ea.newText || '')),
      preservesLatex: editArgs.some(ea => (ea.newText || '').includes('abstract') || (ea.oldText || '').includes('abstract')),
      newTextLen: editArgs[0]?.newText?.length || 0,
    }
    qualities.push(quality)

    console.log(`    Run ${run + 1}: read=${quality.hasRead} edit=${quality.hasEdit} chinese=${quality.isChinese} latex=${quality.preservesLatex} len=${quality.newTextLen}`)

    await delay(CALL_DELAY)
  }

  const allRead = qualities.every(q => q.hasRead)
  const allEdit = qualities.every(q => q.hasEdit)
  const allChinese = qualities.every(q => q.isChinese)
  const consistent = allRead && allEdit && allChinese

  console.log(`    Consistency: read=${allRead} edit=${allEdit} chinese=${allChinese}`)

  if (consistent) return record('I2', true, { consistency: 'all_3_runs_consistent' })
  if (qualities.filter(q => q.hasRead && q.hasEdit && q.isChinese).length >= 2) {
    return record('I2', 'warn', { consistency: '2/3 runs good' })
  }
  return record('I2', false, { qualities })
})

// ========== Main ==========

async function main() {
  console.log('='.repeat(80))
  console.log('AI WRITING AGENT — MODEL STRESS TEST')
  console.log('='.repeat(80))
  console.log(`Model:       ${MODEL}`)
  console.log(`Endpoint:    ${API_BASE}`)
  console.log(`Temperature: ${TEMPERATURE}`)
  console.log(`Max tokens:  ${MAX_TOKENS}`)
  console.log(`tool_choice: auto`)
  console.log(`Call delay:  ${CALL_DELAY}ms`)
  console.log(`Prompt:      ${systemPrompt.length} chars`)
  console.log(`Tests:       ${ALL_TESTS.length}`)
  console.log(`Time:        ${new Date().toISOString()}`)
  console.log()

  for (const test of ALL_TESTS) {
    console.log('\n' + '-'.repeat(70))
    console.log(`  ${test.name}`)
    console.log('-'.repeat(70))
    try {
      await test.fn()
    } catch (err) {
      console.log(`    EXCEPTION: ${err.message}`)
      console.log(`    Stack: ${err.stack?.split('\n')[1]?.trim()}`)
      record(test.name, false, { exception: err.message })
    }
    console.log()
    await delay(CALL_DELAY)
  }

  // ========== Summary ==========
  console.log('\n' + '='.repeat(80))
  console.log('FINAL RESULTS')
  console.log('='.repeat(80))
  console.log(`\n  PASS: ${results.pass}  WARN: ${results.warn}  FAIL: ${results.fail}  Total: ${ALL_TESTS.length}\n`)

  // Category breakdown
  const categories = {
    'E: Complex editing': [],
    'F: Error recovery': [],
    'G: Ambiguous requests': [],
    'H: Long conversations': [],
    'I: Temperature stability': [],
  }

  for (const d of results.details) {
    const cat = d.name[0]
    const catName = cat === 'E' ? 'E: Complex editing'
      : cat === 'F' ? 'F: Error recovery'
      : cat === 'G' ? 'G: Ambiguous requests'
      : cat === 'H' ? 'H: Long conversations'
      : cat === 'I' ? 'I: Temperature stability'
      : 'Other'
    if (categories[catName]) categories[catName].push(d)
  }

  for (const [name, tests] of Object.entries(categories)) {
    const pass = tests.filter(t => t.status === 'PASS').length
    const warn = tests.filter(t => t.status === 'WARN').length
    const fail = tests.filter(t => t.status === 'FAIL').length
    console.log(`  ${name}: ${pass} pass, ${warn} warn, ${fail} fail`)
    for (const t of tests) {
      const icon = t.status === 'PASS' ? '  [PASS]' : t.status === 'WARN' ? '  [WARN]' : '  [FAIL]'
      console.log(`    ${icon} ${t.name}`)
    }
  }

  // ========== Workflow assessment ==========
  console.log('\n' + '-'.repeat(70))
  console.log(`WORKFLOW ASSESSMENT — ${MODEL}`)
  console.log('-'.repeat(70))

  // Complex editing
  const editTests = categories['E: Complex editing']
  const editPass = editTests.filter(t => t.status === 'PASS').length
  console.log(`\n  Complex editing capability: ${editPass}/${editTests.length} pass`)
  if (editPass >= editTests.length * 0.75) {
    console.log(`    -> Model handles complex LaTeX editing well at temp=${TEMPERATURE}`)
  } else {
    console.log('    -> WARNING: Complex editing quality needs investigation')
  }

  // Error recovery
  const errorTests = categories['F: Error recovery']
  const errorPass = errorTests.filter(t => t.status !== 'FAIL').length
  console.log(`\n  Error recovery: ${errorPass}/${errorTests.length} pass/warn`)
  if (errorPass >= errorTests.length * 0.66) {
    console.log('    -> Model can recover from tool errors without doom loops')
  } else {
    console.log('    -> WARNING: Error recovery needs improvement')
  }

  // Decision-making
  const ambigTests = categories['G: Ambiguous requests']
  const ambigPass = ambigTests.filter(t => t.status === 'PASS').length
  console.log(`\n  Ambiguous request handling: ${ambigPass}/${ambigTests.length} pass`)
  if (ambigPass >= ambigTests.length * 0.66) {
    console.log('    -> Model makes good text-vs-tool decisions in auto mode')
  } else {
    console.log('    -> WARNING: Decision-making on ambiguous requests needs review')
  }

  // Stability
  const stabTests = categories['I: Temperature stability']
  const stabPass = stabTests.filter(t => t.status !== 'FAIL').length
  console.log(`\n  Temperature stability (${TEMPERATURE}): ${stabPass}/${stabTests.length} pass/warn`)
  if (stabPass >= stabTests.length) {
    console.log(`    -> Tool selection remains consistent at temp=${TEMPERATURE}`)
  } else {
    console.log('    -> WARNING: Consider lowering temperature cap')
  }

  console.log('\n' + '='.repeat(80))
}

main().catch(err => {
  console.error('FATAL ERROR:', err)
  process.exit(1)
})
