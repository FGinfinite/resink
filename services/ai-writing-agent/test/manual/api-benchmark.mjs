#!/usr/bin/env node

/**
 * AI API 渠道基准测试工具
 *
 * 用于评估新渠道/新模型的 API 性能指标。
 * 直接调用 LLM API（不经过 Overleaf），测试 API 层面的能力极限。
 *
 * 配置来源（优先级从高到低）：
 *   1. CLI 参数:  --api-base=... --api-key=... --model=... --proxy=...
 *   2. 环境变量:  OPENAI_API_BASE, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_PROXY
 *   3. .env 文件: 自动从 services/ai-writing-agent/.env 读取
 *
 * 子命令：
 *   burst       突发并发测试 — 同时发送 N 个请求，测量最大瞬时并发
 *   rpm         持续 RPM 测试 — 以固定速率持续发送，揭示令牌桶/欠债机制
 *   probe       响应质量探针 — 使用完整系统提示词+工具定义，检测空响应等异常
 *
 * 用法示例：
 *   # 使用 .env 默认配置
 *   node test/manual/api-benchmark.mjs burst
 *   node test/manual/api-benchmark.mjs rpm
 *   node test/manual/api-benchmark.mjs probe
 *
 *   # 指定模型和渠道
 *   node test/manual/api-benchmark.mjs burst \
 *     --api-base=https://api.openai.com/v1 --api-key=sk-xxx --model=gpt-4o
 *
 *   # 自定义参数
 *   node test/manual/api-benchmark.mjs burst --levels=1,5,10,20,50
 *   node test/manual/api-benchmark.mjs rpm --rpm=60 --duration=120
 *   node test/manual/api-benchmark.mjs probe --attempts=10 --delay=5000
 */

import { readFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const serviceRoot = join(__dirname, '..', '..')

// ========== Configuration ==========

function parseCliArgs() {
  const args = {}
  let command = null
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([a-z-]+)=(.+)$/i)
    if (match) {
      args[match[1]] = match[2]
    } else if (!arg.startsWith('-') && !command) {
      command = arg
    }
  }
  return { command, args }
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

function resolve(cliKey, envKey, fallback) {
  return cli.args[cliKey] || process.env[envKey] || dotenv[envKey] || fallback
}

const API_BASE = resolve('api-base', 'OPENAI_API_BASE', 'https://api.openai.com/v1')
const API_KEY = resolve('api-key', 'OPENAI_API_KEY', '')
const MODEL = resolve('model', 'OPENAI_MODEL', 'gpt-4o')
const PROXY_URL = resolve('proxy', 'OPENAI_PROXY', '')
const MAX_TOKENS_DEFAULT = Number(resolve('max-tokens', 'OPENAI_MAX_TOKENS', '256000'))

// ========== Proxy Setup ==========

let proxyAgent = null
let fetchFn = globalThis.fetch

async function setupProxy() {
  if (!PROXY_URL) return
  try {
    const undici = await import('undici')
    proxyAgent = new undici.ProxyAgent(PROXY_URL)
    fetchFn = undici.fetch
  } catch {
    console.warn('Warning: undici not available, proxy will not be used')
  }
}

function proxyFetch(url, opts = {}) {
  if (proxyAgent) {
    return fetchFn(url, { ...opts, dispatcher: proxyAgent })
  }
  return fetchFn(url, opts)
}

// ========== Shared Helpers ==========

function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function printConfig(extra = {}) {
  console.log(`API:    ${API_BASE}`)
  console.log(`Model:  ${MODEL}`)
  console.log(`Proxy:  ${PROXY_URL || '(direct)'}`)
  for (const [k, v] of Object.entries(extra)) {
    console.log(`${k.padEnd(8)}${v}`)
  }
  console.log()
}

async function warmup() {
  process.stdout.write('预热中...')
  const start = Date.now()
  const result = await sendMinimalRequest(0)
  if (!result.ok) {
    console.error(`\n预热失败: ${result.error}`)
    process.exit(1)
  }
  console.log(` OK (${Date.now() - start}ms)`)
  return result
}

/**
 * Send a minimal (non-streaming) request for throughput tests
 */
async function sendMinimalRequest(id) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  const start = Date.now()

  try {
    const res = await proxyFetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: `Say "ok ${id}"` }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: controller.signal,
    })

    const elapsed = Date.now() - start

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, status: res.status, elapsed, error: body.slice(0, 200) }
    }

    const data = await res.json()
    return { ok: true, status: res.status, elapsed, reply: data.choices?.[0]?.message?.content?.slice(0, 50) }
  } catch (err) {
    return { ok: false, status: 0, elapsed: Date.now() - start, error: err.name === 'AbortError' ? 'TIMEOUT' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send a streaming request and parse the SSE stream.
 * Returns { ok, status, content, finishReason, toolCalls, lineCount, elapsed, rawLines }
 */
async function sendStreamingRequest(messages, opts = {}) {
  const {
    tools = null,
    maxTokens = MAX_TOKENS_DEFAULT,
    temperature = 0.5,
    logLines = false,
  } = opts

  const body = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  }
  if (tools) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  const start = Date.now()

  try {
    const res = await proxyFetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const elapsed = () => Date.now() - start

    if (logLines) {
      console.log(`HTTP Status: ${res.status}`)
      console.log(`Headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`)
      console.log()
    }

    if (!res.ok) {
      const text = await res.text()
      return { ok: false, status: res.status, error: text.slice(0, 200), elapsed: elapsed() }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let finishReason = null
    let lineCount = 0
    const toolCalls = []
    const rawLines = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        lineCount++

        if (trimmed === 'data: [DONE]') {
          if (logLines) console.log(`[LINE ${lineCount}] ${trimmed}`)
          continue
        }

        if (!trimmed.startsWith('data: ')) {
          if (logLines) console.log(`[LINE ${lineCount}] (non-data) ${trimmed}`)
          continue
        }

        const jsonStr = trimmed.slice(6)
        rawLines.push(jsonStr.slice(0, 500))
        if (rawLines.length > 5) rawLines.shift()

        try {
          const chunk = JSON.parse(jsonStr)
          const d = chunk.choices?.[0]?.delta
          const fr = chunk.choices?.[0]?.finish_reason

          if (logLines) {
            const info = []
            if (d?.role) info.push(`role=${d.role}`)
            if (d?.content) info.push(`content="${d.content.slice(0, 80)}"`)
            if (d?.tool_calls) info.push('tool_calls=yes')
            if (fr) info.push(`finish_reason=${fr}`)
            if (d && Object.keys(d).length === 0) info.push('delta={}')
            if (!d && !fr) info.push('no-delta')
            console.log(`[LINE ${lineCount}] ${info.join(', ') || 'empty'} | raw=${jsonStr.slice(0, 200)}`)
          }

          if (d?.content) content += d.content
          if (d?.tool_calls) {
            for (const tc of d.tool_calls) {
              const idx = tc.index
              if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', name: tc.function?.name || '', args: '' }
              if (tc.function?.name) toolCalls[idx].name = tc.function.name
              if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments
              if (tc.id) toolCalls[idx].id = tc.id
            }
          }
          if (fr) finishReason = fr
        } catch (e) {
          if (logLines) console.log(`[LINE ${lineCount}] PARSE_ERROR: ${e.message}`)
        }
      }
    }

    return {
      ok: true,
      content,
      finishReason,
      toolCalls: toolCalls.filter(Boolean),
      lineCount,
      elapsed: elapsed(),
      rawLines,
      empty: !content && toolCalls.length === 0,
    }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'TIMEOUT' : err.message, elapsed: Date.now() - start }
  } finally {
    clearTimeout(timer)
  }
}

// ========== Sub-command: burst ==========

async function cmdBurst() {
  const levelsStr = cli.args.levels || '1,2,5,10,15,20,30,50,75,100'
  const levels = levelsStr.split(',').map(Number).filter(n => n > 0)

  console.log('突发并发测试')
  printConfig({ 'Levels:': levels.join(', ') })

  await warmup()

  const summary = []

  for (const n of levels) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`并发数: ${n}`)
    console.log('='.repeat(60))

    const start = Date.now()
    const promises = Array.from({ length: n }, (_, i) => sendMinimalRequest(i + 1))
    const results = await Promise.all(promises)
    const totalElapsed = Date.now() - start

    const succeeded = results.filter(r => r.ok)
    const failed = results.filter(r => !r.ok)
    const latencies = results.map(r => r.elapsed)
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    const maxLatency = Math.max(...latencies)
    const minLatency = Math.min(...latencies)

    console.log(`成功: ${succeeded.length}/${n}  失败: ${failed.length}/${n}`)
    console.log(`总耗时: ${totalElapsed}ms  平均延迟: ${avgLatency}ms  最小: ${minLatency}ms  最大: ${maxLatency}ms`)

    if (failed.length > 0) {
      const errorGroups = {}
      for (const f of failed) {
        const key = f.status === 0 ? f.error : `HTTP ${f.status}`
        errorGroups[key] = (errorGroups[key] || 0) + 1
      }
      console.log('错误分布:', JSON.stringify(errorGroups))
    }

    summary.push({ n, succeeded: succeeded.length, failed: failed.length, totalElapsed, avgLatency, maxLatency, minLatency })

    if (succeeded.length === 0) {
      console.log('\n全部请求失败，终止测试。')
      break
    }

    await delay(2000)
  }

  // Summary table
  console.log('\n' + '='.repeat(70))
  console.log('汇总结果')
  console.log('='.repeat(70))
  console.log('并发数 | 成功 | 失败 | 总耗时(ms) | 平均延迟(ms) | 最大延迟(ms)')
  console.log('-'.repeat(70))
  for (const s of summary) {
    console.log(
      `${String(s.n).padStart(6)} | ${String(s.succeeded).padStart(4)} | ${String(s.failed).padStart(4)} | ${String(s.totalElapsed).padStart(10)} | ${String(s.avgLatency).padStart(12)} | ${String(s.maxLatency).padStart(12)}`
    )
  }

  const maxStable = [...summary].reverse().find(s => s.failed === 0)
  if (maxStable) console.log(`\n最大稳定并发数（100% 成功）: ${maxStable.n}`)

  const firstFail = summary.find(s => s.failed > 0)
  if (firstFail) console.log(`首次出现错误的并发数: ${firstFail.n} (失败率 ${Math.round((firstFail.failed / firstFail.n) * 100)}%)`)
}

// ========== Sub-command: rpm ==========

async function cmdRpm() {
  const targetRpm = Number(cli.args.rpm || '120')
  const durationSec = Number(cli.args.duration || '180')
  const bucketSec = Number(cli.args.bucket || '10')
  const intervalMs = 60_000 / targetRpm

  console.log('持续 RPM 测试')
  printConfig({
    'RPM:': `${targetRpm} (每 ${intervalMs.toFixed(0)}ms 发一个)`,
    'Duration:': `${durationSec}s`,
    'Bucket:': `${bucketSec}s`,
  })

  await warmup()

  const buckets = []
  let globalStart = Date.now()
  let requestSeq = 0
  let totalOk = 0
  let totalFail = 0
  let inflight = 0

  function getBucket(ts) {
    const elapsed = ts - globalStart
    const idx = Math.floor(elapsed / (bucketSec * 1000))
    if (!buckets[idx]) {
      buckets[idx] = { index: idx, start: idx * bucketSec, end: (idx + 1) * bucketSec, sent: 0, ok: 0, fail: 0, errors: {}, latencies: [] }
    }
    return buckets[idx]
  }

  const allPromises = []

  // Reset
  globalStart = Date.now()

  await new Promise(resolve => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - globalStart
      if (elapsed >= durationSec * 1000) {
        clearInterval(timer)
        resolve()
        return
      }

      requestSeq++
      inflight++
      const id = requestSeq
      const sendTime = Date.now()
      const bucket = getBucket(sendTime)
      bucket.sent++

      const p = sendMinimalRequest(id).then(r => {
        inflight--
        const respBucket = getBucket(sendTime)
        respBucket.latencies.push(r.elapsed)
        if (r.ok) { respBucket.ok++; totalOk++ }
        else {
          respBucket.fail++; totalFail++
          const key = r.status === 0 ? r.error : `HTTP ${r.status}`
          respBucket.errors[key] = (respBucket.errors[key] || 0) + 1
        }
      })
      allPromises.push(p)

      if (requestSeq % Math.max(1, Math.round(targetRpm / 60)) === 0) {
        const pct = totalOk + totalFail > 0 ? Math.round((totalOk / (totalOk + totalFail)) * 100) : '-'
        process.stdout.write(
          `\r[${String(Math.round(elapsed / 1000)).padStart(3)}s] 已发送: ${requestSeq} | 进行中: ${inflight} | 成功: ${totalOk} | 失败: ${totalFail} | 成功率: ${pct}%   `
        )
      }
    }, intervalMs)
  })

  process.stdout.write('\n\n等待剩余请求完成...')
  await Promise.all(allPromises)
  console.log(' 完成\n')

  // Results
  const totalSent = buckets.reduce((s, b) => s + (b?.sent || 0), 0)
  const totalSuccess = buckets.reduce((s, b) => s + (b?.ok || 0), 0)
  const totalFailures = buckets.reduce((s, b) => s + (b?.fail || 0), 0)

  console.log('='.repeat(90))
  console.log(`时间线（每 ${bucketSec}s 一个桶）`)
  console.log('='.repeat(90))
  console.log('时间段(s)  | 发送 | 成功 | 失败 | 成功率  | 平均延迟(ms) | P95延迟(ms) | 错误')
  console.log('-'.repeat(90))

  for (const b of buckets) {
    if (!b) continue
    const rate = b.ok + b.fail > 0 ? `${Math.round((b.ok / (b.ok + b.fail)) * 100)}%` : '-'
    const sorted = [...b.latencies].sort((a, c) => a - c)
    const avg = sorted.length > 0 ? Math.round(sorted.reduce((a, c) => a + c, 0) / sorted.length) : '-'
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : '-'
    const errs = Object.keys(b.errors).length > 0 ? JSON.stringify(b.errors) : ''
    console.log(
      `${String(b.start).padStart(4)}-${String(b.end).padStart(3)}s | ${String(b.sent).padStart(4)} | ${String(b.ok).padStart(4)} | ${String(b.fail).padStart(4)} | ${String(rate).padStart(6)}  | ${String(avg).padStart(12)} | ${String(p95).padStart(11)} | ${errs}`
    )
  }

  console.log('\n' + '='.repeat(90))
  console.log('汇总')
  console.log('='.repeat(90))
  console.log(`总请求数:     ${totalSent}`)
  console.log(`总成功:       ${totalSuccess}`)
  console.log(`总失败:       ${totalFailures}`)
  console.log(`总成功率:     ${totalSent > 0 ? Math.round((totalSuccess / totalSent) * 100) : 0}%`)
  console.log(`实际 RPM:     ~${Math.round((totalSuccess / durationSec) * 60)}`)
  console.log(`目标 RPM:     ${targetRpm}`)

  // Degradation detection
  const half = Math.floor(buckets.length / 2)
  const firstHalf = buckets.slice(0, half).filter(Boolean)
  const secondHalf = buckets.slice(half).filter(Boolean)

  const halfRate = (arr) => {
    const ok = arr.reduce((s, b) => s + b.ok, 0)
    const total = arr.reduce((s, b) => s + b.ok + b.fail, 0)
    return total > 0 ? ok / total : 1
  }

  const r1 = halfRate(firstHalf)
  const r2 = halfRate(secondHalf)
  console.log(`\n前半段成功率: ${(r1 * 100).toFixed(1)}%`)
  console.log(`后半段成功率: ${(r2 * 100).toFixed(1)}%`)

  if (r2 < r1 - 0.05) {
    console.log(`\n检测到衰减！后半段比前半段低 ${((r1 - r2) * 100).toFixed(1)}%`)
    console.log('该 API 可能存在欠债/令牌桶机制：初始允许突发，之后限流。')
  } else if (totalFailures === 0) {
    console.log(`\n全程 ${targetRpm} RPM 无失败，真实 RPM 上限可能更高。`)
  } else {
    console.log(`\n成功率前后一致，无明显欠债机制（在 ${targetRpm} RPM 下）。`)
  }
}

// ========== Sub-command: probe ==========

async function cmdProbe() {
  const attempts = Number(cli.args.attempts || '5')
  const delayMs = Number(cli.args.delay || '3000')
  const userMessage = cli.args.message || '英国首都何处'
  const verbose = cli.args.verbose === 'true'

  console.log('响应质量探针')

  // Load real system prompt
  const TEMPLATES_DIR = join(serviceRoot, 'app/js/prompt/templates')
  const templates = ['base', 'academic', 'tools', 'safety']
  const parts = []
  for (const name of templates) {
    try {
      parts.push(await readFile(join(TEMPLATES_DIR, `${name}.txt`), 'utf-8'))
    } catch { /* skip */ }
  }
  parts.push(`# Project Context\nDate: ${new Date().toISOString().slice(0, 10)}\nProject: test-project`)
  const systemPrompt = parts.join('\n\n---\n\n')

  const TOOLS = [
    { type: 'function', function: { name: 'read_document', description: 'Read a document.', parameters: { type: 'object', properties: { path: { type: 'string' }, maxLines: { type: 'number' }, section: { type: 'string' } }, required: [] } } },
    { type: 'function', function: { name: 'edit_document', description: 'Edit a document.', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['oldText', 'newText'] } } },
    { type: 'function', function: { name: 'delete_file', description: 'Delete a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List project files.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, type: { type: 'string' } }, required: [] } } },
  ]

  printConfig({
    'Prompt:': `${systemPrompt.length} chars`,
    'Attempts:': attempts,
    'Delay:': `${delayMs}ms`,
    'Message:': `"${userMessage}"`,
  })

  const results = []

  for (let i = 1; i <= attempts; i++) {
    console.log(`\n${'#'.repeat(60)}`)
    console.log(`# Attempt ${i}/${attempts}`)
    console.log('#'.repeat(60))

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[Current document: main.tex]\n\n${userMessage}` },
    ]

    const r = await sendStreamingRequest(messages, {
      tools: TOOLS,
      logLines: verbose,
    })

    if (!r.ok) {
      console.log(`  ERROR: ${r.error}`)
      results.push({ attempt: i, ok: false, error: r.error })
    } else {
      const status = r.empty ? 'EMPTY' : 'OK'
      console.log(`  ${status} | content=${r.content?.length || 0}c | finish_reason=${r.finishReason} | lines=${r.lineCount} | ${r.elapsed}ms`)
      if (r.content) console.log(`  Content: "${r.content.slice(0, 120)}"`)
      if (r.toolCalls.length > 0) console.log(`  Tool calls: ${JSON.stringify(r.toolCalls)}`)
      if (r.empty) console.log(`  Raw lines: ${JSON.stringify(r.rawLines)}`)
      results.push({ attempt: i, ...r })
    }

    if (i < attempts) await delay(delayMs)
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log('汇总')
  console.log('='.repeat(60))
  for (const r of results) {
    const s = !r.ok ? 'ERROR' : r.empty ? 'EMPTY' : 'OK'
    console.log(`  #${r.attempt}: ${s} | content=${r.content?.length || 0}c | finish_reason=${r.finishReason || 'N/A'} | ${r.elapsed || 0}ms`)
  }

  const okCount = results.filter(r => r.ok && !r.empty).length
  const emptyCount = results.filter(r => r.ok && r.empty).length
  const errorCount = results.filter(r => !r.ok).length

  console.log(`\n有效响应: ${okCount}/${attempts}  空响应: ${emptyCount}/${attempts}  错误: ${errorCount}/${attempts}`)

  if (emptyCount > 0) {
    console.log(`\n空响应率 ${Math.round((emptyCount / attempts) * 100)}% — API 端可能存在限流或降级行为。`)
    console.log('空响应特征: HTTP 200 + SSE 流仅含 "data: [DONE]"，无 delta chunk，finish_reason=null')
  }
}

// ========== Help ==========

function showHelp() {
  console.log(`
AI API 渠道基准测试工具

子命令:
  burst       突发并发测试 — 测量最大瞬时并发能力
  rpm         持续 RPM 测试 — 揭示令牌桶/欠债机制
  probe       响应质量探针 — 使用完整系统提示词检测空响应等异常

公共选项:
  --api-base=<URL>    API 端点 (default: from .env)
  --api-key=<KEY>     API Key (default: from .env)
  --model=<MODEL>     模型名 (default: from .env)
  --proxy=<URL>       HTTP 代理 (default: from .env OPENAI_PROXY)

burst 选项:
  --levels=1,5,10,20  并发梯度 (default: 1,2,5,10,15,20,30,50,75,100)

rpm 选项:
  --rpm=120            目标 RPM (default: 120)
  --duration=180       持续秒数 (default: 180)
  --bucket=10          统计桶秒数 (default: 10)

probe 选项:
  --attempts=5         测试次数 (default: 5)
  --delay=3000         请求间隔 ms (default: 3000)
  --message="..."      测试消息 (default: "英国首都何处")
  --verbose=true       输出原始 SSE 行 (default: false)

示例:
  node test/manual/api-benchmark.mjs burst
  node test/manual/api-benchmark.mjs rpm --rpm=60 --duration=60
  node test/manual/api-benchmark.mjs probe --attempts=10 --verbose=true
  node test/manual/api-benchmark.mjs burst --api-base=https://new-api.com/v1 --api-key=sk-xxx --model=gpt-4o
`)
}

// ========== Main ==========

async function main() {
  const { command } = cli

  if (!command || command === 'help') {
    showHelp()
    process.exit(0)
  }

  await setupProxy()

  switch (command) {
    case 'burst':
      await cmdBurst()
      break
    case 'rpm':
      await cmdRpm()
      break
    case 'probe':
      await cmdProbe()
      break
    default:
      console.error(`未知命令: ${command}`)
      showHelp()
      process.exit(1)
  }
}

main().catch(err => {
  console.error('FATAL:', err.message)
  process.exit(1)
})
