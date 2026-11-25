# 调研简报 — Lauren Tan 与 20 个 AI Agent

- 套装 slug：`lauren-tan-20-agents`
- 专栏标题：《当工程师开始“管理”20个AI Agent：Lauren Tan的激进实验》
- 专栏原文：`column.md`（逐字存放，见 SPEC §3）
- 调研人：Muse（主编）
- 结论：专栏核心事实**已核实**，一处数字有误、两处数字因讲述版本不同而浮动（见“核实标记”）。

## 已核实的核心事实

1. **Lauren Tan（@poteto）**，Grok Bot 工程师，SpaceX AI；此前 Cursor、
   Meta React Compiler、Netflix。来源：其演讲实录与多篇报道。
2. **演讲标题即数字来源**：《How I Shipped 2000 PRs Last Month —
   Trusting AI Agents》。她原话：“上个月我向生产环境合并了 2000
   个 PR。”专栏的“2000 到 2500”与此基本一致。
3. **醒来 20 个 PR 已合并**：她原话——早上醒来，约 20 个 PR 已经
   合并进主干且通过了事后检查。多来源一致。
4. **信任曲线**：她的方法论核心词。起初像微观管理者一样盯着每
   一次输出、无法并行；五个月后醒来收 20 个 PR。曲线本身是她的
   讲述框架，不是科学测量。
5. **架构护栏（Dune）**：Grok Bot 的 agent 友好框架（“Electron 应用
   的 Next.js”）。她用 600+ 个 PR 把 Grok Bot 重构成 Dune。约束包括：
   产品代码中**禁用 useEffect**（只允许在 Dune 内部 API 中使用）；
   **99% 的代码注释被禁**（Agent 会拿注释当借口，为错误解法辩护）；
   ElectronMain 与 ElectronRenderer 之间**禁止跨层 import**，由依赖
   图分析 + Lint 在 CI 中硬性拦截。
6. **失败变检查**：Agent 每犯一次错，教训先写进代码库设计或确定
   性检查（Lint/CI），最后才是文字规则。她的原话逻辑：不要在对话
   里反复纠正，要让错误写不出来。
7. **Dr. Eggbot 真实存在**：设计并审计其他 Bot 的 Bot，出自 2026 年
   10 月 4 日 Behind the Craft 播客（Peng Zheng + Lauren 展示的 14 个
   Bot 之一），见工作室已有的 Lauren Tan 研究（`lauren-tan-agent-study/
   GROK-WORK.md`）。x.ai/bot/marketplace/bots/dr-eggbot-v2。
8. **Netflix 管理背景**：她 2020 年 2 月离开 Netflix 管理岗位回归工程
   ——确实做过 Engineering Manager（同上研究，AGENT-METHOD.md）。
9. **小团队与权限隔离**：Bot 团队保持极小，从零技能起步；Bot 有
   独立邮箱与账号；首席幕僚（Chief of Staff）+ 项目经理 + 执行 Bot
   的分层见于她的讲述与 X 帖（1 名幕僚长 + 3 名经理 + 11 名执行 =
   15 名，另一说法为 20+ 名，见标记 3）。
10. **米其林厨房比喻**：她不用“软件工厂”的说法，而用米其林厨房
    ——环境（设备、制度、约束）决定产出质量。
11. **pstack 公开**：github.com/backnotprop/pstack，23 个 Playbook 与
    20+ 条工程原则，是她这套方法在 Cursor 场景的打包。

## 核实标记（贴纸不得越过这些线）

1. **Token 数字有误，不得印专栏的数字。** 专栏写“每天消耗约
   150 亿 token”。查到的报道是：她的 Cursor 个人页显示**过去 30
   天用了 1.5 万亿 token**（约合每天 500 亿），第三方按每百万
   token 8 美元估算约每天 38.4 万美元、年化 1.32 亿美元。150 亿/天
   与查到的数字对不上（约为其三分之一）。贴纸上不要出现任何
   token 消耗数字；如提成本，只写“用量远超普通套餐”这类定性表述。
2. **PR 月数因讲述版本而浮动。** 同一演讲的不同转述：上月约
   1000 个、当月 12 天内近 800 个、演讲标题 2000 个、后期报道约
   3000 个（个人）与 11000 个（全队），团队 revert 率约 0.5%。
   贴纸只印演讲标题的 **2000**（“上个月 2000 个 PR”），不印 2500
   或 3000。
3. **Bot 数量有多个说法。** 专栏写“20 多个”；X 帖一版为 15 名
   （1 幕僚长 + 3 经理 + 11 执行）；她本人在另一处说“20 多个
   GrokBot agent”。“20+”是她自己的说法之一，可用；不要印“15”
   或“25”这类单一数字。
4. **公司名以她的说法为准。** 她原话是 “Grok Bot at SpaceX AI”；
   专栏写 xAI。贴纸写 Grok Bot / SpaceX AI，不写 xAI。
5. **“同一个失败出现两次才固化成 Skill”**：专栏表述，与她“失败
   变检查”的方法一致；“两次”这个次数未在本次核查中单独找到
   来源，点文案中可写，但不要作为标题数字。
6. **不画真人。** Lauren Tan 本人不画可辨认形象；出现时只画通用
   剪影/背影。本套主角是海洋组三只角色（泡泡/章章/企企）。

## 贴纸上可用的数字与短语（已核实）

- 2000（上个月合并的 PR 数，演讲标题）
- 20（醒来时已合并的 PR 数）
- 600+（重构 Grok Bot 到 Dune 的 PR 数）
- 99%（被禁的代码注释比例）
- useEffect（禁用）、Dr. Eggbot（设计并审计 Bot 的 Bot）
- 信任曲线、米其林厨房、护栏、控制点前移

## 来源

- 演讲实录《How I Shipped 2000 PRs Last Month — Trusting AI Agents》
  （usetranscribe / youtubesummary 转录）
- 《All Code Is Slop (Except Mine) — Lauren Tan, SpaceXSI》
  （newsfilter.io，2026-11-14）
- 《3,000 PRs a Month, But First: Lauren Tan on Turning Agent Mistakes
  into Checks》（paulkuo.tw，2026-11-19）
- GrokBot Team: Lauren Tan on Trust, Verification, and Dune
  （mikesblogdesign.com）
- 《Burning 1.5 trillion tokens a month…》（eyas.cc，1.5 万亿 token/月）
- Lauren Tan's multi-agent trust engineering（tenten-skills-knowledge-base）
- 工作室已有研究：fimtestxyz/lauren-tan-agent-study（GROK-WORK.md、
  AGENT-METHOD.md、SOURCES.md）
