<h1 align="center">
  <br>
  研墨 (ResInk AI)
  <br>
</h1>

<h4 align="center">AI-Powered Academic Writing Platform</h4>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#development">Development</a> •
  <a href="#license">License</a>
</p>

---

## 简介

**研墨 (ResInk AI)** 是基于 [Overleaf Community Edition](https://github.com/overleaf/overleaf) 构建的智能学术写作平台，通过深度集成大语言模型（LLM），为学术写作提供 AI 辅助能力。

### 核心特性

- **🤖 AI Writing Agent**：多轮对话式写作助手，支持 SSE 流式输出和断点续传
- **📝 Smart Document Operations**：智能文档读写、编辑、创建、删除、搜索
- **🔍 Deep Review**：协调器模式的深度论文审阅，并行执行多维度分析
- **✨ Quick Edit**：选中文本即时改写/翻译/改述，无需创建会话
- **⚡ Tab Autocomplete**：Ghost Text 行内代码补全（500ms 防抖）
- **🎯 Skill System**：可扩展技能系统，通过 `.md` 文件定义 AI 能力
- **🔄 Agent Delegation**：支持委派子任务到专门的 Agent 执行
- **🖼️ Multimodal Support**：聊天上传图片，AI 可读取项目中的图片文件
- **💾 Memory System**：项目级规则记忆（Project Rules）
- **📊 Token Monitoring**：实时 Token 用量监控和上下文压缩

### 技术亮点

- **同步编辑流**：ConfirmationChannel 阻塞式变更确认机制
- **五级模糊匹配**：Replacer Chain 确保代码编辑精确应用
- **工具池设计**：按 Agent 类型动态构建工具注册表
- **Thinking Block**：可视化 AI 推理过程（可折叠 Streamdown 渲染）
- **应用变更导航**：跳转/撤销已应用的 AI 编辑
- **独立补全模型**：Tab Autocomplete 使用专门的低延迟模型配置

---

## Quick Start

### 前置要求

- Docker Desktop 或 Docker Engine
- 8GB+ 内存，20GB+ 磁盘空间
- LLM API Key（OpenAI 兼容格式）

### 一键部署

```bash
# 1. 克隆仓库
git clone https://github.com/your-org/vibe-writing.git
cd vibe-writing

# 2. 配置环境
cp develop/dev.env.local.example develop/dev.env.local
# 编辑 dev.env.local，填入 OPENAI_API_BASE、OPENAI_API_KEY、OPENAI_MODEL

# 3. 启动部署脚本
cd develop
./bin/init
```

部署脚本会自动：
- ✅ 检测 Docker 和网络环境
- ✅ 引导配置 AI 模型
- ✅ 构建所有服务镜像
- ✅ 启动 17 个微服务容器
- ✅ 运行冒烟测试（含 AI 连通性验证）

完成后访问 **http://localhost:18080**

> 详细部署文档见 [docs/deploy.md](docs/deploy.md)（含 AI 辅助部署、故障排除、网络适配）

### 端口映射

| 服务 | 端口 | 说明 |
|------|------|------|
| Webpack | `18080` | 前端开发服务器（浏览器入口） |
| Web API | `13000` | Express 后端 API |
| AI Agent | `43060` | AI 写作助手服务 |
| MongoDB | `37017` | 数据库（调试用） |
| Redis | `36379` | 缓存（调试用） |

---

## Architecture

### 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (React)                       │
│  ┌──────────────┐  ┌────────────────┐  ┌─────────────────┐ │
│  │ CodeMirror 6 │  │ AI Assistant   │  │ Quick Edit      │ │
│  │ + Extensions │  │ + Chat UI      │  │ + Diff Panel    │ │
│  └──────────────┘  └────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Web Service (Express)                     │
│  /api/ai/* ──► AIAssistantProxy ──► ai-writing-agent:3060  │
│  /internal/ai/attachment ──► AIAttachmentController         │
└─────────────────────────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              AI Writing Agent (Node.js)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  AgentLoop   │  │  ToolPool    │  │ SkillRegistry│      │
│  │  (SSE Stream)│  │  (Dynamic)   │  │ (.md files)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────────────────────────────────────────┐      │
│  │  LLMAdapter (OpenAI Compatible API)              │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Overleaf Services                         │
│  document-updater │ real-time │ clsi │ docstore │ ...       │
└─────────────────────────────────────────────────────────────┘
```

### 核心服务

| 服务 | 职责 | 技术栈 |
|------|------|--------|
| **web** | HTTP 前端，UI/API/认证 | Express + React + Pug |
| **ai-writing-agent** | AI 后端，AgentLoop/工具/Skill | Node.js + OpenAI SDK |
| **document-updater** | 文档实时更新（OT 算法） | Node.js + Redis |
| **real-time** | WebSocket 实时通信 | Socket.IO |
| **clsi** | LaTeX 编译服务 | Node.js + TeX Live |
| **docstore** | 文档 CRUD | Node.js + MongoDB |
| **filestore** | 文件存储（S3 兼容） | Node.js + MinIO/S3 |
| **project-history** | 项目历史版本 | Node.js + PostgreSQL |
| **history-v1** | Blob 去重存储 | Node.js + PostgreSQL |

---

## Development

### 开发命令

```bash
cd develop

# 启动所有服务
./bin/up

# 开发模式（源码热重载）
./bin/dev

# 查看日志
./bin/logs                     # 所有服务
./bin/logs ai-writing-agent    # 单个服务

# 进入容器调试
./bin/shell ai-writing-agent
./bin/shell mongo              # MongoDB shell

# 重新构建服务
docker compose build web
docker compose up -d --force-recreate web

# 更新 AI 配置（修改 dev.env.local 后）
./bin/reseed-ai-config

# 运行冒烟测试
./bin/smoke

# 停止所有服务
./bin/down
```

### 环境变量配置

编辑 `develop/dev.env.local`：

```bash
# 必填：LLM API 连接信息
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_API_KEY=sk-your-api-key
OPENAI_MODEL=gpt-4o

# 可选：自动补全独立配置
AUTOCOMPLETE_API_BASE=https://api.openai.com/v1
AUTOCOMPLETE_API_KEY=sk-your-api-key
AUTOCOMPLETE_MODEL=gpt-4o-mini

# 可选：首次启动自动创建管理员
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password

# 可选：Node 原生模块编译镜像（国内用户）
NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
```

### 代码规范

- **ESLint**：`eslint-config-standard` + TypeScript
- **文件命名**：kebab-case
- **类命名**：PascalCase
- **函数命名**：camelCase
- **常量命名**：UPPER_SNAKE_CASE
- **模块系统**：ES Modules（`.mjs` / `.js` with `"type": "module"`）

### 测试

```bash
# 单元测试
npm run test:unit

# 集成测试
npm run test:acceptance

# 前端测试
npm run test:frontend

# 类型检查
npm run types:check
```

### 关键文件索引

#### 前端

- `services/web/frontend/js/features/ai-assistant/` - AI 助手前端
  - `api/ai-api.ts` - AI API 层
  - `components/ai-assistant-pane.tsx` - 主面板
  - `components/ai-quick-edit-toolbar.tsx` - 悬浮工具栏
  - `extensions/ai-autocomplete.ts` - Tab 补全扩展

#### 后端

- `services/ai-writing-agent/app/js/` - AI 后端核心
  - `agent/AgentLoop.js` - 多轮对话循环
  - `agent/ConfirmationChannel.js` - 同步确认通道
  - `tool/ToolPool.js` - 工具池（动态注册）
  - `skill/SkillRegistry.js` - 技能注册表
  - `memory/MemoryManager.js` - Memory 系统
  - `adapter/LLMAdapter.js` - LLM 适配器

---

## AI Features Deep Dive

### 1. AgentLoop（多轮对话）

```javascript
// SSE 流式输出 + 断点续传
POST /api/ai/sessions/:id/messages
{
  "message": "帮我优化这段代码的性能",
  "context": { "currentDocId": "...", "selection": "..." },
  "resumeFromTurn": 3  // 可选：从第 3 轮恢复
}
```

- 使用 AsyncGenerator 实现流式响应
- 支持中断后从任意轮次恢复
- 自动管理上下文窗口（压缩 + Token 监控）

### 2. Skill System（技能系统）

技能通过 Markdown 文件定义：

```markdown
---
name: code-review
description: Review code for bugs and best practices
category: development
---

You are an expert code reviewer. Analyze the provided code for:
- Potential bugs and edge cases
- Performance issues
- Security vulnerabilities
- Code style and best practices
```

调用方式：
```javascript
{
  "tool": "activate_skill",
  "arguments": { "skillName": "code-review" }
}
```

### 3. Quick Edit（无会话编辑）

```javascript
POST /api/ai/quick-edit
{
  "action": "rewrite",       // rewrite | translate | paraphrase
  "text": "原始文本",
  "instruction": "Make it more concise",
  "targetLanguage": "en"     // translate 时必填
}
```

特点：
- 无需创建会话，即时响应
- 直接返回结果，无流式输出
- 适用于选中文本的快速改写

### 4. Tab Autocomplete（行内补全）

```javascript
POST /api/ai/autocomplete
{
  "fileName": "main.tex",
  "cursorPosition": { "line": 42, "ch": 15 },
  "prefix": "...光标前 2000 字符",
  "suffix": "...光标后 500 字符"
}
```

- 使用独立的低延迟模型（默认 `gpt-4o-mini`）
- 500ms 防抖，减少 API 调用
- FIM（Fill-In-the-Middle）风格提示
- Tab 接受 / Esc 取消

---

## Contributing

欢迎贡献！请遵循以下流程：

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feat/amazing-feature`)
3. 遵循代码规范和测试要求
4. 提交变更 (`git commit -m 'feat: add amazing feature'`)
5. 推送到分支 (`git push origin feat/amazing-feature`)
6. 创建 Pull Request

### Commit 规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不改变逻辑）
- `refactor`: 重构
- `test`: 测试
- `chore`: 构建/工具/杂务

---

## Overleaf Upstream

本项目基于 [Overleaf Community Edition](https://github.com/overleaf/overleaf) 构建。核心 LaTeX 编辑器、协作编辑、编译服务等功能来自 Overleaf。

### 与上游的差异

详见 `OVERLEAF-PATCHES.md`，主要改动：

- AI Assistant 集成（前端 + 后端）
- 管理员面板模块
- GitHub OAuth 登录
- Tab Autocomplete 扩展
- Quick Edit 悬浮工具栏
- 多模态图像支持

### 上游同步

```bash
# 添加 Overleaf 官方仓库为 remote
git remote add upstream https://github.com/overleaf/overleaf.git

# 拉取上游更新
git fetch upstream

# 合并上游主分支（需要解决冲突）
git merge upstream/main
```

---

## License

本项目代码遵循 **GNU AFFERO GENERAL PUBLIC LICENSE, version 3**。详见 [LICENSE](LICENSE) 文件。

### 版权声明

- **Overleaf 核心代码**：Copyright (c) Overleaf, 2014-2025
- **研墨 AI 扩展**：Copyright (c) ResInk AI Contributors, 2024-2026

---

## Authors

### 研墨团队

- 项目维护者：[@lifeiyu](https://github.com/lifeiyu)
- 贡献者列表：[CONTRIBUTORS.md](CONTRIBUTORS.md)

### Overleaf 原作者

[The Overleaf Team](https://www.overleaf.com/about)

---

## Acknowledgments

感谢以下开源项目：

- [Overleaf](https://github.com/overleaf/overleaf) - 核心 LaTeX 编辑器
- [CodeMirror 6](https://codemirror.net/) - 代码编辑器框架
- [React](https://react.dev/) - 前端 UI 框架
- [OpenAI](https://platform.openai.com/) - LLM API 标准

---

<p align="center">
  Made with ❤️ by the ResInk AI Team
</p>
