import crypto from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { validateProjectPath, projectPathToWorkspaceRelative } from '../util/project-path.js'
import { WorkspaceCommandService } from '../sandbox/WorkspaceCommandService.js'
import { db } from '../mongodb.js'

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_LOG_CHARS = 12000
const ARTIFACT_GLOBS = ['*.pdf', '*.log', '*.fls', '*.fdb_latexmk', '*.aux']
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,})/g

const compileLatexSchema = z.object({
  entry_file: z
    .string()
    .optional()
    .default('main.tex')
    .describe('Workspace-relative LaTeX entry file to compile, for example "main.tex".'),
  engine: z
    .enum(['pdf', 'xelatex', 'lualatex'])
    .optional()
    .default('pdf')
    .describe('latexmk output engine: pdf (pdflatex), xelatex, or lualatex.'),
  timeout_ms: z
    .number()
    .int()
    .min(10000)
    .max(300000)
    .optional()
    .default(DEFAULT_TIMEOUT_MS)
    .describe('Compile timeout in milliseconds.'),
})

export class CompileLatexTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'compile_latex',
      description: `Compile a LaTeX project inside the persistent workspace using latexmk.
Runs against workspace files only; it never mutates canonical Overleaf documents.
Returns bounded stdout/stderr/log excerpts and stores PDF/log artifacts for authenticated download.`,
      parameters: compileLatexSchema,
    })
    this.commandService = options.commandService || new WorkspaceCommandService()
    this.artifactsCollection = options.artifactsCollection || db.aiSandboxArtifacts
    this.now = options.now || (() => new Date())
    this.artifactTtlMs = options.artifactTtlMs || 24 * 60 * 60 * 1000
  }

  async execute(args, context) {
    const sandboxSession = context.persistentWorkspace?.sandboxSession
    if (!sandboxSession) {
      return ToolResult.error(
        'compile_latex requires a persistent workspace. Start or resume an AgentLoopV2 workspace before compiling.'
      )
    }

    const entryPath = normalizeEntryPath(args.entry_file || 'main.tex')
    if (entryPath.error) return ToolResult.error(entryPath.error)

    const command = buildLatexmkCommand({
      entryFile: entryPath.workspacePath,
      engine: args.engine || 'pdf',
    })

    try {
      const commandResult = await this.commandService.run({
        command,
        timeout_ms: args.timeout_ms || DEFAULT_TIMEOUT_MS,
        max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
      }, context)
      const stdout = redact(commandResult.stdout)
      const stderr = redact(commandResult.stderr)
      const compileSucceeded = commandResult.exitCode === 0
      const artifactRefs = await this.storeArtifacts({
        sessionId: context.sessionId,
        sandboxSession,
        entryFile: entryPath.workspacePath,
      })
      const logArtifact = artifactRefs.find(artifact => artifact.path.endsWith('.log'))
      const logExcerpt = logArtifact
        ? truncateMiddle(redact(logArtifact.preview || ''), DEFAULT_MAX_LOG_CHARS)
        : ''

      const outputText = formatCompileOutput({
        entryFile: entryPath.workspacePath,
        engine: args.engine || 'pdf',
        exitCode: commandResult.exitCode,
        signal: commandResult.signal,
        stdout,
        stderr,
        logExcerpt,
        artifacts: artifactRefs,
        compileSucceeded,
      })

      return ToolResult.success(outputText, {
        workspace: true,
        compiled: compileSucceeded,
        exitCode: commandResult.exitCode ?? null,
        signal: commandResult.signal ?? null,
        entryFile: entryPath.workspacePath,
        commandId: commandResult.commandId,
        summary: commandResult.summary,
        timedOut: commandResult.timedOut,
        outputLimited: commandResult.outputLimited,
        events: commandResult.events,
        artifacts: artifactRefs.map(artifact => ({
          artifactId: artifact.id,
          path: artifact.path,
          size: artifact.size,
          downloadUrl: artifact.downloadUrl,
        })),
      })
    } catch (error) {
      return ToolResult.error(`Failed to compile workspace LaTeX project: ${redact(error.message)}`)
    }
  }

  async storeArtifacts({ sessionId, sandboxSession, entryFile }) {
    const artifactGlobs = artifactGlobsForEntry(entryFile)
    const artifacts = await sandboxSession.collectArtifacts(artifactGlobs)
    if (!artifacts.length) return []

    const docs = artifacts.map(artifact => {
      const id = crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex')
      const content = Buffer.isBuffer(artifact.content)
        ? artifact.content
        : Buffer.from(artifact.content)
      return {
        _id: id,
        sessionId,
        sandboxSessionId: sandboxSession.id,
        workspace: true,
        path: artifact.path,
        size: artifact.size,
        content,
        createdAt: this.now(),
        expiresAt: new Date(this.now().getTime() + this.artifactTtlMs),
        preview: artifact.path.endsWith('.log') || artifact.path.endsWith('.aux')
          ? redact(content.toString('utf8'))
          : undefined,
      }
    })

    if (this.artifactsCollection?.insertMany) {
      await this.artifactsCollection.insertMany(docs)
    }

    return docs.map(doc => ({
      id: doc._id,
      path: doc.path,
      size: doc.size,
      downloadUrl: `/api/ai/sessions/${sessionId}/artifacts/${doc._id}`,
      preview: doc.preview,
    }))
  }
}

function normalizeEntryPath(rawPath) {
  const pathResult = validateProjectPath(rawPath)
  if (pathResult.error) return { error: pathResult.error }
  if (!pathResult.path.endsWith('.tex')) {
    return { error: 'entry_file must be a .tex file.' }
  }
  return { workspacePath: projectPathToWorkspaceRelative(pathResult.path) }
}

function buildLatexmkCommand({ entryFile, engine }) {
  const engineFlag = engine === 'pdf' ? '-pdf' : `-${engine}`
  return [
    'latexmk',
    engineFlag,
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    entryFile,
  ]
}

function artifactGlobsForEntry(entryFile) {
  const parsed = path.posix.parse(entryFile)
  const prefix = parsed.dir ? `${parsed.dir}/` : ''
  return ARTIFACT_GLOBS.map(glob => `${prefix}${parsed.name}${glob.slice(1)}`)
}

function formatCompileOutput({
  entryFile,
  engine,
  exitCode,
  signal,
  stdout,
  stderr,
  logExcerpt,
  artifacts,
  compileSucceeded,
}) {
  const lines = [
    compileSucceeded ? 'LaTeX compile succeeded.' : 'LaTeX compile failed.',
    '',
    `Entry file: ${entryFile}`,
    `Engine: ${engine}`,
    `Exit code: ${exitCode ?? 'unknown'}`,
  ]
  if (signal) lines.push(`Signal: ${signal}`)

  if (artifacts.length) {
    lines.push('', 'Artifacts:')
    for (const artifact of artifacts) {
      lines.push(`- ${artifact.path} (${artifact.size} bytes): ${artifact.downloadUrl}`)
    }
  } else {
    lines.push('', 'Artifacts: none collected')
  }

  if (logExcerpt) {
    lines.push('', 'Log excerpt:', logExcerpt)
  } else if (stderr) {
    lines.push('', 'stderr:', truncateMiddle(stderr, DEFAULT_MAX_LOG_CHARS))
  } else if (stdout) {
    lines.push('', 'stdout:', truncateMiddle(stdout, DEFAULT_MAX_LOG_CHARS))
  }

  return lines.join('\n')
}

function truncateMiddle(text, maxChars) {
  if (!text || text.length <= maxChars) return text || ''
  const half = Math.floor((maxChars - 80) / 2)
  return `${text.slice(0, half)}\n\n[... ${text.length - half * 2} characters omitted ...]\n\n${text.slice(-half)}`
}

function redact(text) {
  return String(text || '').replace(SECRET_VALUE_RE, '[REDACTED]')
}

export function createCompileLatexTool(options) {
  return new CompileLatexTool(options)
}

export default CompileLatexTool
