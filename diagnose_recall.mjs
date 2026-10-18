/**
 * diagnose_recall.mjs —— 真实开发对话自动采集召回率深度诊断
 */

import {
  mineEnvironmentFacts,
  mineArchitecturalDecisions,
  mineFailures,
  stripCodeBlocks,
} from "./gateway_harvest.js";
import {
  buildDialogueText,
  processDialogueAndHarvest,
} from "./gateway_harvest.hooks.js";

const TEST_SCENARIOS = [
  {
    name: "场景1: 用户明确说偏好/规范（统一改用 pnpm + 跑测试用 vitest）",
    category: "偏好/规范",
    expected: "产出记忆 (事实/工具规范)",
    body: {
      messages: [
        {
          role: "user",
          content: "我们团队约定好了，以后所有包管理统一改用 pnpm，别再用 npm 或 yarn 了。跑测试统一用 vitest。",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "收到！后续我会严格使用 pnpm 和 vitest。请确保本地安装了 pnpm：\n```bash\nnpm i -g pnpm\n```",
          },
        },
      ],
    },
  },
  {
    name: "场景2: 架构决策（技术栈选型与目录结构约定）",
    category: "架构决策",
    expected: "产出决策",
    body: {
      messages: [
        {
          role: "user",
          content: "架构上我们团队决定采用 Fastify 替换 Express 作为后端核心框架，所有路由中间件统一存放在 src/middlewares 目录中。",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "很好的决策，Fastify 的吞吐量比 Express 高不少。已记录架构选型：Fastify，中间件目录：src/middlewares。",
          },
        },
      ],
    },
  },
  {
    name: "场景3: 真实报错后给解法（典型开发报错+命令修复+通过）",
    category: "报错与解法",
    expected: "产出踩坑/解法",
    body: {
      messages: [
        {
          role: "user",
          content: "运行测试失败了，报错如下：\n```\nModuleNotFoundError: No module named 'pytest_asyncio'\n```\n怎么处理？",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "这是因为缺少 pytest-asyncio 依赖包。你可以运行以下命令安装：\n```bash\npip install pytest-asyncio\n```\n安装完成后重新运行测试：\n```bash\npytest tests/\n```\n运行结果：3 passed in 0.12s，已成功解决。",
          },
        },
      ],
    },
  },
  {
    name: "场景4: 纯技术讨论（React 原理探讨，不含具体规范）",
    category: "纯技术讨论",
    expected: "不产出 (0条)",
    body: {
      messages: [
        {
          role: "user",
          content: "你能解释一下 React 18 的并发渲染（Concurrent Mode）和 Fiber 架构的底层工作原理吗？",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "React Fiber 是一种基于链表的数据结构，它将渲染工作分解成小的工作单元（Fiber 节点）。在浏览器空闲时利用 requestIdleCallback 逐步执行调度，从而不会阻塞主线程。",
          },
        },
      ],
    },
  },
  {
    name: "场景5: 代码块为主（编写具体业务代码）",
    category: "代码块为主",
    expected: "不产出 (0条或仅通用)",
    body: {
      messages: [
        {
          role: "user",
          content: "帮我用 TypeScript 写一个带 immediate 参数的防抖函数 debounce。",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "这是防抖函数的实现：\n```typescript\nexport function debounce<T extends (...args: any[]) => any>(fn: T, wait: number, immediate = false) {\n  let timeout: any = null;\n  return function(this: any, ...args: Parameters<T>) {\n    const callNow = immediate && !timeout;\n    clearTimeout(timeout);\n    timeout = setTimeout(() => {\n      timeout = null;\n      if (!immediate) fn.apply(this, args);\n    }, wait);\n    if (callNow) fn.apply(this, args);\n  };\n}\n```",
          },
        },
      ],
    },
  },
  {
    name: "场景6: 闲聊",
    category: "闲聊",
    expected: "不产出 (0条)",
    body: {
      messages: [
        {
          role: "user",
          content: "今天周五了，感觉工作做完了好轻松啊！",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "祝贺！周末好好放松一下，祝你周末愉快！",
          },
        },
      ],
    },
  },
  {
    name: "场景7: 用户口语化指定偏好规范（含提示）",
    category: "口语化偏好",
    expected: "产出记忆",
    body: {
      messages: [
        {
          role: "user",
          content: "记住，以后写 Python 必须使用 python3，不要用 python2，并且统一用 ruff 格式化代码。",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "好的，我已经记住了：Python 环境使用 python3，代码格式化统一使用 ruff。",
          },
        },
      ],
    },
  },
  {
    name: "场景8: 端口冲突排查与服务启动报错（实际排查流程）",
    category: "报错与解法",
    expected: "产出踩坑/解法",
    body: {
      messages: [
        {
          role: "user",
          content: "启动开发服务器失败了：\n```\nError: listen EADDRINUSE: address already in use :::3000\n```\n帮我解决一下。",
        },
      ],
    },
    reply: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "3000 端口被占用了。你可以用以下命令干掉占用进程并重新启动：\n```bash\nkill -9 $(lsof -t -i:3000)\nnpm run dev\n```\n执行后服务正常启动，resolved。",
          },
        },
      ],
    },
  },
];

async function runDiagnosis() {
  console.log("=================================================================");
  console.log("【诊断开始】真实开发对话自动采集召回率与过度过滤检测");
  console.log("=================================================================\n");

  const results = [];

  for (let idx = 0; idx < TEST_SCENARIOS.length; idx++) {
    const sc = TEST_SCENARIOS[idx];
    console.log(`-----------------------------------------------------------------`);
    console.log(`[诊断用例 ${idx + 1}] ${sc.name} (${sc.category})`);
    console.log(`期望结果: ${sc.expected}`);

    const dialogueText = buildDialogueText(sc.body, sc.reply);
    const strippedText = stripCodeBlocks(dialogueText);

    console.log(`\n--- 1. buildDialogueText 产出 (${dialogueText.length} 字符) ---`);
    console.log(dialogueText);
    console.log(`\n--- 2. stripCodeBlocks 剥离后 (${strippedText.length} 字符) ---`);
    console.log(strippedText);

    const facts = mineEnvironmentFacts(dialogueText);
    const decisions = mineArchitecturalDecisions(dialogueText);
    const failures = mineFailures(dialogueText);

    // Mock client with list and create
    const inMemDB = { memories: [], pitfalls: [] };
    const mockClient = {
      list: async (table, filter) => {
        const rows = inMemDB[table] || [];
        return { ok: true, data: rows.filter((r) => r.content_fingerprint === filter.content_fingerprint) };
      },
      create: async (table, payload) => {
        if (!inMemDB[table]) inMemDB[table] = [];
        inMemDB[table].push(payload);
        return { ok: true, id: inMemDB[table].length };
      },
      select: async () => [],
    };

    const harvestRes = await processDialogueAndHarvest(dialogueText, { project: `__diag_p${idx}__` }, mockClient, {
      bypass_gate: true, // 诊断抽取能力本身
    });

    console.log(`\n--- 3. 抽取结果 ---`);
    console.log(`facts 命中数: ${facts.length}`, facts.map((f) => `[${f.category}] ${f.title}: ${f.content}`));
    console.log(`decisions 命中数: ${decisions.length}`, decisions.map((d) => `[${d.category}] ${d.title}: ${d.content}`));
    console.log(`failures 命中数: ${failures.length}`, failures.map((f) => `[pitfall] ${f.symptom} -> ${f.solution}`));
    console.log(`processDialogueAndHarvest 实际落库: memoriesSaved=${harvestRes.memoriesSaved}, pitfallsSaved=${harvestRes.pitfallsSaved}`);

    // 定位为什么产出或没产出
    let analysis = "";
    if (sc.category === "偏好/规范") {
      if (facts.length === 0) {
        analysis = "【漏采】卡在正则：现有 toolPatterns 不支持「统一改用 pnpm 别用 npm」等反向/倒序表达";
      } else {
        analysis = `【命中】采到 ${facts.length} 条`;
      }
    } else if (sc.category === "架构决策") {
      if (decisions.length === 0) {
        analysis = "【漏采】未匹配到决策";
      } else {
        analysis = `【命中】采到 ${decisions.length} 条 (${decisions[0].title})`;
      }
    } else if (sc.category === "报错与解法") {
      if (failures.length === 0) {
        analysis = "【漏采】stripCodeBlocks 把 ``` 代码块内的报错（ModuleNotFoundError/EADDRINUSE）或解法命令（pip install/kill）剥空，导致 mineFailures 提取为 0";
      } else {
        analysis = `【命中】采到 ${failures.length} 条`;
      }
    } else if (sc.category === "纯技术讨论" || sc.category === "代码块为主" || sc.category === "闲聊") {
      if (facts.length === 0 && decisions.length === 0 && failures.length === 0) {
        analysis = "【正常拦截】纯讨论/业务代码/闲聊未产生误报（符合预期）";
      } else {
        analysis = "【误报】本该为 0 但产生了噪音！";
      }
    } else if (sc.category === "口语化偏好") {
      if (facts.length === 0) {
        analysis = "【漏采】用户口语化表达未全覆盖";
      } else {
        analysis = `【命中】采到 ${facts.length} 条 (${facts.map(f=>f.title).join(", ")})`;
      }
    }

    console.log(`--- 4. 诊断结论: ${analysis} ---\n`);

    results.push({
      scenario: sc.name,
      category: sc.category,
      expected: sc.expected,
      factsCount: facts.length,
      decisionsCount: decisions.length,
      failuresCount: failures.length,
      memoriesSaved: harvestRes.memoriesSaved,
      pitfallsSaved: harvestRes.pitfallsSaved,
      analysis,
    });
  }

  console.log("\n=================================================================");
  console.log("【诊断汇总表】");
  console.log("=================================================================");
  console.table(results);
}

runDiagnosis().catch(console.error);
