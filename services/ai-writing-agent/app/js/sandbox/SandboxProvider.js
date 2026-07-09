/**
 * Base contract for sandbox-backed agent workspaces.
 *
 * Concrete providers expose isolated sessions with:
 * - createSession(input)
 * - resumeSession(sessionId)
 * - destroySession(sessionId)
 *
 * Sessions expose:
 * - run(commandInput): AsyncIterable<SandboxEvent>
 * - readFile(path): Promise<Buffer>
 * - writeFile(path, content): Promise<void>
 * - capabilities.immutableRuntimeEnvironmentMount?: boolean
 * - writeRuntimeEnvironmentFile?(environmentId, path, content): Promise<void>
 * - listFiles(path?): Promise<SandboxFile[]>
 * - collectArtifacts(globs): Promise<Artifact[]>
 */
export class SandboxProvider {
  async createSession() {
    throw new Error('createSession must be implemented by SandboxProvider')
  }

  async resumeSession() {
    throw new Error('resumeSession must be implemented by SandboxProvider')
  }

  async destroySession() {
    throw new Error('destroySession must be implemented by SandboxProvider')
  }
}

export class SandboxSession {
  async run() {
    throw new Error('run must be implemented by SandboxSession')
  }

  async readFile() {
    throw new Error('readFile must be implemented by SandboxSession')
  }

  async writeFile() {
    throw new Error('writeFile must be implemented by SandboxSession')
  }

  async listFiles() {
    throw new Error('listFiles must be implemented by SandboxSession')
  }

  async collectArtifacts() {
    throw new Error('collectArtifacts must be implemented by SandboxSession')
  }
}

export default SandboxProvider
