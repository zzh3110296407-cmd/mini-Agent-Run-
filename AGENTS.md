# AGENTS.md

> **执行说明**：本工作区的完整 Codex 执行记忆与 Vibe Coding 自动化协议统一维护在上级目录 `../AGENTS.md`，动态开发状态统一维护在 `../STATE.md`。
>
> **在 `mini Agent Run/` 内启动 Codex 时，必须首先读取 `../AGENTS.md` 与 `../STATE.md`，并严格遵守以下核心协议**：
> 1. **单写状态与只读边界**：仅在 `../STATE.md` 记录进度、护栏与熔断结果；按需只读 `../README.md` 与 `../resource/`；**禁止在开发期修改本目录 `README.md`**（最终交付文档）；遇模糊需求先向用户确认，禁止脑补与顺手大改无关代码。
> 2. **冷启动与标准闭环**：业务编码前先搭通最小 `npm run verify` 门禁骨架；后续改动按「对齐 Feature Graph（若已建立）→ 补齐确定性测试（≥2 次复用流程封装为非交互、标准退出码的 `scripts/cli` 子命令）→ 跑绿 `npm run verify` → 小步提交并写回 `../STATE.md`」执行。
> 3. **防绕过红线**：严禁通过 `@ts-ignore` / `@ts-expect-error` / `eslint-disable`、`.skip`、弱化断言或放宽护栏脚本来换取门禁通过。
> 4. **规则转代码（带效率校准）**：仅针对可复发、高风险错误下沉为 TS / ESLint / `scripts/check-guardrails.mjs` / 测试断言，验证拦截有效后登记到 `../STATE.md`。
> 5. **复杂技术熔断**：同一复杂技术连续失败 2~3 次立即停手，降级简单方案、写入 ESLint 封禁并登记到 `../STATE.md`（禁用 `pnpm`、不引入 Lean；`verify:ui` 优先 Bombadil，受阻即降级 Playwright + `fast-check`）。
