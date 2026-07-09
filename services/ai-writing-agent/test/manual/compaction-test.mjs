#!/usr/bin/env node

/* eslint-disable import/no-extraneous-dependencies */

/**
 * Compaction End-to-End Stress Test
 *
 * 直连 AI Writing Agent（localhost:3060），模拟长对话场景，
 * 端到端验证 compaction 功能：触发、摘要质量、压缩后对话连续性。
 *
 * 前置条件：
 *   1. AI Writing Agent 以低阈值启动：
 *      CONTEXT_WINDOW=16000 COMPACTION_THRESHOLD=0.5 node app.js
 *   2. MongoDB 可访问（连接串从 .env 读取）
 *   3. 指定项目中有至少一个 .tex 文档
 *
 * 用法：
 *   node test/manual/compaction-test.mjs --project=<projectId>
 *
 * 可选参数：
 *   --base-url=http://localhost:3060   直连地址（默认）
 *   --rounds=8                         最大对话轮数
 *   --verbose                          打印完整 SSE 事件流
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import bcrypt from 'bcryptjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const serviceRoot = join(__dirname, '..', '..')

// ========== Configuration ==========

function parseCliArgs() {
  const args = {}
  for (const arg of process.argv.slice(2)) {
    if (arg === '--verbose') {
      args.verbose = 'true'
      continue
    }
    const match = arg.match(/^--([a-z-]+)=(.+)$/i)
    if (match) args[match[1]] = match[2]
  }
  return args
}

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

const BASE_URL = cli['base-url'] || 'http://localhost:3060'
const PROJECT_ID = cli.project
const DOC_ID = cli.doc || '6a390bf87a13c32e536c27a1'
const MAX_ROUNDS = Number(cli.rounds || '8')
const VERBOSE = cli.verbose === 'true'
const WEB_PROXY_MODE = cli['web-proxy'] === 'true'
const EMAIL = cli.email || process.env.AGENT_SMOKE_EMAIL || 'agent-smoke@example.com'
const PASSWORD = cli.password || process.env.AGENT_SMOKE_PASSWORD || 'AgentSmoke123!'
const MONGO_URL = cli['mongo-url'] ||
  process.env.MONGO_CONNECTION_STRING ||
  dotenv.MONGO_CONNECTION_STRING ||
  'mongodb://127.0.0.1:27017/sharelatex?directConnection=true'
const RUN_MARKER = `compaction-test-${Date.now()}`
const SMOKE_USER_LOCK_ID = 'agent-smoke-user-password'
const SMOKE_USER_LOCK_TTL_MS = 10 * 60_000

if (!PROJECT_ID) {
  console.error('用法: node test/manual/compaction-test.mjs --project=<projectId>')
  console.error('')
  console.error('可选参数:')
  console.error('  --base-url=http://localhost:3060')
  console.error('  --web-proxy=true')
  console.error('  --mongo-url=mongodb://127.0.0.1:37017/sharelatex?directConnection=true')
  console.error('  --rounds=8')
  console.error('  --verbose')
  process.exit(1)
}

// ========== ANSI Colors ==========

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
}

// ========== SSE Stream Reader ==========

/**
 * Send a message via SSE and collect events.
 * @param {string} sessionId
 * @param {string} content
 * @returns {Promise<{ events: Array, textContent: string }>}
 */
async function sendMessageSSE(sessionId, content) {
  const url = `${BASE_URL}/api/ai/sessions/${sessionId}/messages`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ content, context: {}, stream: true }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  let textContent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return { events, textContent }

      try {
        const event = JSON.parse(data)
        events.push(event)

        if (event.type === 'text' || event.type === 'text_chunk') textContent += event.content || ''

        if (VERBOSE) {
          switch (event.type) {
            case 'text': case 'text_chunk': process.stdout.write(event.content || ''); break
            case 'tool_call':
              console.log(`\n${C.cyan}[tool_call] ${event.toolCall?.function?.name || event.name}${C.reset}`)
              break
            case 'tool_result':
              console.log(`${C.yellow}[tool_result] ${(event.result?.output || '').slice(0, 200)}${C.reset}`)
              break
            case 'compaction_start':
              console.log(`\n${C.magenta}[compaction_start]${C.reset}`)
              break
            case 'compaction_done':
              console.log(`${C.magenta}[compaction_done] success=${event.success}${C.reset}`)
              break
            case 'context_truncated':
              console.log(`${C.red}[context_truncated]${C.reset}`)
              break
            default:
              if (event.type !== 'thinking' && event.type !== 'done')
                console.log(`${C.dim}[${event.type}]${C.reset}`)
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return { events, textContent }
}

// ========== HTTP Helpers ==========

async function createSession(projectId) {
  const resp = await fetch(`${BASE_URL}/api/ai/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Failed to create session: HTTP ${resp.status} — ${text.slice(0, 300)}`)
  }
  const data = await resp.json()
  return data.session?.id || data.session?._id
}

async function deleteSession(sessionId) {
  try {
    await fetch(`${BASE_URL}/api/ai/sessions/${sessionId}`, { method: 'DELETE' })
  } catch { /* best effort */ }
}

async function collection(db, name) {
  return db.collection(name)
}

async function acquireSmokeUserLock(db) {
  const locks = await collection(db, 'aiAgentManualSmokeLocks')
  const owner = RUN_MARKER
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await locks.insertOne({
        _id: SMOKE_USER_LOCK_ID,
        owner,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + SMOKE_USER_LOCK_TTL_MS),
      })
      return async () => {
        await locks.deleteOne({ _id: SMOKE_USER_LOCK_ID, owner }).catch(() => {})
      }
    } catch (error) {
      if (error.code !== 11000) throw error
      await locks.deleteOne({
        _id: SMOKE_USER_LOCK_ID,
        expiresAt: { $lt: new Date() },
      })
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  throw new Error('Timed out waiting for smoke user password lock')
}

async function restorePassword(db, user, originalHash, smokeHash) {
  if (!user || !originalHash || !smokeHash) return
  const result = await (await collection(db, 'users')).updateOne(
    { _id: user._id, hashedPassword: smokeHash },
    { $set: { hashedPassword: originalHash } }
  )
  if (result.modifiedCount === 0) {
    const currentUser = await (await collection(db, 'users')).findOne(
      { _id: user._id },
      { projection: { hashedPassword: 1 } }
    )
    if (currentUser?.hashedPassword !== originalHash) {
      console.warn('WARN: smoke user password changed during run; not overwriting concurrent hash update')
    }
  }
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' })
  const csrf = await page.locator('input[name="_csrf"]').inputValue()
  const response = await page.request.post(`${BASE_URL}/login`, {
    form: { _csrf: csrf, email: EMAIL, password: PASSWORD },
    maxRedirects: 0,
  })
  if (![200, 302].includes(response.status())) {
    throw new Error(`Login failed with status ${response.status()}: ${await response.text()}`)
  }
}

async function getCsrfToken(page) {
  await page.goto(`${BASE_URL}/project/${PROJECT_ID}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  const token = await page.locator('meta[name="ol-csrfToken"]').getAttribute('content')
  if (!token) throw new Error('Could not read ol-csrfToken from project page')
  return token
}

async function webApiRequest(page, csrfToken, method, path, data = undefined) {
  const response = await page.request.fetch(`${BASE_URL}/api/ai${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Csrf-Token': csrfToken,
    },
    data,
  })
  const text = await response.text()
  if (!response.ok()) {
    throw new Error(`HTTP ${response.status()} ${method} ${path}: ${text}`)
  }
  return text ? JSON.parse(text) : null
}

async function seedCompactionMessages(db, sessionId) {
  const { ObjectId } = await import('mongodb')
  const sessionObjectId = new ObjectId(sessionId)
  const now = new Date()
  await (await collection(db, 'aiMessages')).deleteMany({ sessionId: sessionObjectId })
  await (await collection(db, 'aiMessages')).insertMany([
    {
      sessionId: sessionObjectId,
      seq: 1,
      role: 'user',
      content: `${RUN_MARKER}: Please remember that I prefer concise Chinese progress updates.`,
      timestamp: now,
    },
    {
      sessionId: sessionObjectId,
      seq: 2,
      role: 'assistant',
      content: 'Understood.',
      timestamp: now,
    },
    {
      sessionId: sessionObjectId,
      seq: 3,
      role: 'user',
      content: 'This is a durable project convention for future agent work.',
      timestamp: now,
    },
    {
      sessionId: sessionObjectId,
      seq: 4,
      role: 'assistant',
      content: 'I will keep that project convention in mind.',
      timestamp: now,
    },
  ])
  await (await collection(db, 'aiSessions')).updateOne(
    { _id: sessionObjectId },
    {
      $set: {
        _nextSeq: 5,
        _latestSummarySeq: null,
        updatedAt: now,
      },
    }
  )
}

async function cleanupWebMode(db, sessionId, userId) {
  const { ObjectId } = await import('mongodb')
  const sessionObjectId = sessionId ? new ObjectId(sessionId) : null
  await Promise.all([
    sessionObjectId
      ? (await collection(db, 'aiSessions')).deleteOne({ _id: sessionObjectId })
      : Promise.resolve(),
    sessionObjectId
      ? (await collection(db, 'aiMessages')).deleteMany({ sessionId: sessionObjectId })
      : Promise.resolve(),
    sessionId
      ? (await collection(db, 'aiSessionSummaries')).deleteMany({ sessionId })
      : Promise.resolve(),
    sessionId
      ? (await collection(db, 'aiMemorySuggestions')).deleteMany({ sessionId })
      : Promise.resolve(),
    userId
      ? (await collection(db, 'aiMemories')).deleteMany({
          userId,
          content: { $regex: RUN_MARKER },
        })
      : Promise.resolve(),
  ])
}

// ========== Test Phases ==========

const INFLATE_PROMPTS = [
  '请列出项目中的所有文件。',
  '请读取 main.tex 并详细分析其结构，包括使用了哪些宏包、文档类、章节结构等。',
  '请读取项目中的参考文献文件（.bib），分析引用了哪些文献，并总结每篇文献的主题。',
  '请再次仔细阅读 main.tex 的摘要和引言部分，逐段分析其论证逻辑和写作质量。',
  '请分析 main.tex 中所有的数学公式和定理环境，解释每个公式的含义。',
  '请检查 main.tex 中的表格和图表引用，分析数据呈现是否清晰完整。',
  '请综合分析整篇论文的方法论部分，评估 CNN 和 Transformer 方法的对比是否充分。',
  '请详细审查论文的结论部分，分析其是否充分回应了引言中提出的研究问题。',
]

async function phaseInflate(sessionId) {
  console.log(`\n${C.bold}═══ Phase 1: Inflate (max ${MAX_ROUNDS} rounds) ═══${C.reset}\n`)

  let compactionTriggeredAt = null
  let compactionSuccess = false
  const filesDiscovered = []

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const prompt = INFLATE_PROMPTS[Math.min(round - 1, INFLATE_PROMPTS.length - 1)]
    console.log(`${C.cyan}[Round ${round}/${MAX_ROUNDS}]${C.reset} ${prompt.slice(0, 60)}...`)

    const { events, textContent } = await sendMessageSSE(sessionId, prompt)

    // Count events by type
    const counts = {}
    for (const e of events) {
      counts[e.type] = (counts[e.type] || 0) + 1
    }
    const toolCalls = events.filter(e => e.type === 'tool_call')
    const toolNames = toolCalls.map(e => e.toolCall?.function?.name || e.name || '?')

    console.log(`  ${C.dim}events: ${JSON.stringify(counts)} | tools: [${toolNames.join(', ')}] | text: ${textContent.length}c${C.reset}`)

    // Extract file paths from text for later verification
    const pathMatches = textContent.match(/[\w/.-]+\.(?:tex|bib|cls|sty|png|pdf|csv)/g) || []
    for (const p of pathMatches) {
      if (!filesDiscovered.includes(p)) filesDiscovered.push(p)
    }

    // Check for compaction events
    const hasCompactionStart = events.some(e => e.type === 'compaction_start')
    const compactionDone = events.find(e => e.type === 'compaction_done')
    const hasContextTruncated = events.some(e => e.type === 'context_truncated')

    if (hasCompactionStart) {
      console.log(`  ${C.magenta}⚡ Compaction triggered at round ${round}!${C.reset}`)
    }
    if (compactionDone) {
      compactionTriggeredAt = round
      compactionSuccess = compactionDone.success === true
      console.log(`  ${C.magenta}✓ Compaction done: success=${compactionSuccess}${C.reset}`)
    }
    if (hasContextTruncated) {
      console.log(`  ${C.red}⚠ Emergency context truncation occurred${C.reset}`)
    }

    // If compaction happened, we can move to phase 2
    if (compactionTriggeredAt) break
  }

  return { compactionTriggeredAt, compactionSuccess, filesDiscovered }
}

async function phaseVerifySummary(sessionId, filesDiscovered) {
  console.log(`\n${C.bold}═══ Phase 2: Verify Summary Quality ═══${C.reset}\n`)

  const prompt = '请总结一下我们之前讨论的内容，包括你读取了哪些文件、做了什么分析。'
  console.log(`${C.cyan}[Verify]${C.reset} ${prompt}`)

  const { textContent } = await sendMessageSSE(sessionId, prompt)

  console.log(`  ${C.dim}Response: ${textContent.length}c${C.reset}`)
  if (VERBOSE) console.log(`\n${textContent}\n`)

  // Check how many previously discovered files are mentioned in the summary response
  const mentionedFiles = filesDiscovered.filter(f => textContent.includes(f))
  const ratio = filesDiscovered.length > 0 ? mentionedFiles.length / filesDiscovered.length : 0

  console.log(`  Files mentioned: ${mentionedFiles.length}/${filesDiscovered.length} (${(ratio * 100).toFixed(0)}%)`)
  console.log(`  Mentioned: [${mentionedFiles.join(', ')}]`)

  return { textContent, mentionedFiles, ratio }
}

async function phaseDbCheck(sessionId) {
  console.log(`\n${C.bold}═══ Phase 3: MongoDB Verification ═══${C.reset}\n`)

  let client
  try {
    const { MongoClient, ObjectId } = await import('mongodb')
    client = new MongoClient(MONGO_URL)
    await client.connect()

    const dbName = new URL(MONGO_URL.replace('mongodb://', 'http://')).pathname.slice(1) || 'sharelatex'
    const database = client.db(dbName)
    const sessions = database.collection('aiSessions')
    const messagesCollection = database.collection('aiMessages')
    const summariesCollection = database.collection('aiSessionSummaries')

    const session = await sessions.findOne({ _id: new ObjectId(sessionId) })
    if (!session) {
      console.log(`  ${C.red}✗ Session not found in DB${C.reset}`)
      return {
        summaryInDb: false,
        durableSummaryInDb: false,
        summaryPreview: null,
        messageCount: 0,
      }
    }

    const sessionObjectId = new ObjectId(sessionId)
    const messageCount = await messagesCollection.countDocuments({
      sessionId: sessionObjectId,
    })
    const summaryMsg = await messagesCollection.findOne({
      sessionId: sessionObjectId,
      isSummary: true,
    }, {
      sort: { seq: -1 },
    })
    const durableSummary = await summariesCollection.findOne({
      sessionId,
      status: 'active',
    }, {
      sort: { createdAt: -1 },
    })

    console.log(`  Total messages in DB: ${messageCount}`)

    if (summaryMsg) {
      const preview = (summaryMsg.content || '').slice(0, 800)
      console.log(`  ${C.green}✓ Summary message found (isSummary: true)${C.reset}`)
      console.log(`  Compacted at: ${summaryMsg.compactedAt || 'N/A'}`)
      console.log(`  ${C.dim}Preview:${C.reset}`)
      console.log(`  ${C.dim}${preview}${C.reset}`)
      if (durableSummary) {
        console.log(`  ${C.green}✓ Durable summary found in aiSessionSummaries${C.reset}`)
        console.log(`  Source seq range: ${durableSummary.sourceMessageRange?.fromSeq ?? 0}-${durableSummary.sourceMessageRange?.toSeq ?? 0}`)
      } else {
        console.log(`  ${C.yellow}✗ No durable summary found in aiSessionSummaries${C.reset}`)
      }
      return {
        summaryInDb: true,
        durableSummaryInDb: Boolean(durableSummary),
        summaryPreview: preview,
        messageCount,
      }
    } else {
      console.log(`  ${C.yellow}✗ No summary message found (isSummary: true)${C.reset}`)
      return {
        summaryInDb: false,
        durableSummaryInDb: Boolean(durableSummary),
        summaryPreview: null,
        messageCount,
      }
    }
  } catch (err) {
    console.log(`  ${C.red}MongoDB error: ${err.message}${C.reset}`)
    return {
      summaryInDb: false,
      durableSummaryInDb: false,
      summaryPreview: null,
      messageCount: 0,
      error: err.message,
    }
  } finally {
    if (client) await client.close()
  }
}

// ========== Report ==========

function printReport(results) {
  const { inflate, verify, dbCheck } = results

  console.log(`\n${C.bold}${'═'.repeat(50)}${C.reset}`)
  console.log(`${C.bold}  Compaction Test Report${C.reset}`)
  console.log(`${'═'.repeat(50)}\n`)

  // Compaction triggered
  const triggered = inflate.compactionTriggeredAt != null
  const triggerIcon = triggered ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
  console.log(`  Rounds completed:        ${triggered ? inflate.compactionTriggeredAt : MAX_ROUNDS}`)
  console.log(`  Compaction triggered:     ${triggerIcon} ${triggered ? `(at round ${inflate.compactionTriggeredAt})` : '(not triggered)'}`)

  if (triggered) {
    const successIcon = inflate.compactionSuccess ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
    console.log(`  Compaction success:       ${successIcon}`)
  }

  // DB check
  const dbIcon = dbCheck.summaryInDb ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
  console.log(`  Summary saved to DB:      ${dbIcon} (isSummary: true)`)
  const durableIcon = dbCheck.durableSummaryInDb ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
  console.log(`  Durable summary saved:    ${durableIcon} (aiSessionSummaries)`)
  console.log(`  Messages in DB:           ${dbCheck.messageCount}`)

  if (dbCheck.summaryPreview) {
    console.log(`  Summary preview:`)
    const lines = dbCheck.summaryPreview.split('\n').slice(0, 5)
    for (const line of lines) {
      console.log(`    ${C.dim}${line}${C.reset}`)
    }
  }

  // Post-compaction continuity
  if (verify) {
    const contIcon = verify.ratio >= 0.3 ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
    console.log(`  Post-compaction continuity: ${contIcon}`)
    console.log(`    AI references: ${verify.mentionedFiles.join(', ')} (${verify.mentionedFiles.length}/${inflate.filesDiscovered.length} files)`)
  }

  // Final verdict
  console.log('')
  const pass = triggered &&
    inflate.compactionSuccess &&
    dbCheck.summaryInDb &&
    dbCheck.durableSummaryInDb
  const verdict = pass ? `${C.green}${C.bold}PASS${C.reset}` : `${C.red}${C.bold}FAIL${C.reset}`
  console.log(`  Result: ${verdict}`)
  console.log(`\n${'═'.repeat(50)}\n`)

  return pass
}

async function runWebProxyManualEndpointMode() {
  const { MongoClient } = await import('mongodb')
  const client = new MongoClient(MONGO_URL)
  await client.connect()
  const database = client.db(new URL(MONGO_URL.replace('mongodb://', 'http://')).pathname.slice(1) || 'sharelatex')
  let browser
  let user
  let originalHash
  let smokeHash
  let releaseLock
  let sessionId

  try {
    releaseLock = await acquireSmokeUserLock(database)
    user = await (await collection(database, 'users')).findOne({ email: EMAIL })
    if (!user) throw new Error(`Missing smoke user ${EMAIL}`)
    originalHash = user.hashedPassword
    smokeHash = bcrypt.hashSync(PASSWORD, 12)
    await (await collection(database, 'users')).updateOne(
      { _id: user._id },
      {
        $set: {
          hashedPassword: smokeHash,
          analyticsId: user.analyticsId || user._id.toString(),
        },
      }
    )

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await login(page)
    const csrfToken = await getCsrfToken(page)
    const sessionBody = await webApiRequest(page, csrfToken, 'POST', '/sessions', {
      projectId: PROJECT_ID,
      docId: DOC_ID,
      runtimeMode: 'agent-loop-v2',
    })
    sessionId = sessionBody.session.id
    await seedCompactionMessages(database, sessionId)
    await webApiRequest(page, csrfToken, 'POST', `/sessions/${sessionId}/compact`)

    const dbCheck = await phaseDbCheck(sessionId)
    const suggestions = await (await collection(database, 'aiMemorySuggestions'))
      .find({ sessionId, status: 'pending' })
      .toArray()
    const memories = await (await collection(database, 'aiMemories'))
      .find({
        userId: user._id.toString(),
        'createdFrom.sessionId': sessionId,
        status: { $ne: 'deleted' },
      })
      .toArray()
    const pass = dbCheck.summaryInDb &&
      dbCheck.durableSummaryInDb &&
      memories.length === 0
    console.log(`  Pending memory suggestions: ${suggestions.length}`)
    console.log(`  Memories created from compaction: ${memories.length}`)
    console.log(`  Result: ${pass ? C.green + C.bold + 'PASS' + C.reset : C.red + C.bold + 'FAIL' + C.reset}`)
    process.exitCode = pass ? 0 : 1
  } finally {
    if (browser) await browser.close().catch(() => {})
    await cleanupWebMode(database, sessionId, user?._id?.toString?.()).catch(() => {})
    await restorePassword(database, user, originalHash, smokeHash).catch(() => {})
    await releaseLock?.()
    await client.close()
  }
}

// ========== Main ==========

async function main() {
  if (WEB_PROXY_MODE) {
    await runWebProxyManualEndpointMode()
    return
  }

  console.log(`${'═'.repeat(50)}`)
  console.log(`  COMPACTION E2E STRESS TEST`)
  console.log(`${'═'.repeat(50)}`)
  console.log(`  Base URL:    ${BASE_URL}`)
  console.log(`  Project ID:  ${PROJECT_ID}`)
  console.log(`  Max rounds:  ${MAX_ROUNDS}`)
  console.log(`  Verbose:     ${VERBOSE}`)
  console.log(`  MongoDB:     ${MONGO_URL.replace(/\/\/[^@]*@/, '//***@')}`)
  console.log(`  Time:        ${new Date().toISOString()}`)
  console.log('')
  console.log(`  ${C.yellow}⚠ Ensure AI Agent is started with low thresholds:${C.reset}`)
  console.log(`  ${C.dim}CONTEXT_WINDOW=16000 COMPACTION_THRESHOLD=0.5 node app.js${C.reset}`)
  console.log('')

  // Health check
  try {
    const healthResp = await fetch(`${BASE_URL}/status`)
    const health = await healthResp.json()
    console.log(`  Health: ${health.status === 'ok' ? C.green + '✓ ok' : C.red + '✗ ' + JSON.stringify(health)}${C.reset}`)
  } catch (err) {
    console.error(`  ${C.red}✗ Cannot reach AI Agent at ${BASE_URL}: ${err.message}${C.reset}`)
    process.exit(1)
  }

  // Create session
  console.log('\n  Creating test session...')
  const sessionId = await createSession(PROJECT_ID)
  console.log(`  Session ID: ${sessionId}`)

  const results = { inflate: null, verify: null, dbCheck: null }

  try {
    // Phase 1: Inflate
    results.inflate = await phaseInflate(sessionId)

    // Phase 2: Verify summary (only if compaction happened)
    if (results.inflate.compactionTriggeredAt) {
      results.verify = await phaseVerifySummary(sessionId, results.inflate.filesDiscovered)
    } else {
      console.log(`\n${C.yellow}Skipping Phase 2 — compaction was not triggered in ${MAX_ROUNDS} rounds.${C.reset}`)
      console.log(`${C.yellow}Try increasing --rounds or lowering CONTEXT_WINDOW/COMPACTION_THRESHOLD.${C.reset}`)
    }

    // Phase 3: DB check
    results.dbCheck = await phaseDbCheck(sessionId)

    // Report
    const pass = printReport(results)
    process.exitCode = pass ? 0 : 1
  } finally {
    // Cleanup: delete test session
    console.log(`${C.dim}Cleaning up session ${sessionId}...${C.reset}`)
    await deleteSession(sessionId)
  }
}

main().catch(err => {
  console.error(`\n${C.red}FATAL: ${err.message}${C.reset}`)
  if (err.stack) console.error(C.dim + err.stack.split('\n').slice(1, 3).join('\n') + C.reset)
  process.exit(1)
})
