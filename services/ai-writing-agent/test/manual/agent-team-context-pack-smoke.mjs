#!/usr/bin/env node

/* eslint-disable no-console */

import { ObjectId, mongoClient } from '../../app/js/mongodb.js'
import { AgentTeamOrchestrator } from '../../app/js/agent-team/AgentTeamOrchestrator.js'
import { AgentTaskStore } from '../../app/js/agent-team/AgentTaskStore.js'

const RUN_MARKER = `agent-team-context-pack-smoke-${Date.now()}`
const PROJECT_ID = process.env.AGENT_SMOKE_PROJECT_ID || '6a390bf87a13c32e536c279c'
const USER_ID = process.env.AGENT_SMOKE_USER_ID || 'agent-context-pack-smoke-user'

await mongoClient.connect()
const mongoDb = mongoClient.db()
const db = {
  aiAgentTeams: mongoDb.collection('aiAgentTeams'),
  aiAgentTasks: mongoDb.collection('aiAgentTasks'),
  aiAgentContextPacks: mongoDb.collection('aiAgentContextPacks'),
  aiAgentTaskResults: mongoDb.collection('aiAgentTaskResults'),
  aiAgentTeamEvents: mongoDb.collection('aiAgentTeamEvents'),
}
const store = new AgentTaskStore({ db })
let result

try {
  const capability = {
    name: 'context-pack-smoke-reviewer',
    version: '1.0.0',
    role: 'worker',
    defaultPolicy: {
      tools: ['read_document', 'propose_memory', 'start_agent_task'],
      fileGlobs: ['**/*.tex'],
      writeGlobs: [],
      network: 'deny',
      pythonEnvironments: [],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls: 4,
      allowSpawn: false,
      allowHandoff: false,
    },
    contextPolicy: {
      includeProjectInstructions: true,
      includeMemories: true,
      includeSessionSummary: true,
      includeRecalledContext: true,
      maxMemories: 1,
    },
    outputSchema: { type: 'object' },
  }
  const childRunner = async ({ contextPack, allowedToolNames }) => ({
    status: 'completed',
    summary: 'context pack verified',
    findings: [],
    artifacts: [
      {
        contextPackMemoryCount: contextPack.memories.length,
        contextPackSourceCounts: contextPack.sourceCounts,
        allowedToolNames,
      },
    ],
    usage: { llmCalls: 0, toolCalls: 0 },
    events: [
      {
        type: 'agent_task.context_pack_verified',
        payload: { contextSourceCounts: contextPack.sourceCounts },
      },
    ],
  })
  const orchestrator = new AgentTeamOrchestrator({
    store,
    capabilityRegistry: { get: () => capability },
    agentController: {
      createChildSession: async input => ({ _id: new ObjectId(), ...input }),
      updateSessionStatus: async () => {},
    },
    childRunner,
  })

  result = await orchestrator.startAgentTask({
    sessionId: new ObjectId().toString(),
    rootSessionId: new ObjectId().toString(),
    projectId: PROJECT_ID,
    userId: USER_ID,
    parentPolicy: {
      tools: ['read_document', 'propose_memory', 'start_agent_task'],
      fileGlobs: ['**/*.tex'],
      writeGlobs: [],
      network: 'deny',
      pythonEnvironments: [],
      modelTiers: ['standard'],
      maxDepth: 1,
      maxParallelTasks: 1,
      maxToolCalls: 8,
      allowSpawn: false,
      allowHandoff: false,
    },
    taskSpec: {
      capabilityName: capability.name,
      mode: 'tool',
      objective: `${RUN_MARKER} verify context pack`,
      acceptanceCriteria: ['Context pack includes only selected memory slices.'],
      input: {
        userRequest: `${RUN_MARKER} review selected context`,
        files: [],
      },
      contextPolicy: {
        includeMemories: true,
        maxMemories: 1,
      },
      outputSchema: { type: 'object' },
      policy: {
        tools: ['read_document', 'propose_memory', 'start_agent_task'],
      },
    },
    projectInstructions: {
      content: `${RUN_MARKER} project instruction`,
      path: 'AGENTS.md',
      docId: 'doc-instructions',
    },
    memories: [
      {
        id: 'memory-selected',
        scope: 'project',
        source: 'manual',
        content: `${RUN_MARKER} selected memory`,
      },
      {
        id: 'memory-not-selected',
        scope: 'global',
        source: 'manual',
        content: `${RUN_MARKER} not selected`,
      },
    ],
    sessionSummary: {
      id: 'summary-1',
      summary: `${RUN_MARKER} session summary`,
    },
    recalledContext: [
      {
        id: 'recall-1',
        type: 'memory',
        content: `${RUN_MARKER} recall`,
      },
    ],
  })

  const loaded = await store.loadTeamRun({
    teamId: result.teamId,
    projectId: PROJECT_ID,
    userId: USER_ID,
  })
  const contextPack = loaded.contextPacks[0]
  if (!contextPack) throw new Error('Context pack was not persisted')
  if (contextPack.memories.length !== 1) {
    throw new Error(`Expected one selected memory, got ${contextPack.memories.length}`)
  }
  if (JSON.stringify(contextPack).includes('not selected')) {
    throw new Error('Unselected memory leaked into context pack')
  }
  if (result.allowedToolNames.includes('propose_memory')) {
    throw new Error('Child allowed tools include propose_memory')
  }
  if (result.allowedToolNames.includes('start_agent_task')) {
    throw new Error('Child allowed tools include recursive start_agent_task')
  }

  console.log(JSON.stringify({
    ok: true,
    marker: RUN_MARKER,
    teamId: result.teamId,
    taskId: result.taskId,
    allowedToolNames: result.allowedToolNames,
    sourceCounts: contextPack.sourceCounts,
    memoryCount: contextPack.memories.length,
    pathVerified: 'AgentTeamOrchestrator -> AgentContextPackBuilder -> AgentTaskStore context pack with child memory-write denial',
  }, null, 2))
} finally {
  if (result?.teamId) {
    const teamId = new ObjectId(result.teamId)
    await Promise.all([
      db.aiAgentTeams.deleteMany({ _id: teamId }),
      db.aiAgentTasks.deleteMany({ teamId }),
      db.aiAgentContextPacks.deleteMany({ teamId }),
      db.aiAgentTaskResults.deleteMany({ teamId }),
      db.aiAgentTeamEvents.deleteMany({ teamId }),
    ])
  }
  await mongoClient.close()
}
