# Mini Agent Run 排查台

## 启动说明

### 1. 环境要求
- **Node.js 24 LTS**（推荐 `24.11.0` 或更新的 `24.x`）与 **npm**。

### 2. 安装依赖与配置环境变量
在仓库根目录（`mini Agent Run/`）执行：

```powershell
node --version
npm install
Copy-Item .env.example .env   # macOS / Linux 可用: cp .env.example .env
```
编辑依据.env.example `.env`，填写 `LLM_API_KEY`（也可以先跳过，启动后在页面左下角「设置」中填入，浏览器会本地保存并在发起排查时优先使用）

> **模型变更说明**：文档中提及的 `deepseek-chat` 接口已停用，所以项目改用`deepseek-flash`

### 3. 本地启动与访问
```powershell
npm run dev
```
- 前端页面：`http://localhost:5173`
- 后端服务：`http://127.0.0.1:3001`

### 4. 快速体验内置演示样例
点击左栏「新建排查会话」，选择内置演示目录 `data/fixtures/diagnostic-demo`（或单独选中其中任意文件）即可直接提问体验。
三份演示示例均来自TrajDebug数据集分别是两条τ²-Bench 中文客服和一条SWE-Bench Pro 代码修复，覆盖常规多步排查，执行较慢或出错以及输出体量较大三个场景。
---

## Vibe Coding 复盘

- **AI 工具**：使用Antigravity的Gemini-Neno模型做需求、项目方案以及UI设计的讨论，Codex的GPT6.2SOL执行Code搭建，GPT6.1-Astra做每阶段的验收，这么做主要是因为GPT比较死板所以适合来做Coding。
- **任务拆解**：我首先去网上找了相关的开源项目以及数据集并于Gemini展开讨论奠定项目的大体模型，随后与Gemini共同编写项目初版方案并完成总体架构、12 节点 Feature Graph（功能Graph） 与 SQLite 数据模型定版，再按「`M0` 项目框架以及Vibe Coding约束→ `M1` 路径沙箱/存储/排障工具等的基础构建 → `M2`Agent Loop 与 SSE/中断/重跑的Agent流程构建 → `M3` Vue 3 前端UI构建 → `M4` 端到端跑通一次闭环 → `M5` 数据实测与改进的小步推进；
- **问题 1**：在审阅 AI 生成的原型时，发现 AI 将右侧日志区误做成了「排查 Agent 自身的工具日志」，纠偏为以「被排查的原始轨迹文件」为主视图；后续测试又指出检视器写死无法拉伸/全屏、原文与 JSON 手动切换割裂且缺行号等UI问题并进行修订。
- **问题 2**：在View数据库初始化逻辑时，发现 AI 将 Run 回收写在 openAppDatabase() 中（早于端口监听），导致误启第二个进程即使因端口冲突退出，也会先把正在运行的服务任务误标为 failed；随后改为引入 SQLite 独占租约锁，确认接管数据库后再执行僵尸回收，彻底消除误伤隐患。
- **质量验证方式**：（1）把方案规划者，执行者，验收者分开避免上下文污染导致模型“投机取巧”（2）使用“规则转代码”沉淀 `G-01`~`G-07` 护栏与 `npm run verify` 五段确定性门禁，把项目约束、验收落实到Code约束上只有代码跑通了才能算通过才能进入下一阶段；（2）对并发状态机采用轻量 TLA+ 描述不变式并映射为 `fast-check` 属性测试。