#!/usr/bin/env node

/* eslint-disable no-console */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DockerUvBrokerRunner } from '../../app/js/python/DockerUvBrokerRunner.js'
import { QuarantineUvWorker } from '../../app/js/python/QuarantineUvWorker.js'

const BROKER_IMAGE = process.env.AI_PYTHON_DEPENDENCY_BROKER_DOCKER_IMAGE ||
  'resink-uv-broker:dev'

function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timer = null
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
    const append = (previous, chunk) => {
      const next = Buffer.concat([previous, chunk])
      if (next.length > maxOutputBytes) {
        child.kill('SIGKILL')
        return next.subarray(0, maxOutputBytes)
      }
      return next
    }

    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk)
    })
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: error.code === 'ENOENT' ? 127 : 1,
        stdout,
        stderr: Buffer.from(error.message),
      })
    })
    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      timer.unref?.()
    }
    child.on('close', exitCode => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

async function dockerAvailable() {
  const result = await runCommand('docker', ['info'], {
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024,
  })
  return result.exitCode === 0
}

async function docker(args, options = {}) {
  const result = await runCommand('docker', args, {
    timeoutMs: options.timeoutMs ?? 15000,
    maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
  })
  if (options.allowFailure) return result
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed:\n${result.stderr.toString('utf-8')}`
    )
  }
  return result
}

async function main() {
  if (!(await dockerAvailable())) {
    console.log('SKIP: Docker is not available; broker proxy smoke not run.')
    return
  }

  const suffix = `${process.pid}-${Date.now()}`
  const networkName = `resink-broker-proxy-${suffix}`
  const proxyName = `resink-broker-proxy-${suffix}`
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'resink-uv-broker-'))

  try {
    await writeFile(
      path.join(workspace, 'proxy_probe.py'),
      `from urllib.request import urlopen

with urlopen("http://pypi-proxy:8080/simple", timeout=5) as response:
    body = response.read().decode("utf-8")

assert "simple-index-ok" in body, body
print("proxy reachable")
`,
      'utf-8'
    )
    await writeFile(
      path.join(workspace, 'egress_probe.py'),
      `from urllib.request import urlopen
from urllib.error import URLError

try:
    urlopen("https://pypi.org/simple", timeout=5)
except URLError as error:
    print(type(error).__name__)
else:
    raise SystemExit("public egress unexpectedly succeeded")
`,
      'utf-8'
    )

    await docker(['network', 'create', '--internal', networkName])
    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      proxyName,
      '--network',
      networkName,
      '--network-alias',
      'pypi-proxy',
      'python:3.12-slim-bookworm',
      'python',
      '-m',
      'http.server',
      '8080',
      '--bind',
      '0.0.0.0',
      '--directory',
      '/tmp',
    ])
    await docker([
      'exec',
      proxyName,
      'sh',
      '-lc',
      'mkdir -p /tmp/simple && printf "%s\\n" simple-index-ok > /tmp/simple/index.html',
    ])

    const runner = new DockerUvBrokerRunner({
      image: BROKER_IMAGE,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyNetwork: networkName,
    })
    const proxyProbe = await runner.run('python', ['proxy_probe.py'], {
      cwd: workspace,
      env: {
        HOME: workspace,
        UV_INDEX_URL: 'http://pypi-proxy:8080/simple',
      },
      networkPolicy: 'package-index-proxy',
      timeoutMs: 15000,
      maxOutputBytes: 64 * 1024,
    })
    if (proxyProbe.exitCode !== 0) {
      throw new Error(proxyProbe.stderr.toString('utf-8') || 'proxy probe failed')
    }

    const egressProbe = await runner.run('python', ['egress_probe.py'], {
      cwd: workspace,
      env: {
        HOME: workspace,
        UV_INDEX_URL: 'http://pypi-proxy:8080/simple',
      },
      networkPolicy: 'package-index-proxy',
      timeoutMs: 15000,
      maxOutputBytes: 64 * 1024,
    })
    if (egressProbe.exitCode !== 0) {
      throw new Error(
        egressProbe.stderr.toString('utf-8') ||
        egressProbe.stdout.toString('utf-8') ||
        'egress probe failed'
      )
    }
    const uvWorker = new QuarantineUvWorker({
      runner,
      networkPolicy: 'package-index-proxy',
      packageIndexProxyUrl: 'http://pypi-proxy:8080/simple',
    })
    const uvProbe = await uvWorker.resolve({
      mode: 'project-lock',
      request: {
        scope: 'project',
        requestedPackages: [],
      },
      files: [{
        path: 'pyproject.toml',
        content: '[project]\nname = "broker-proxy-smoke"\nversion = "0.0.0"\ndependencies = []\n',
      }],
    })
    if (!uvProbe.ok) {
      throw new Error(`uv proxy probe failed: ${JSON.stringify(uvProbe.error || {})}`)
    }

    console.log(`broker image: ${BROKER_IMAGE}`)
    console.log(`proxy network: ${networkName}`)
    console.log(proxyProbe.stdout.toString('utf-8').trim())
    console.log(`public egress denied: ${egressProbe.stdout.toString('utf-8').trim()}`)
    console.log(`uv proxy lock: ${uvProbe.status} ${uvProbe.uvVersion}`)
  } finally {
    await docker(['rm', '-f', proxyName], { allowFailure: true }).catch(() => {})
    await docker(['network', 'rm', networkName], { allowFailure: true }).catch(() => {})
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
