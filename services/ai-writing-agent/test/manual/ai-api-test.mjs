#!/usr/bin/env node

/**
 * AI API Quick Test — 通过 Overleaf Web 代理测试 AI 功能
 *
 * 使用浏览器中的 overleaf.sid cookie 和 CSRF token 直接调用 AI API，
 * 无需额外登录流程。
 *
 * 凭证来源（优先级从高到低）：
 *   1. CLI 参数:  --sid=... --csrf=...
 *   2. 凭证文件:  test/manual/.credentials (JSON 格式, gitignored)
 *
 * 用法示例：
 *   # 保存凭证（仅需首次或凭证过期后执行）
 *   node test/manual/ai-api-test.mjs save-credentials \
 *     --sid='s%3ACdBY...' --csrf='T2JpDP2p-...'
 *
 *   # 健康检查
 *   node test/manual/ai-api-test.mjs health
 *
 *   # 创建会话
 *   node test/manual/ai-api-test.mjs create-session --project=<projectId>
 *
 *   # 发送消息（SSE 流式输出）
 *   node test/manual/ai-api-test.mjs send \
 *     --session=<sessionId> \
 *     --message="介绍一下项目" \
 *     --doc-id=<docId> --doc-path=main.tex
 *
 *   # 查看所有命令
 *   node test/manual/ai-api-test.mjs help
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CREDENTIALS_FILE = join(__dirname, '.credentials')

// ========== CLI Parsing ==========

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

// ========== Credentials ==========

function loadCredentials() {
  if (!existsSync(CREDENTIALS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function saveCredentials(creds) {
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + '\n')
}

function resolveCredentials(cliArgs) {
  const saved = loadCredentials()
  const sid = cliArgs.sid || saved.sid
  const csrf = cliArgs.csrf || saved.csrf
  const baseUrl = cliArgs['base-url'] || saved.baseUrl || 'http://localhost'

  if (!sid || !csrf) {
    console.error('Error: 缺少凭证。请先保存凭证：')
    console.error('')
    console.error('  node test/manual/ai-api-test.mjs save-credentials \\')
    console.error("    --sid='<overleaf.sid cookie 值>' \\")
    console.error("    --csrf='<X-Csrf-Token 值>'")
    console.error('')
    console.error('从浏览器 DevTools → Network 面板中复制这两个值。')
    process.exit(1)
  }

  return { sid, csrf, baseUrl }
}

// ========== HTTP Helpers ==========

function makeHeaders(creds, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Csrf-Token': creds.csrf,
    Cookie: `overleaf.sid=${creds.sid}`,
    ...extra,
  }
}

async function apiRequest(creds, method, path, body = null, options = {}) {
  const url = `${creds.baseUrl}/api/ai${path}`
  const headers = makeHeaders(creds, options.headers || {})

  const fetchOpts = { method, headers }
  if (body) fetchOpts.body = JSON.stringify(body)

  const resp = await fetch(url, fetchOpts)

  if (options.raw) return resp

  if (!resp.ok) {
    const text = await resp.text()
    console.error(`HTTP ${resp.status}: ${text}`)
    process.exit(1)
  }

  const contentType = resp.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return resp.json()
  }
  return resp.text()
}

// ========== SSE Stream Reader ==========

async function streamSSE(creds, path, body) {
  const url = `${creds.baseUrl}/api/ai${path}`
  const headers = makeHeaders(creds, { Accept: 'text/event-stream' })

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    console.error(`HTTP ${resp.status}: ${text}`)
    process.exit(1)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          console.log('\n--- [DONE] ---')
          return events
        }
        try {
          const event = JSON.parse(data)
          events.push(event)
          printEvent(event)
        } catch {
          // 忽略解析错误
        }
      }
    }
  }

  return events
}

function printEvent(event) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.content || '')
      break
    case 'thinking':
      process.stdout.write(`\x1b[2m${event.content || ''}\x1b[0m`)
      break
    case 'tool_call':
      console.log(`\n\x1b[36m[tool_call] ${event.name}(${JSON.stringify(event.arguments || {}).substring(0, 200)})\x1b[0m`)
      break
    case 'tool_result':
      console.log(`\x1b[33m[tool_result] ${(event.content || '').substring(0, 300)}\x1b[0m`)
      break
    case 'change':
      console.log(`\n\x1b[32m[change] ${event.changeId} — ${event.path}: "${(event.oldText || '').substring(0, 50)}" → "${(event.newText || '').substring(0, 50)}"\x1b[0m`)
      break
    case 'error':
      console.log(`\n\x1b[31m[error] ${event.message || JSON.stringify(event)}\x1b[0m`)
      break
    case 'done':
      console.log(`\n\x1b[34m[done]\x1b[0m`)
      break
    default:
      console.log(`\n[${event.type}] ${JSON.stringify(event).substring(0, 200)}`)
  }
}

// ========== Commands ==========

const commands = {
  help() {
    console.log(`
AI API Quick Test — 命令列表

凭证管理:
  save-credentials --sid=<SID> --csrf=<TOKEN> [--base-url=<URL>]
      保存凭证到 .credentials 文件（gitignored）

  check-credentials
      验证当前凭证是否有效

会话管理:
  health
      AI 服务健康检查

  create-session --project=<projectId> [--doc=<docId>]
      创建新的 AI 会话

  get-session --session=<sessionId>
      获取会话详情

  list-sessions --project=<projectId>
      列出项目的所有 AI 会话

  update-session --session=<sessionId> --title=<title>
      重命名会话

  delete-session --session=<sessionId>
      删除会话

消息:
  send --session=<sessionId> --message=<content> [--doc-id=<docId>] [--doc-path=<path>]
      发送消息并流式接收响应

  resume --session=<sessionId> [--doc-id=<docId>] [--doc-path=<path>]
      恢复中断的消息流

变更管理:
  accept-change --session=<sessionId> --change=<changeId>
      接受一个 pending change

  reject-change --session=<sessionId> --change=<changeId>
      拒绝一个 pending change

  accept-all --session=<sessionId>
      接受所有 pending changes

  reject-all --session=<sessionId>
      拒绝所有 pending changes

快速测试:
  quick-test --project=<projectId> [--doc-id=<docId>] [--doc-path=<path>]
      创建会话 → 发送测试消息 → 输出结果（一键完成）

选项:
  --sid=<SID>         overleaf.sid cookie 值
  --csrf=<TOKEN>      X-Csrf-Token 值
  --base-url=<URL>    Overleaf 地址 (默认: http://localhost)
`)
  },

  'save-credentials'(args) {
    if (!args.sid || !args.csrf) {
      console.error('用法: save-credentials --sid=<SID> --csrf=<TOKEN> [--base-url=<URL>]')
      process.exit(1)
    }
    const creds = {
      sid: args.sid,
      csrf: args.csrf,
      baseUrl: args['base-url'] || 'http://localhost',
      savedAt: new Date().toISOString(),
    }
    saveCredentials(creds)
    console.log('凭证已保存到 .credentials 文件')
    console.log(`  SID: ${creds.sid.substring(0, 20)}...`)
    console.log(`  CSRF: ${creds.csrf}`)
    console.log(`  Base URL: ${creds.baseUrl}`)
  },

  async 'check-credentials'(args) {
    const creds = resolveCredentials(args)
    try {
      const resp = await fetch(`${creds.baseUrl}/api/ai/health`, {
        headers: makeHeaders(creds),
      })
      if (resp.ok) {
        console.log('凭证有效 — AI 服务正常响应')
        const data = await resp.json().catch(() => null)
        if (data) console.log(JSON.stringify(data, null, 2))
      } else if (resp.status === 401 || resp.status === 302) {
        console.error('凭证已失效（401/302）— 请从浏览器重新获取')
        process.exit(1)
      } else {
        console.error(`意外的状态码: ${resp.status}`)
        const text = await resp.text()
        console.error(text.substring(0, 500))
      }
    } catch (err) {
      console.error(`连接失败: ${err.message}`)
      process.exit(1)
    }
  },

  async health(args) {
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'GET', '/health')
    console.log(JSON.stringify(data, null, 2))
  },

  async 'create-session'(args) {
    if (!args.project) {
      console.error('用法: create-session --project=<projectId> [--doc=<docId>]')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const body = { projectId: args.project }
    if (args.doc) body.docId = args.doc
    const data = await apiRequest(creds, 'POST', '/sessions', body)
    console.log(JSON.stringify(data, null, 2))
  },

  async 'get-session'(args) {
    if (!args.session) {
      console.error('用法: get-session --session=<sessionId>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'GET', `/sessions/${args.session}`)
    console.log(JSON.stringify(data, null, 2))
  },

  async 'list-sessions'(args) {
    if (!args.project) {
      console.error('用法: list-sessions --project=<projectId>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'GET', `/sessions?projectId=${args.project}`)
    console.log(JSON.stringify(data, null, 2))
  },

  async 'update-session'(args) {
    if (!args.session || !args.title) {
      console.error('用法: update-session --session=<sessionId> --title=<title>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'PUT', `/sessions/${args.session}`, { title: args.title })
    console.log(JSON.stringify(data, null, 2))
  },

  async 'delete-session'(args) {
    if (!args.session) {
      console.error('用法: delete-session --session=<sessionId>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'DELETE', `/sessions/${args.session}`)
    console.log('会话已删除')
    if (data) console.log(JSON.stringify(data, null, 2))
  },

  async send(args) {
    if (!args.session || !args.message) {
      console.error('用法: send --session=<sessionId> --message=<content> [--doc-id=<docId>] [--doc-path=<path>]')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const body = {
      content: args.message,
      context: {},
      stream: true,
    }
    if (args['doc-id']) body.context.currentDocId = args['doc-id']
    if (args['doc-path']) body.context.currentDocPath = args['doc-path']

    console.log(`发送消息到会话 ${args.session}...`)
    console.log(`内容: "${args.message}"`)
    console.log('---')
    await streamSSE(creds, `/sessions/${args.session}/messages`, body)
  },

  async resume(args) {
    if (!args.session) {
      console.error('用法: resume --session=<sessionId> [--doc-id=<docId>] [--doc-path=<path>]')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const body = {
      resume: true,
      context: {},
      stream: true,
    }
    if (args['doc-id']) body.context.currentDocId = args['doc-id']
    if (args['doc-path']) body.context.currentDocPath = args['doc-path']

    console.log(`恢复会话 ${args.session} 的消息流...`)
    console.log('---')
    await streamSSE(creds, `/sessions/${args.session}/messages`, body)
  },

  async 'accept-change'(args) {
    if (!args.session || !args.change) {
      console.error('用法: accept-change --session=<sessionId> --change=<changeId>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'POST', `/sessions/${args.session}/changes/${args.change}/accept`)
    console.log(JSON.stringify(data, null, 2))
  },

  async 'reject-change'(args) {
    if (!args.session || !args.change) {
      console.error('用法: reject-change --session=<sessionId> --change=<changeId>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'POST', `/sessions/${args.session}/changes/${args.change}/reject`)
    console.log(JSON.stringify(data, null, 2))
  },

  async 'accept-all'(args) {
    if (!args.session) {
      console.error('用法: accept-all --session=<sessionId>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'POST', `/sessions/${args.session}/changes/accept-all`)
    console.log(JSON.stringify(data, null, 2))
  },

  async 'reject-all'(args) {
    if (!args.session) {
      console.error('用法: reject-all --session=<sessionId>')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const data = await apiRequest(creds, 'POST', `/sessions/${args.session}/changes/reject-all`)
    console.log(JSON.stringify(data, null, 2))
  },

  async 'quick-test'(args) {
    if (!args.project) {
      console.error('用法: quick-test --project=<projectId> [--doc-id=<docId>] [--doc-path=<path>] [--message=<msg>]')
      process.exit(1)
    }
    const creds = resolveCredentials(args)
    const message = args.message || '你好，请介绍一下这个项目的文档结构。'

    // Step 1: Create session
    console.log('1. 创建会话...')
    const sessionData = await apiRequest(creds, 'POST', '/sessions', { projectId: args.project })
    const sessionId = sessionData.session?._id || sessionData.session?.id
    console.log(`   会话 ID: ${sessionId}`)

    // Step 2: Send message
    console.log(`\n2. 发送消息: "${message}"`)
    console.log('---')
    const body = {
      content: message,
      context: {},
      stream: true,
    }
    if (args['doc-id']) body.context.currentDocId = args['doc-id']
    if (args['doc-path']) body.context.currentDocPath = args['doc-path']

    await streamSSE(creds, `/sessions/${sessionId}/messages`, body)

    console.log(`\n---\n会话 ID: ${sessionId}`)
    console.log('后续可用:')
    console.log(`  node test/manual/ai-api-test.mjs send --session=${sessionId} --message="你的问题"`)
    console.log(`  node test/manual/ai-api-test.mjs get-session --session=${sessionId}`)
    console.log(`  node test/manual/ai-api-test.mjs delete-session --session=${sessionId}`)
  },
}

// ========== Main ==========

const { command, args } = parseCliArgs()

if (!command || !commands[command]) {
  if (command) console.error(`未知命令: ${command}\n`)
  commands.help()
  process.exit(command ? 1 : 0)
}

Promise.resolve(commands[command](args)).catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
