#!/usr/bin/env node

import { E2BSandboxProvider } from '../../app/js/sandbox/E2BSandboxProvider.js'

if (process.env.RUN_E2B_TESTS !== '1') {
  console.log('SKIP e2b sandbox smoke test: RUN_E2B_TESTS=1 is not set')
  process.exit(0)
}

if (!process.env.E2B_API_KEY) {
  console.log('SKIP e2b sandbox smoke test: E2B_API_KEY is not set')
  process.exit(0)
}

const provider = new E2BSandboxProvider({
  apiKey: process.env.E2B_API_KEY,
  template: process.env.AI_E2B_TEMPLATE || null,
  timeoutMs: 60000,
  maxOutputBytes: 1024 * 1024,
})

const session = await provider.createSession({ id: `smoke-${Date.now()}` })
try {
  await session.writeFile('main.tex', '\\section{E2B Smoke}\\n')
  const events = []
  for await (const event of session.run({
    command: ['sh', '-lc', 'cp main.tex edited.tex && rm main.tex'],
  })) {
    events.push(event)
  }
  const files = await session.listFiles('.')
  const edited = await session.readFile('edited.tex')
  if (!edited.toString('utf8').includes('E2B Smoke')) {
    throw new Error('edited.tex did not round-trip through E2B')
  }
  if (files.some(file => file.path === 'main.tex')) {
    throw new Error('deleted main.tex remained in local mirror')
  }
  console.log(`PASS e2b sandbox smoke test: ${events.length} events`)
} finally {
  await provider.destroySession(session.id).catch(() => {})
}
