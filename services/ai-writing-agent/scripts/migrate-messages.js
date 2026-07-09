#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Migration script: Move messages from aiSessions.messages to aiMessages collection.
 *
 * Idempotent: skips sessions that have already been migrated (_nextSeq > 1 or no messages field).
 *
 * Usage:
 *   node scripts/migrate-messages.js
 *
 * Environment:
 *   MONGO_CONNECTION_STRING - MongoDB connection string (default: mongodb://127.0.0.1:27017/sharelatex?directConnection=true)
 */

import { MongoClient } from 'mongodb'

const MONGO_URL = process.env.MONGO_CONNECTION_STRING || 'mongodb://127.0.0.1:27017/sharelatex?directConnection=true'

async function main() {
  const client = new MongoClient(MONGO_URL)
  await client.connect()
  const db = client.db()

  const aiSessions = db.collection('aiSessions')
  const aiMessages = db.collection('aiMessages')

  // Ensure index exists
  await aiMessages.createIndex({ sessionId: 1, seq: 1 }, { unique: true })

  // Find sessions that still have embedded messages (skip already-migrated)
  const cursor = aiSessions.find({
    messages: { $exists: true, $ne: [] },
  })

  let migrated = 0
  let skipped = 0
  let errors = 0

  for await (const session of cursor) {
    try {
      const messages = session.messages || []
      if (messages.length === 0) {
        skipped++
        continue
      }

      // Build aiMessages documents
      const docs = []
      let latestSummarySeq = null

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const seq = i + 1
        const doc = {
          sessionId: session._id,
          seq,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp || session.createdAt || new Date(),
        }
        if (msg.contentBlocks) doc.contentBlocks = msg.contentBlocks
        if (msg.toolContext) doc.toolContext = msg.toolContext
        if (msg.tool_calls) doc.tool_calls = msg.tool_calls
        if (msg.tool_call_id) doc.tool_call_id = msg.tool_call_id
        if (msg.isSummary) {
          doc.isSummary = true
          latestSummarySeq = seq
        }
        if (msg.compactedAt) doc.compactedAt = msg.compactedAt
        if (msg.interrupted) doc.interrupted = true
        docs.push(doc)
      }

      // Insert (ordered: false for idempotency — duplicates are silently skipped)
      try {
        await aiMessages.insertMany(docs, { ordered: false })
      } catch (bulkErr) {
        // Ignore duplicate key errors (code 11000) — means already migrated partially
        if (bulkErr.code !== 11000 && !bulkErr.writeErrors?.every(e => e.code === 11000)) {
          throw bulkErr
        }
      }

      // Update session: set _nextSeq (take max to avoid regression), _latestSummarySeq, remove messages
      const nextSeq = Math.max(session._nextSeq || 1, messages.length + 1)
      await aiSessions.updateOne(
        { _id: session._id },
        {
          $set: { _nextSeq: nextSeq, _latestSummarySeq: latestSummarySeq },
          $unset: { messages: '' },
        }
      )

      migrated++
      if (migrated % 100 === 0) {
        console.log(`  ... migrated ${migrated} sessions`)
      }
    } catch (err) {
      errors++
      console.error(`Error migrating session ${session._id}: ${err.message}`)
    }
  }

  console.log(`\nMigration complete: ${migrated} migrated, ${skipped} skipped, ${errors} errors`)

  // Verify: count remaining unmigrated sessions
  const remaining = await aiSessions.countDocuments({ messages: { $exists: true } })
  if (remaining > 0) {
    console.log(`WARNING: ${remaining} sessions still have embedded messages`)
  } else {
    console.log('All sessions have been migrated successfully.')
  }

  await client.close()
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
