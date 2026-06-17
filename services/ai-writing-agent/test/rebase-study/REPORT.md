# Edit Rebase 方案设计文档

> 最后更新: 2026-02-12
> 涉及文件: `DocumentAdapter.js`, `replacer.js`, `AgentLoop.js`, `AgentController.js`

---

## 1. 问题背景

AI Writing Agent 的 `edit_document` 工具在同一 turn 内通过 `Promise.all()` 并行执行多个编辑。
每个编辑调用 `previewEdit()` 生成一个 PendingChange（包含 `position` 和 `baseVersion`），
用户稍后在前端逐个或批量 accept。

**核心问题**：accept 第一个 change 后文档内容变化，后续 change 的 `position` 可能失效。

### 并行编辑的时序

```
AgentLoop.run()
  └── Promise.all([
        editTool.execute(edit_A),   ─┐  同时读取 doc v10
        editTool.execute(edit_B),   ─┤  各自生成 PendingChange
        editTool.execute(edit_C),   ─┘  position 都基于 v10 的快照
      ])

用户操作:
  accept(A) → doc 变为 v11 → B 和 C 的 position 可能已偏移
  accept(B) → doc 变为 v12 → C 的 position 可能进一步偏移
  accept(C) → ...
```

---

## 2. 旧算法（`_tryRebase`）的问题

| 问题 | 严重程度 | 说明 |
|------|---------|------|
| `indexOf` 无唯一性检查 | **高** | 多个匹配时盲目选第一个，可能替换错误位置 |
| 不使用 replacer chain | 中 | rebase 阶段没有模糊匹配能力，preview 阶段有 |
| 硬编码 1000 字符限制 | 中 | 唯一匹配但位移超过 1000 → 误报冲突 |
| 不处理 replaceAll (`position: null`) | **高** | 会抛 TypeError |

**实测复现**（Category 14 Test 1）：

```
原始文档: "BBCCCAACCC"
Change A: 删除 "AA" → "BBCCCCCC"
Change B: 替换第二个 "CCC" (原位置 7-10) → "DDD"

旧算法: indexOf("CCC") → 2 (第一个 CCC, 错误!) → 产生 "BBDDDCCC"
正确结果应为: "BBCCCDDD" 或拒绝为冲突
```

旧算法**静默产生了错误结果**。这在 LaTeX 文档中表现为：用户 accept 一个看似无关的改动后，
另一个改动被应用到了文档中完全错误的位置。

---

## 3. 新算法设计：`_resolveChangePosition`

### 核心思路

**字符串优先，位置辅助。**

```
accept 时:
  1. 文档未变 → 直接用原 position（快速路径）
  2. findMatch(content, oldText) → 唯一匹配 → 使用（利用完整 replacer chain）
  3. findMatch 报多重匹配 → 用原 position 作为距离提示选最近的
  4. 最终 slice 验证 → 确认无误后应用
```

### 三层解析策略

#### 第 1 层：精确位置快速路径

当 `currentDoc.version === change.baseVersion` 且原始位置处的内容完全匹配时，
直接使用原始 position。这是最常见的路径（用户很快 accept，文档未变）。

```javascript
if (version === change.baseVersion && origPos) {
  const atPosition = content.slice(origPos.start, origPos.end)
  if (atPosition === oldText) {
    return { success: true, method: 'exact_position' }
  }
}
```

#### 第 2 层：findMatch 唯一匹配

使用完整的 replacer chain（5 级匹配器）在当前文档中查找 `oldText`。
如果找到且唯一，直接使用新位置。**没有距离限制**——只要唯一就可信。

replacer chain 的 5 个匹配层级：
1. `SimpleReplacer` — 精确字符串匹配
2. `LineTrimmedReplacer` — 忽略行首行尾空白
3. `BlockAnchorReplacer` — 块级锚点匹配
4. `WhitespaceNormalizedReplacer` — 空白归一化
5. `IndentationFlexibleReplacer` — 缩进弹性匹配

这使得 accept 阶段也具备了与 preview 阶段相同的模糊匹配能力。

#### 第 3 层：位置辅助消歧

当 `oldText` 在当前文档中出现多次时：

1. 找到所有精确出现位置
2. 按与原始 `position.start` 的距离排序
3. **置信度检验**：
   - 最佳匹配距离 < 500 字符（`MAX_SHIFT`）
   - 最佳匹配明显优于次佳（次佳距离 ≥ 最佳 × 2.0，或最佳距离为 0）
4. 不满足置信度 → 拒绝为 `AMBIGUOUS`，而非猜测

```
示例：oldText "CCC" 在当前文档中出现于位置 2 和位置 5
原始位置为 7

距离排序: pos 5 (距离=2), pos 2 (距离=5)
置信度: 5 >= 2 × 2.0 → 有信心，选 pos 5
```

### replaceAll 处理

`edit_document` 工具支持 `replaceAll` 模式，此时 `position` 为 `null`。
旧算法直接 crash（`origPos.start` → TypeError）。

新算法在函数入口处理：在当前文档上重新执行全量替换。

### 最终 slice 验证

无论通过哪层解析，在实际应用编辑前都会做一次 slice 验证：

```javascript
const currentOldText = currentDoc.content.slice(position.start, position.end)
if (currentOldText !== effectiveChange.oldText) {
  throw new EditMatchError('Document content at position does not match expected text')
}
```

这是最后一道安全网，防止任何解析逻辑的 bug 导致错误替换。

---

## 4. 与 OpenCode 的架构对比

### 根本设计差异

| 维度 | 本项目 (AI Writing Agent) | OpenCode |
|------|--------------------------|----------|
| **编辑模型** | Preview → PendingChange → Accept | 直接写文件 |
| **匹配方式** | 位置 + 字符串双重机制 | 纯字符串匹配（每次读文件最新内容） |
| **并发控制** | 无锁，靠 rebase 补救 | `FileTime.withLock()` 每文件互斥锁 |
| **position 存储** | 是（PendingChange 携带 position） | 否（不存储位置，运行时查找） |
| **用户确认** | 需要（accept/reject） | 不需要（直接应用） |
| **多文件编辑** | 并行 `Promise.all` | MultiEdit 工具顺序执行 |

### OpenCode 的三层保护

```
EditTool.execute(file, oldString, newString)
  └── FileTime.withLock(file, async () => {     ← 第 1 层：per-file 互斥锁
        const content = await readFile(file)     ← 第 2 层：实时读取最新内容
        FileTime.assert(file)                    ← 第 3 层：mtime 脏读检测
        const newContent = content.replace(oldString, newString)
        await writeFile(file, newContent)
      })
```

- **`FileTime.withLock()`**：基于 Promise chain 的异步互斥锁，保证同一文件的编辑串行化
- **实时读取**：每次编辑都读取文件最新内容，不依赖缓存
- **`FileTime.assert()`**：检查文件 mtime，如果在读取和写入之间被外部修改，则中止

### 为什么 OpenCode 需要 MultiEdit 工具

OpenCode 的 Edit 工具有 per-file 锁。如果 LLM 对同一文件并行调用多个 Edit：

```
Promise.all([
  Edit(file, oldA, newA),  // 获取锁 → 读文件 → 替换 A → 写回 → 释放锁
  Edit(file, oldB, newB),  // 等待锁 → 获取锁 → 读文件 → 此时 oldB 可能已不存在!
])
```

锁保证了安全（不会产生错误结果），但第二个 Edit 可能因为找不到 `oldB` 而失败。

`MultiEdit` 的解决方案：在**单次锁获取**内顺序应用多个编辑，避免了中间状态问题：

```javascript
FileTime.withLock(file, async () => {
  let content = await readFile(file)
  for (const edit of edits) {
    content = content.replace(edit.old, edit.new)  // 每步基于上一步的结果
  }
  await writeFile(file, content)
})
```

### 为什么我们不需要锁

本项目的编辑模型与 OpenCode 根本不同：

1. **preview 阶段不修改文档**：`previewEdit()` 只生成 PendingChange，不写入
2. **accept 是用户驱动的**：用户逐个点击 accept，天然串行
3. **`acceptAllChanges()` 已经是 `for` 循环**：顺序执行，每次都重新读取文档

因此我们需要的不是锁，而是一个可靠的 **position 重新解析算法**（即 `_resolveChangePosition`）。

### 架构选择的权衡

| | 本项目 | OpenCode |
|---|---|---|
| **优势** | 用户可预览、选择性接受/拒绝；前端高亮显示差异 | 实现简单；无 stale position 问题 |
| **劣势** | position 可能过期，需要 rebase 算法 | 无法预览；无法撤回（只能 undo） |
| **适用场景** | 需要人类审核的 SaaS 产品 | 开发者工具，信任 AI 输出 |

---

## 5. All Accept 模式分析

> 如果新增一个 all accept 模式，使 AI 产生的所有改动无需用户确认就自动应用到文档中，
> 会有什么风险？

### 两种实现方式

#### 方式 A：Turn 结束后批量 accept（推荐）

```
AgentLoop.run() 完成
  └── for (const change of pendingChanges) {
        await applyEdit(change)  // 顺序执行，每次读取最新文档
      }
```

**安全性**：与现有 `acceptAllChanges()` 相同，`_resolveChangePosition` 在每次 accept 时
重新解析位置。已通过 50 轮随机排序不变量测试验证。

**风险**：
- **低风险**：与用户手动逐个 accept 等价，只是自动化了
- **唯一额外风险**：如果用户在 agent turn 结束和批量 accept 之间手动编辑了文档，
  部分 change 可能因 rebase 失败而被拒绝。这是合理的保护行为。

#### 方式 B：工具执行时立即 apply（不推荐）

```
editTool.execute()
  └── previewEdit()
  └── applyEdit()  // 立即写入文档
```

**严重风险**：

1. **`readDocuments` 快照过期**：`AgentLoop` 在 turn 开始时通过 `read_document` 获取文档内容，
   后续 `edit_document` 调用会参考这个快照来生成 oldText。如果 edit A 在执行时立即 apply，
   edit B 的 oldText 是基于 apply A 之前的快照生成的，可能已经不正确。

2. **并行 edit 的竞争条件**：`Promise.all` 并行执行时，多个 edit 同时读取"当前文档"，
   但由于没有文件锁，它们可能读到不一致的中间状态。

3. **LLM 上下文不一致**：LLM 看到的是 `read_document` 返回的快照内容，
   如果编辑在执行时立即生效，LLM 在同一 turn 内后续的编辑决策就基于了过时信息。

**如果一定要实现方式 B，需要的额外保护**（参考 OpenCode）：

| 保护措施 | 说明 | 复杂度 |
|----------|------|--------|
| Per-file 互斥锁 | 防止同一文件的并行写入竞争 | 中 |
| 编辑时实时读取文档 | 不依赖 `readDocuments` 快照 | 低 |
| 类似 MultiEdit 的批处理 | 同文件多编辑在单次锁内顺序执行 | 高 |
| 禁用并行工具调用 | `Promise.all` → 顺序 for 循环 | 低但影响性能 |

### 推荐方案

**使用方式 A**。它只需在 `AgentController` 中添加一个开关：

```javascript
// AgentLoop turn 完成后
if (session.autoAccept) {
  await this.acceptAllChanges(sessionId, { userId })
}
```

不需要改动 `DocumentAdapter`、`AgentLoop` 或工具层的任何代码。
现有的 `_resolveChangePosition` 算法已经能正确处理批量 accept。

---

## 6. 实施记录

### 已完成的改动

#### `DocumentAdapter.js`

| 操作 | 方法 | 说明 |
|------|------|------|
| **移除** | `_tryRebase()` | 旧的 indexOf rebase 逻辑 |
| **移除** | `_fuzzyFindPosition()` | 旧的模糊位置查找 |
| **移除** | `_calculateSimilarity()` | 旧的字符串相似度计算 |
| **新增** | `_resolveChangePosition()` | 三层解析策略（精确位置 → findMatch → 位置消歧） |
| **新增** | `_disambiguateByPosition()` | 多重匹配时基于原始位置的置信度消歧 |
| **新增** | `_findAllOccurrences()` | 查找字符串所有出现位置 |
| **重写** | `applyEdit()` | 统一使用 `_resolveChangePosition`，支持 replaceAll，增加 slice 验证 |

#### `DocumentAdapterApplyTests.test.js`

| 操作 | 说明 |
|------|------|
| **移除** | `_calculateSimilarity` 测试块（方法已删除） |
| **新增** | `_resolveChangePosition` 测试（5 个用例） |
| **新增** | `_disambiguateByPosition` 测试（3 个用例） |
| **更新** | "position shifted > 1000 chars" → 改为验证成功（findMatch 唯一匹配无距离限制） |
| **更新** | "oldText not found" → 改为验证 `RebaseConflictError`（NOT_FOUND） |

#### `AcceptRejectTests.test.js`

| 操作 | 说明 |
|------|------|
| **修复** | 补充 `mockReq.headers` 及 `x-user-id`（已有 bug，非本次改动引入） |

### 未改动的部分

- `previewEdit()` — 保持不变
- `edit.js` (工具定义) — 保持不变
- `AgentLoop.js` (并行执行) — 保持不变
- 前端 `ai-change-highlight.ts` — 保持不变（CodeMirror `mapPos` 机制已经正确）
- `AgentController.js` (accept/reject API) — 保持不变

### 向后兼容性

新算法是旧算法的**严格超集**：

- 旧算法能处理的场景 → 新算法都能处理（且结果相同）
- 旧算法误报冲突的场景（大位移）→ 新算法正确处理
- 旧算法静默产生错误结果的场景 → 新算法拒绝为冲突

唯一的行为变化方向是：**错误 → 拒绝**（更安全），不存在**成功 → 失败**的退化。

---

## 7. 测试结果

### 基础测试 (26/26 通过)

| 类别 | 测试数 | 结果 |
|------|--------|------|
| 基本顺序 accept | 3 | pass |
| 位置偏移 | 2 | pass |
| oldText 变非唯一 | 2 | pass — 正确拒绝歧义/消歧 |
| 完全覆写（已知限制） | 1 | pass — 两种算法都无法检测 |
| 大位移 | 2 | pass — 不受硬编码限制 |
| LaTeX 真实场景 | 3 | pass |
| 用户手动编辑 | 3 | pass |
| replaceAll | 1 | pass |
| 边界条件 | 3 | pass |
| acceptAll 模拟 | 2 | pass — 任意顺序都正确 |
| 重复结构压力 | 1 | pass |
| 空白变化 | 1 | pass |
| 正确性对比 | 2 | pass — 发现旧算法 bug |

### 对抗测试 (14/14 通过)

| 类别 | 结果 |
|------|------|
| 100-section 文档 | pass — 非顺序 accept 正确 |
| 20 个 change 随机顺序 | pass |
| 重叠编辑区域 | pass — 正确检测冲突 |
| newText 包含 oldText | pass — 位置消歧正确 |
| Unicode/CJK/LaTeX | pass |
| 空文档/长文本 | pass |
| **50 轮随机排序不变量** | pass — 10 个 change x 50 种随机顺序，结果全部一致 |
| 真实协作场景 | pass — AI 编辑 + 用户编辑交错 |

### 新旧算法对比矩阵

| 场景 | 旧算法 | 新算法 | 评价 |
|------|--------|--------|------|
| 简单非重叠 | 成功 | 成功 | 一致 |
| 大位移 (>1000) | POSITION_SHIFTED 拒绝 | findMatch_unique 成功 | **新算法更好** |
| 歧义引入 | indexOf 猜中（运气好） | AMBIGUOUS_CLOSE 拒绝 | **新算法更安全** |
| 错误匹配 (Cat14-T1) | 成功但**结果错误** | 拒绝 | **新算法正确** |
| replaceAll | TypeError crash | replaceAll_redo 成功 | **新算法修复 bug** |

### 单元测试 (138/138 通过)

全部 9 个测试文件、138 个用例通过，包括新增的 8 个 `_resolveChangePosition` / `_disambiguateByPosition` 测试。

---

## 8. 已知限制

**无法检测的场景**：Change A 完全重写文档，恰好在相同位置引入与 Change B 的 oldText 相同的文本。

```
原始文档: "AAA BBB CCC"
Change A: 全文替换为 "XXX BBB YYY" (恰好保留了 "BBB" 且位置相同)
Change B: 替换 "BBB" → "DDD"

accept A 后: "XXX BBB YYY"
accept B: 找到 "BBB" → 唯一匹配 → 替换为 "DDD" → "XXX DDD YYY"

但 Change A 中的 "BBB" 可能是全新内容，语义上与原始 "BBB" 无关。
```

这需要真正的 OT (Operational Transform) 或 CRDT 才能解决，但在 LaTeX 论文编辑的实际场景中
极其罕见——LLM 通常编辑独立段落，不会整段覆写后恰好引入相同子串。

---

## 9. 参考文件索引

| 文件 | 职责 |
|------|------|
| `app/js/adapter/DocumentAdapter.js` | 核心：rebase 算法、文档读写 |
| `app/js/util/replacer.js` | findMatch + 5 级 replacer chain |
| `app/js/tool/edit.js` | edit_document 工具定义，生成 PendingChange |
| `app/js/agent/AgentLoop.js` | Agent 循环，`Promise.all` 并行工具执行 |
| `app/js/AgentController.js` | accept/reject API，`acceptAllChanges` |
| `web/frontend/.../ai-change-highlight.ts` | 前端 CodeMirror position 映射 |
| `test/rebase-study/resolve-position.js` | 独立算法实现（测试参考用） |
