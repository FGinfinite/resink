const assert = require('node:assert/strict')

const { ConfigManager, definitionsByService } = require('../../index.js')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function matches(doc, query) {
  return Object.entries(query).every(([key, value]) => doc[key] === value)
}

class FakeCursor {
  constructor(docs) {
    this.docs = docs
  }

  sort(sortSpec) {
    const [[field, direction]] = Object.entries(sortSpec)
    this.docs.sort((left, right) => {
      if (left[field] === right[field]) return 0
      if (direction < 0) {
        return left[field] > right[field] ? -1 : 1
      }
      return left[field] > right[field] ? 1 : -1
    })
    return this
  }

  limit(limit) {
    this.docs = this.docs.slice(0, limit)
    return this
  }

  async toArray() {
    return clone(this.docs)
  }
}

class FakeCollection {
  constructor() {
    this.docs = []
    this.indexes = []
  }

  async createIndex(spec, options) {
    this.indexes.push({ spec, options })
  }

  find(query) {
    return new FakeCursor(this.docs.filter(doc => matches(doc, query)))
  }

  async findOne(query) {
    const doc = this.docs.find(item => matches(item, query))
    return clone(doc) || null
  }

  async updateOne(filter, update, options = {}) {
    const nextDoc = clone(update.$set)
    const index = this.docs.findIndex(doc => matches(doc, filter))

    if (index >= 0) {
      this.docs[index] = nextDoc
      return
    }

    if (options.upsert) {
      this.docs.push(nextDoc)
    }
  }

  async insertOne(doc) {
    this.docs.push(clone(doc))
  }

  async deleteOne(filter) {
    this.docs = this.docs.filter(doc => !matches(doc, filter))
  }
}

function createManager(service) {
  return new ConfigManager({
    service,
    definitions: definitionsByService[service],
    collections: {
      values: new FakeCollection(),
      revisions: new FakeCollection(),
      auditLogs: new FakeCollection(),
    },
  })
}

describe('ConfigManager', function () {
  afterEach(function () {
    delete process.env.SITE_OPEN
    delete process.env.PREEMPTIBLE
  })

  it('should resolve default, env, and runtime values in the expected order', async function () {
    const manager = createManager('web')

    let entry = await manager.getResolvedEntry('site.isOpen', {
      env: {},
    })
    assert.equal(entry.source, 'default')
    assert.equal(entry.resolvedValue, true)

    process.env.SITE_OPEN = 'false'
    entry = await manager.getResolvedEntry('site.isOpen')
    assert.equal(entry.source, 'env')
    assert.equal(entry.resolvedValue, false)

    await manager.setRuntimeValue({
      key: 'site.isOpen',
      value: true,
      updatedBy: 'admin-user',
      comment: 'reopen site',
    })

    entry = await manager.getResolvedEntry('site.isOpen')
    assert.equal(entry.source, 'runtime')
    assert.equal(entry.resolvedValue, true)
    assert.equal(entry.runtimeVersion, 1)
  })

  it('should apply runtime values back onto the settings object', async function () {
    const manager = createManager('web')
    const target = {
      defaultFeatures: {
        compileTimeout: 180,
      },
    }

    await manager.setRuntimeValue({
      key: 'defaultFeatures.compileTimeout',
      value: 240,
      updatedBy: 'admin-user',
      comment: 'increase compile timeout',
    })

    await manager.applyResolvedSettings(target, { env: {} })

    assert.equal(target.defaultFeatures.compileTimeout, 240)
  })

  it('should reset and rollback runtime values with revision history', async function () {
    const manager = createManager('web')

    await manager.setRuntimeValue({
      key: 'defaultFeatures.compileTimeout',
      value: 240,
      updatedBy: 'admin-user',
      comment: 'raise timeout',
    })
    await manager.resetRuntimeValue({
      key: 'defaultFeatures.compileTimeout',
      updatedBy: 'admin-user',
      comment: 'reset timeout',
    })

    let entry = await manager.getResolvedEntry('defaultFeatures.compileTimeout', {
      env: {},
    })
    assert.equal(entry.source, 'default')
    assert.equal(entry.resolvedValue, 180)

    await manager.rollbackRuntimeValue({
      key: 'defaultFeatures.compileTimeout',
      version: 1,
      updatedBy: 'admin-user',
      comment: 'rollback timeout',
    })

    entry = await manager.getResolvedEntry('defaultFeatures.compileTimeout', {
      env: {},
    })
    assert.equal(entry.source, 'runtime')
    assert.equal(entry.resolvedValue, 240)

    const revisions = await manager.getRevisions('defaultFeatures.compileTimeout')
    assert.deepEqual(
      revisions.map(revision => revision.action),
      ['set', 'reset', 'set']
    )
  })

  it('should keep the clsi concurrency default aligned with the preemptible mode', async function () {
    process.env.PREEMPTIBLE = 'TRUE'
    const manager = createManager('clsi')

    const entry = await manager.getResolvedEntry('compileConcurrencyLimit', {
      env: {},
    })

    assert.equal(entry.resolvedValue, 32)
    assert.equal(entry.source, 'default')
  })
})
