# Overleaf Server Pro vs Community Edition 功能差异调研

> 调研目标：梳理 Server Pro 相对于 CE 的全部独占功能，评估自实现可行性，为后续逐步实现提供参考。

**调研日期**: 2026-02-14
**信息来源**: 代码库深度分析 + [官方对比文档](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition) + [Overleaf GitHub](https://github.com/overleaf/overleaf)

---

## 目录

1. [功能对比总表](#功能对比总表)
2. [门控机制概述](#门控机制概述)
3. [逐项详细分析](#逐项详细分析)
4. [推荐实施优先级](#推荐实施优先级)
5. [关键结论](#关键结论)
6. [参考资料](#参考资料)

---

## 功能对比总表

| # | 功能 | CE | Pro | 门控机制 | 自实现可行性 | 难度 |
|---|------|:--:|:---:|----------|:---:|:---:|
| 1 | LDAP 认证 | ✗ | ✓ | 环境变量 `Settings.ldap.enable` | **95%** | ★★☆☆☆ |
| 2 | SAML SSO | ✗ | ✓ | 环境变量 `Settings.enableSaml` | **90%** | ★★★☆☆ |
| 3 | Track Changes（修订追踪） | ✗ | ✓ | `moduleImportSequence` 闭源模块 | **40%** | ★★★★★ |
| 4 | Comments（评论） | ✗ | ✓ | 与 Track Changes 绑定 | **40%** | ★★★★★ |
| 5 | Sandboxed Compiles（沙箱编译） | ✗ | ✓ | `DockerRunner.js` 物理文件检测 | **70%** | ★★★★☆ |
| 6 | Git Bridge | ✗ | ✓ | `Settings.enableGitBridge` + 独立服务 | **80%** | ★★★☆☆ |
| 7 | GitHub 同步 | ✗ | ✓ | `Settings.enableGithubSync` | **75%** | ★★★☆☆ |
| 8 | Symbol Palette（符号面板） | ✗ | ✓ | `moduleImportSequence` 闭源模块 | **85%** | ★★☆☆☆ |
| 9 | Templates（模板系统） | ✗ | ✓ | `Settings.templates.user_id` | **90%** | ★★☆☆☆ |
| 10 | Managed Users（托管用户） | ✗ | ✓ | `managedUsers.enabled` 配置 | **60%** | ★★★☆☆ |
| 11 | Group SSO（组级 SSO） | ✗ | ✓ | Modules hooks 闭源 | **50%** | ★★★★☆ |
| 12 | Admin Panel 增强 | 有限 | ✓ | Pro 模块注入 | **80%** | ★★★☆☆ |
| 13 | 优化版 TeX Live | ✗ | ✓ | Pro 镜像内置 | **90%** | ★☆☆☆☆ |
| 14 | 安全补丁早期通知 | ✗ | ✓ | 非技术，商业服务 | N/A | — |

---

## 门控机制概述

代码库中 Server Pro 与 CE 的功能区分主要通过以下 5 种机制实现：

### 1. `Features.hasFeature()` 函数

位于 `services/web/app/src/infrastructure/Features.mjs`，是最核心的特性开关。

### 2. `OVERLEAF_IS_SERVER_PRO` 环境变量

在初始化脚本（`server-ce/init_scripts/900_run_web_migrations.sh`）和数据库迁移中使用，区分迁移 tag（`server-ce` vs `server-pro`）。

### 3. `moduleImportSequence` 配置

`services/web/config/settings.defaults.js:1064-1069`：

```javascript
// CE 版仅包含 4 个模块
moduleImportSequence: [
  'history-v1',
  'launchpad',
  'server-ce-scripts',
  'user-activate',
],
```

Server Pro 会额外加载 `support`、`symbol-palette`、`track-changes` 等闭源模块。这些模块的源码**不在开源仓库中**，仅以编译后形式存在于 Pro 镜像内。

### 4. `DockerRunner.js` 物理文件检测

`services/clsi/config/settings.defaults.cjs:101-109`：

```javascript
if ((process.env.DOCKER_RUNNER || process.env.SANDBOXED_COMPILES) === 'true') {
  if (!fs.existsSync(Path.join(__dirname, '..', 'app', 'js', 'DockerRunner.js'))) {
    console.error('Sandboxed compiles are only available with Overleaf Server Pro.')
    process.exit(1)
  }
}
```

CE 镜像中物理上不包含此文件，即使设置环境变量也无法启用。

### 5. `overleafModuleImports` 前端模块插槽

`services/web/config/settings.defaults.js:982-1062` 中定义了大量前端插槽（空数组），Pro 版会填充：

- `gitBridge` — Git Bridge UI
- `sourceEditorSymbolPalette` — 编辑器符号面板
- `importProjectFromGithubModalWrapper` / `importProjectFromGithubMenu` — GitHub 导入
- `editorLeftMenuSync` — 左侧菜单同步（Dropbox/GitHub）
- `editorLeftMenuManageTemplate` — 模板管理
- `managedGroupSubscriptionEnrollmentNotification` — 托管组注册通知
- `ssoCertificateInfo` — SSO 证书信息
- `offlineModeToolbarButtons` — 离线模式按钮
- 等 20+ 个插槽

### Features.mjs 完整特性开关表

| Feature 名称 | 启用条件 | CE 默认 | 说明 |
|-------------|----------|---------|------|
| `saas` | `Settings.overleaf` 存在 | 关 | SaaS 模式 (overleaf.com) |
| `homepage` | `Settings.enableHomepage` | 关 | 公共首页 |
| `registration-page` | 无外部认证或 SaaS 模式 | **开** | 注册页面 |
| `registration` | `Settings.overleaf` 存在 | 关 | 公开注册 |
| `chat` | `Settings.disableChat === false` | **开** | 项目聊天 |
| `link-sharing` | `Settings.disableLinkSharing === false` | **开** | 链接共享 |
| `github-sync` | `Settings.enableGithubSync` | 关 | GitHub 同步 |
| `git-bridge` | `Settings.enableGitBridge` | 关 | Git Bridge |
| `oauth` | `Settings.oauth` 存在 | 关 | OAuth |
| `templates-server-pro` | `Settings.templates.user_id` 存在 | 关 | 模板系统 |
| `affiliations` / `analytics` | `apis.v1.url` 存在 | 关 | 机构关联/分析 |
| `saml` | `Settings.enableSaml` | 关 | SAML 认证 |
| `linked-project-file` | `enabledLinkedFileTypes` 含 `project_file` | 关 | 链接项目文件 |
| `linked-project-output-file` | `enabledLinkedFileTypes` 含 `project_output_file` | 关 | 链接项目输出 |
| `link-url` | URL 代理 + `enabledLinkedFileTypes` 含 `url` | 关 | URL 链接 |
| `support` | `moduleImportSequence` 含 `support` | 关 | 技术支持 |
| `symbol-palette` | `moduleImportSequence` 含 `symbol-palette` | 关 | 符号面板 |
| `track-changes` | `moduleImportSequence` 含 `track-changes` | 关 | 修订追踪 |
| `ai-assistant` | `Settings.enableAiAssistant` | **开**（自定义） | AI 助手 |

### 用户 Features 对象（基于订阅计划）

`services/web/types/user.ts:11-28` 定义了用户级功能字段：

```typescript
// 用户可控功能
collaborators    // 协作者数量限制
compileGroup     // 编译组 (standard/priority)
compileTimeout   // 编译超时时间
dropbox          // Dropbox 集成
gitBridge        // Git Bridge
github           // GitHub 集成
mendeley/zotero  // 参考文献管理器
symbolPalette    // 符号面板
templates        // 模板
trackChanges     // 修订追踪
versioning       // 版本控制
```

CE `defaultFeatures`（`settings.defaults.js:404-414`）虽包含 `trackChanges: true`，但 `track-changes` 模块不在 `moduleImportSequence` 中，`Features.hasFeature('track-changes')` 仍返回 `false`。

---

## 逐项详细分析

### 1. LDAP 认证

**可行性：95% | 难度：★★☆☆☆**

**门控方式**：
- `Features.mjs:35-36` 检查 `Settings.ldap.enable`
- 通过 `OVERLEAF_LDAP_*` 系列环境变量配置（`URL`、`SEARCH_BASE`、`SEARCH_FILTER`、`BIND_DN` 等）

**代码库现状**：
- 已有完整的 LDAP 集成骨架
- `UserPagesController.mjs:56` 登录时已预留 LDAP 用户详情更新逻辑

**实现路径**：
1. 安装 `passport-ldapauth` 依赖
2. 编写 LDAP Strategy middleware，对接 `AuthenticationController`
3. 配置登录页面根据 LDAP 启用状态调整 UI
4. 实现首次登录自动创建用户（从 LDAP 属性映射）

**代码量预估**：200–400 行

**社区参考**：
- [ldap-overleaf-sl](https://github.com/smhaller/ldap-overleaf-sl) — 成熟的社区实现
- `passport-ldapauth` 库本身非常成熟

**风险**：低。LDAP 协议标准化程度高。

---

### 2. SAML SSO

**可行性：90% | 难度：★★★☆☆**

**门控方式**：
- `Features.mjs:76` 检查 `Settings.enableSaml`
- `OVERLEAF_SAML_*` 环境变量（`ENTRYPOINT`、`CALLBACK_URL`、`ISSUER`、`CERT` 等）

**代码库现状**：
- `services/web/app/src/Features/User/SAMLIdentityManager.mjs` — SAML 身份管理器（已存在）
- `services/web/app/src/Features/SamlLog/SamlLogHandler.mjs` — SAML 日志处理（已存在）
- `services/web/types/subscription/sso.ts` — `SSOConfig` 和 `GroupSSOLinkingStatus` 类型定义

**实现路径**：
1. 安装 `@node-saml/passport-saml`
2. 实现 SP metadata 生成端点
3. 实现 ACS (Assertion Consumer Service) endpoint
4. 实现 SLO (Single Logout)（可选）
5. 激活 `SAMLIdentityManager` 和 `SamlLogHandler`

**代码量预估**：500–800 行

**风险**：中低。SAML 协议本身复杂度较高，但库支持好。主要难点在不同 IdP（Okta、Azure AD、ADFS、Keycloak）的兼容性测试。启用 SSO 后所有本地密码将失效（`Settings.enableSaml` 为 true 时的行为），需注意管理员登录问题。

---

### 3. Track Changes（修订追踪）

**可行性：40% | 难度：★★★★★**

> ⚠️ **这是 Server Pro 最核心的商业护城河，也是自实现难度最高的功能。**

**门控方式**：
- `track-changes` 闭源模块不在 CE 的 `moduleImportSequence` 中
- 源码**不在开源仓库中**，仅以编译后形式存在于 Pro 镜像

**为什么难**：
1. **OT 层面追踪**：需要在 Operational Transformation 系统中记录每个用户的每次操作（插入、删除），并持久化为 ranges
2. **深度耦合**：与 `document-updater`、`project-history`、`ranges-tracker` 三个核心服务深度耦合
3. **前端 Review Panel**：需要实现接受/拒绝/评论的完整 UI 交互
4. **位置计算精度**：OT 系统中的变更追踪需要精确的字符位置计算，off-by-one 错误会导致文档损坏
5. **实时协作兼容**：多人同时编辑时，追踪范围需要随其他用户的操作实时调整

**代码库线索**：
- `libraries/ranges-tracker/` — 底层范围追踪库（开源，但只是基础工具）
- `services/web/frontend/js/features/review-panel/` — 前端 Review Panel 组件（已存在但被门控）
- `services/web/frontend/js/features/review-panel/components/upgrade-track-changes-modal.tsx` — 无功能时显示升级提示
- `services/web/app/src/Features/Project/ProjectController.mjs:972` — `hasTrackChangesFeature` 传递到前端

**实现路径（如果要做）**：
1. 后端 `track-changes` 模块：变更记录存储（MongoDB）、查询 API、接受/拒绝逻辑
2. 在 `document-updater` 中集成变更追踪：基于 `ranges-tracker` 记录 insert/delete 操作的作者和范围
3. Socket.IO 事件扩展：实时同步追踪状态
4. 激活并适配前端 Review Panel 组件

**代码量预估**：3000–5000 行

**风险**：极高。这不是一个"做不做得出来"的问题，而是"做出来后能否在所有边界情况下保持文档一致性"的问题。建议在确定投入前先深入研究 `ranges-tracker` 库的实现原理。

---

### 4. Comments（评论系统）

**可行性：40% | 难度：★★★★★**

**与 Track Changes 高度耦合**。评论功能依赖：
- **选区追踪**：哪段文本被评论 → 需要 `ranges-tracker` 的 comment ranges
- **评论线程管理** → 需要后端存储（与 `services/chat` 不同，这是文档内嵌评论）
- **实时同步** → 需要 Socket.IO 事件扩展
- **范围随编辑调整** → 当被评论的文本被修改时，评论位置需要随 OT 操作动态更新

实际上是 Track Changes 的子集/伴随功能，可行性与其绑定。如果实现了 Track Changes，评论功能额外增量约 500–800 行。

---

### 5. Sandboxed Compiles（沙箱编译）

**可行性：70% | 难度：★★★★☆**

**门控方式**：
- `services/clsi/config/settings.defaults.cjs:101-109` 物理检查 `DockerRunner.js` 是否存在
- CE 镜像中不包含此文件

**安全背景**：
> CE 中 LaTeX 编译与容器主进程同权限运行，可访问文件系统、网络和环境变量。官方明确警告：CE 仅适用于"所有用户均可信"的环境。非沙箱编译在多用户/生产部署中存在数据泄露或系统入侵风险。

**项目现状**：
- commit `462b3d64a2` 已实现 "sandboxed compiles via Docker sibling containers"
- `services/clsi/Dockerfile.dev` 已有基础的 TeX Live 容器

**实现路径**：
1. 编写 `DockerRunner.js`：通过 Docker API 为每次编译创建临时隔离容器
2. 容器配置：限制网络访问、挂载只读源文件、设置 CPU/内存/磁盘限额
3. 编译完成后销毁容器
4. 性能优化：容器预热池、TeX Live 镜像缓存

**Pro 版实现参考**：
- 使用 Docker sibling containers（通过挂载 `/var/run/docker.sock`）
- 预构建 TeX Live 镜像（`develop/texlive/` 目录）
- 支持配置 `SANDBOXED_COMPILES_SIBLING_CONTAINERS`

**风险**：中。Docker API 交互不难，难点在：
- 容器泄漏防护（编译超时/崩溃时清理）
- OOM Killer 处理
- 容器启动延迟对用户体验的影响（Pro 版用预热池缓解）
- Docker-in-Docker vs Sibling Containers 的权衡

---

### 6. Git Bridge

**可行性：80% | 难度：★★★☆☆**

**门控方式**：
- `Features.mjs:67` 检查 `Settings.enableGitBridge`
- 独立服务 `quay.io/sharelatex/git-bridge`（Java 应用）
- `GIT_BRIDGE_ENABLED`、`GIT_BRIDGE_HOST`、`GIT_BRIDGE_PORT` 环境变量

**代码库现状**：
- `services/web/app/src/Features/Project/ProjectController.mjs:958` — `gitBridgeEnabled` 已传递到前端
- `server-ce/test/git-bridge.spec.ts` — E2E 测试已区分 Pro enabled/disabled
- 前端已有 Git clone URL 的展示逻辑

**实现路径**：
- **方案 A（推荐）**：直接部署 Overleaf 官方开源的 [git-bridge](https://github.com/overleaf/git-bridge) 服务
  - 它本身是**开源的** Java 应用
  - 只需 Docker 部署 + 配置环境变量
  - 设置 `GIT_BRIDGE_ENABLED=true` 即可激活前端 UI
- **方案 B**：自实现轻量版
  - 用 Node.js 实现 Git HTTP backend
  - 对接 `docstore` 和 `filestore` API

**代码量预估**：方案 A 约 50 行配置；方案 B 约 2000 行

**风险**：低（方案 A）。Git Bridge 服务本身开源，主要是部署和网络配置工作。

---

### 7. GitHub 同步

**可行性：75% | 难度：★★★☆☆**

**门控方式**：
- `Features.mjs:65` 检查 `Settings.enableGithubSync`
- 前端插槽 `importProjectFromGithubModalWrapper`、`importProjectFromGithubMenu`、`editorLeftMenuSync` 均为空数组

**实现路径**：
1. OAuth App/GitHub App 注册
2. OAuth flow：用户授权 → 获取 access token → 存储
3. 导入：从 GitHub repo clone → 创建 Overleaf 项目
4. 导出/推送：Overleaf 项目变更 → 生成 commit → push 到 GitHub
5. 双向同步：pull → 检测冲突 → 合并或提示用户
6. UI：左侧菜单同步按钮、导入对话框、冲突解决界面

**代码量预估**：1500–2500 行

**风险**：中。双向同步的冲突处理是核心难点。Overleaf 的文档是 OT 模型，GitHub 是 Git snapshot 模型，两者的变更追踪范式不同。建议优先实现单向导出（Overleaf → GitHub），再考虑双向同步。

---

### 8. Symbol Palette（符号面板）

**可行性：85% | 难度：★★☆☆☆**

**门控方式**：
- `symbol-palette` 闭源模块不在 CE 的 `moduleImportSequence` 中
- `Features.mjs:7-8,91` 检查 `moduleImportSequence` 是否包含
- `ProjectController.mjs:965` 传递 `symbolPaletteAvailable` 到前端
- 前端插槽 `sourceEditorSymbolPalette` 为空数组

**实现路径**：
1. 构建符号数据库：LaTeX 符号表是公开知识，可从 [CTAN](https://ctan.org/pkg/comprehensive) 等来源整理
2. 前端组件：分类标签页 + 符号网格 + 搜索
3. CodeMirror 6 集成：点击符号 → 在光标位置插入对应 LaTeX 命令
4. 注册到 `overleafModuleImports.sourceEditorSymbolPalette` 插槽

**代码量预估**：500–1000 行（含符号数据）

**风险**：低。纯前端工作，不涉及后端逻辑，不影响核心编辑功能。

---

### 9. Templates（模板系统）

**可行性：90% | 难度：★★☆☆☆**

**门控方式**：
- `Features.mjs:70-71` 检查 `Settings.templates.user_id` 是否存在
- `OVERLEAF_TEMPLATES_USER_ID` 环境变量
- `ProjectController.mjs:737-738` 通过 `showTemplatesServerPro` 控制模板按钮显示
- `server-ce/test/templates.spec.ts` E2E 测试已有完整用例

**实现原理**：
- 指定一个"模板管理员"用户 ID
- 该用户的项目自动作为模板来源
- 其他用户可浏览模板列表 → 预览 → 从模板创建新项目

**实现路径**：
1. 模板列表 API：查询指定用户的所有项目并返回为模板
2. 模板预览页面：展示项目 PDF 预览、描述、标签
3. "从模板创建"：复制模板项目到当前用户
4. 设置 `OVERLEAF_TEMPLATES_USER_ID` 环境变量
5. 前端激活模板按钮（填充 `editorLeftMenuManageTemplate` 插槽）

**代码量预估**：500–800 行

**风险**：低。功能边界清晰，与核心编辑无耦合。

---

### 10. Managed Users（托管用户管理）

**可行性：60% | 难度：★★★☆☆**

**门控方式**：
- `services/web/config/settings.defaults.js:1092-1094` 中 `managedUsers: { enabled: false }`
- `services/web/app/src/models/Subscription.mjs:65-71` `managedUsersEnabled` 字段
- `UserMembershipController.mjs:69,144-169` 管理用户的 UI 逻辑

**功能说明**：
- 管理员可管理组内用户的账户生命周期
- 强制密码策略、限制功能、查看用户活动
- 用户离组时处理其项目

**实现路径**：
1. 扩展 Subscription 模型：添加 managed users 相关字段
2. 管理 API：邀请/移除用户、设置权限、强制策略
3. 用户端：被管理状态提示、权限限制
4. 管理界面：用户列表、批量操作

**代码量预估**：1000–2000 行

**风险**：中。涉及权限模型改动，需要仔细设计安全边界，避免权限提升漏洞。

---

### 11. Group SSO（组级 SSO）

**可行性：50% | 难度：★★★★☆**

**门控方式**：
- `services/web/app/src/models/Subscription.mjs:71,121` `groupSSO` 和 `ssoConfig` 字段
- `SubscriptionGroupController.mjs:88-93` 通过 Modules hooks 调用 `hasGroupSSOEnabled`
- `services/web/types/subscription/sso.ts` 定义 `SSOConfig` 类型

**与普通 SAML SSO 的区别**：
- 普通 SAML SSO：全站统一一个 IdP
- Group SSO：每个组/机构可以配置独立的 SSO provider
- 需要多 IdP 管理、组-IdP 动态关联、运行时 SAML 配置切换

**实现路径**：
1. 在 Subscription 模型中存储每组的 SSO 配置
2. 动态 SAML Strategy：根据请求来源选择对应的 IdP 配置
3. 组管理界面：配置 IdP metadata、测试连接
4. 用户关联：组内用户强制通过组 SSO 登录

**代码量预估**：2000–3000 行

**风险**：高。多租户 SSO 配置管理是企业级复杂度，安全敏感。

---

### 12. Admin Panel 增强

**可行性：80% | 难度：★★★☆☆**

**CE 现有功能**：
- Launchpad（首次创建管理员）
- 基础用户列表

**Pro 额外功能**（`server-ce/test/admin.spec.ts:99-216`）：
- **Manage Site**：站点全局设置
- **Manage Users**：高级用户管理（搜索、禁用、删除、权限）
- **Project URL Lookup**：通过 URL 查找项目
- **License Usage**：许可证使用情况仪表盘

**实现路径**：纯 CRUD 页面开发，Express 路由 + React 管理页面。

**代码量预估**：1000–1500 行

**风险**：低。标准的管理后台开发。

---

### 13. 优化版 TeX Live

**可行性：90% | 难度：★☆☆☆☆**

**现状**：
- 项目已有 `services/clsi/Dockerfile.dev` 安装了 TeX Live（latexmk、pdflatex、xelatex、中文支持）
- Pro 版的"优化"主要是：预编译格式文件（`fmtutil`）、字体缓存（`fc-cache`）、精简不必要的包

**实现路径**：
1. 在 Docker 镜像构建时运行 `fmtutil-sys --all` 预编译格式
2. 运行 `fc-cache -fv` 生成字体缓存
3. 使用 `tlmgr` 管理包安装，按需精简
4. 可选：构建多个 TeX Live 版本镜像供用户选择（2024、2025）

**风险**：极低。纯 DevOps 工作，不涉及代码逻辑。

---

## 推荐实施优先级

按**投入产出比**排序，分为四个梯队：

### 第一梯队：低成本高回报（建议优先实施）

| 优先级 | 功能 | 预估工作量 | 理由 |
|:------:|------|:----------:|------|
| P0 | 优化版 TeX Live | 1 天 | 已完成大部分，几乎零额外成本 |
| P0 | Git Bridge | 1–2 天 | 服务本身开源，只需部署配置 |
| P1 | Templates | 2–3 天 | 实现简单，用户价值高，有清晰的环境变量门控 |
| P1 | Symbol Palette | 2–3 天 | 纯前端，实现快，提升编辑体验 |

### 第二梯队：中等投入、企业刚需

| 优先级 | 功能 | 预估工作量 | 理由 |
|:------:|------|:----------:|------|
| P1 | LDAP 认证 | 3–5 天 | 企业环境刚需，社区方案成熟 |
| P2 | SAML SSO | 5–7 天 | 企业需求，比 LDAP 复杂但库支持好 |
| P2 | Admin Panel 增强 | 5–7 天 | 管理便利性提升，标准 CRUD |

### 第三梯队：较高投入、按需实施

| 优先级 | 功能 | 预估工作量 | 理由 |
|:------:|------|:----------:|------|
| P2 | Sandboxed Compiles | 1–2 周 | 安全性必要，已有基础，但容器管理复杂 |
| P3 | GitHub 同步 | 1–2 周 | 有用但非必须，双向同步是难点 |
| P3 | Managed Users | 1–2 周 | 大型部署才需要 |

### 第四梯队：高投入高风险

| 优先级 | 功能 | 预估工作量 | 理由 |
|:------:|------|:----------:|------|
| P4 | Track Changes + Comments | 3–6 周 | **最有价值但最难实现**，OT 耦合深，风险极高 |
| P4 | Group SSO | 2–3 周 | 除非多租户场景，否则不需要 |

---

## 关键结论

1. **约 60% 的 Pro 功能可以较低成本实现**：LDAP、SAML、Templates、Symbol Palette、Git Bridge、TeX Live 优化、Admin Panel 增强。这些功能要么有开源社区方案，要么代码库已预留了完整的扩展点。

2. **Track Changes 是最大的技术壁垒**：它与 OT 系统深度耦合，闭源模块不可见，实现风险极高。这也是 Overleaf 商业化的核心护城河。如果确定要做，建议：
   - 先深入研究 `libraries/ranges-tracker/` 的实现原理
   - 参考 [Yjs](https://github.com/yjs/yjs) 等开源 CRDT 框架的变更追踪实现
   - 考虑是否可以用我们已有的 AI Assistant Pending Changes 机制做一个简化版

3. **代码库已预留大量扩展点**：`Features.mjs` 的 feature flag、`moduleImportSequence`、`overleafModuleImports` 前端插槽等，使得很多功能只需"填充"而非"改造"。

4. **Sandboxed Compiles 项目已在推进**（commit `462b3d64a2`），这是多用户生产部署的安全性基石。

5. **不建议实现的功能**：安全补丁早期通知（商业服务，无法自实现）、Group SSO（除非明确有多租户需求）。

---

## 参考资料

- [Server Pro vs. Community Edition — 官方对比](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition)
- [Overleaf GitHub 仓库](https://github.com/overleaf/overleaf)
- [Git Bridge 开源仓库](https://github.com/overleaf/git-bridge)
- [Overleaf Toolkit — SAML 配置文档](https://github.com/overleaf/toolkit/blob/master/doc/saml.md)
- [ldap-overleaf-sl — 社区 LDAP 实现](https://github.com/smhaller/ldap-overleaf-sl)
- [Server Pro 5.2.1 发布说明](https://www.overleaf.com/blog/overleaf-server-pro-5-2-1-is-available)
- [Server Pro 5.4.0 发布说明](https://www.overleaf.com/blog/overleaf-server-pro-5-4-0-is-available)

---

## 实施记录

> 后续逐步实现时，在此处记录进度。

| 日期 | 功能 | 状态 | 备注 |
|------|------|------|------|
| — | — | — | — |

---

*文档创建日期: 2026-02-14*
