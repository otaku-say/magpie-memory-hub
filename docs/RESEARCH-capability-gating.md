# 同类项目调研：能力门控与环境作用域

调研日期：2026-10-30。目的：解决两类线上幻觉。

1. **无 MCP 客户端被命令调工具**（ishellpro）：注入文本里写死
   `magpie-memory-hub_memory_context`，而客户端根本没注册该工具，模型只能幻觉调用或编造「已保存」。
2. **跨环境记忆污染**（openminis，arm64 alpine ish）：Windows 专属记忆被注入沙箱会话，
   agent 进而去调 cindy 的 Win 平台工具。

均为公开仓库，逐条结论都能在源码里对应到行。

---

## 一、claude-mem（thedotmack/claude-mem）

**指令按运行时生成的典范。**`src/shared/memory-instructions.ts` 对外导出的是生成器：

```ts
export function memoryInstructionsForRuntime(runtime: 'worker' | 'server'): string {
  return MEMORY_PLUGIN_INSTRUCTIONS.split('\n').map(line => {
    if (runtime === 'server' && line.includes('Worker runtime:')) return line.slice(0, line.indexOf('Worker runtime:')).trimEnd();
    if (runtime === 'worker' && line.startsWith('Server runtime:')) return '';
    return line;
  }).filter(Boolean).join('\n');
}
```

三条可直接照搬的规则：

- **不适用运行时的句子整行删除**，不是保留 + 免责声明。删除的工具名不可能被调用。
- 显式点名不可用能力：`Dumb search is unavailable in this runtime.`（断言式，不是「可能不支持」）。
- 两条硬约束原文：
  - `Use only tools and argument names advertised by the active connection`
  - `A hosted read-only connector may expose searches without write tools; do not call a missing write tool.`

## 二、basic-memory（basicmachines-co/basic-memory）

**「不可用就不说」+ 「保存必须是真的」。**`integrations/hermes/__init__.py:1217`：

```python
def system_prompt_block(self) -> str:
    if not self._initialized:
        return ""          # ← 工具没就绪时返回空串，一个工具名都不写
    return (
        "**Use the `bm_*` tools directly — do not shell out to the `bm` CLI.** "
        "These tools route through a persistent MCP connection (~0.1s/call); ..."
        "**Saves must be real.** ... Never say information was saved ... "
        "unless the tool call returned a result, and when confirming a save quote "
        "the `permalink` from that result — never a filename recalled from memory.\n"
    )
```

四个可移植点：

1. **就绪门**：provider 未初始化 → 返回 `""`。
2. **理由**：`~0.1s/call` vs `~1-2s`。它的 CHANGELOG（`integrations/hermes/CHANGELOG.md:51`）
   明确记录：中性措辞不够，模型会凭训练记忆的惯性去 shell 调 `bm`，**必须给一句话理由**。
3. **「Saves must be real」**：不得声称已保存，确认时要引用返回的 `permalink`。
4. **提示词本身有测试锁定**：`integrations/hermes/tests/test_prompts.py` 断言
   `"Never say information was saved" in out`。措辞回退直接红。

另一个细节在 `get_tool_schemas()` 的注释里：宿主在 **register 时**快照 schema，
所以 schema 必须静态返回，运行期可用性用 `handle_tool_call()` 门控。
→ **注册期与调用期是两层门控，别混在一起。**

## 三、mem0（mem0ai/mem0）

**最彻底的一招：召回与写入都不依赖工具。**

- 召回：hook 把检索到的记忆直接作为 `additionalContext` 注入（`integrations/*/core/hook_runner.py:92`），
  agent 不需要发起任何调用。
- 写入：`core/memory_cli.py` 是唯一写入通道，skills 只是薄封装
  （`skills/*/SKILL.md`，带 `disable-model-invocation: true`）。
- 作用域：`mem0/memory/main.py` 用 `user_id / agent_id / run_id` 三个实体维度隔离，
  `ENTITY_PARAMS` 显式收窄——**其中 `agent_id` 正是我们之前缺失的维度**。

启示：MCP 只能是**加速通道**，不能是唯一通道。任何 agent 都有 bash/文件系统。

## 四、mcp-memory-service（doobidoo/mcp-memory-service）

`harvest/` 把知识分 `decision / bug / convention / learning / context` 五类
（`harvest/patterns/en.yaml`），但**分类维度里没有「环境/平台」**。
这解释了这类插件普遍在多端场景翻车：提炼时把「Windows 上要用 X」写成无修饰的普遍事实。
另一点可借鉴：它的质量评分支持人工 `-1 / 0 / +1`，模型可以自己表达「这条错了」。

---

## 五、结论映射到本插件

| 外部实证 | 本仓库落地 | 位置 |
|---|---|---|
| basic-memory：未就绪返回空串 | 档 0：`hasTools === false` → 整块不注入 | `inject-builder.js` |
| claude-mem：按运行时裁剪 | 档 1：「能力未确认」，一个具体工具名都不写 | 同上 |
| claude-mem：只信通告清单 | `detectCapabilities()` 从 `body.tools` 提真实名 | `capability.js` |
| basic-memory：Saves must be real | 「保存必须是真的」+ 引用返回 id | `buildReadyGuide` |
| claude-mem：do not call a missing write tool | 「禁止换名重试」硬条款 | 同上 |
| mem0：`agent_id` 维度隔离 | `client_profiles` → `env.agent` | `buildEnv` |
| mem0：召回/写入不绑工具 | 零工具通道 `memory-cli.js` + `cli_channel` | `memory-cli.js` |
| basic-memory：作用域靠客观信号 | 身份取自 `x-magpie-agent` 头 / `ctx.agent` | `resolveAgentKey` |
| mcp-memory-service：缺环境维度 | `env_scope` 真列 + 召回硬门 | `schema.js` / `request-inject.js` |
| mcp-memory-service：人工评分 | 负反馈复用 `memory_forget` | 已有 |
| basic-memory：提示词有测试锁定 | `test_v700_capability_gate.mjs` | `tests/` |

---

## 六、真机测试挖出来的一个设计错误（值得记）

v7.0.0 首版把 `env_scope` 的「未知维度」定为 **fail-open**（环境不知道就放行）。
真机网关测试立刻暴露：ishellpro 没有 os 画像，于是依然收到了
「必须用 cindy 的 Win 平台工具改注册表」这条准则——等于把最大的风险留在默认路径上。

修正为 **fail-closed**：带作用域的记忆必须正向确认环境才召回；
没有作用域的记忆（绝大多数）完全不受影响。开关 `env_scope_strict`（默认 `true`）。

连带教训：这条测试最初用 `title` 做负向断言，而 principle 块只渲染 `content`——
title 本来就不会出现，所以**整条准则真的漏进去也照样绿**。
现改为拿 `content` 特征串断言，并补一条正向对照，防止假绿重现。
