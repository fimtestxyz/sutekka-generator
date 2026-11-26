# 调研简报 — 《1700万行代码与一个玩笑：AI“证明”黎曼猜想的罗生门》

- 专栏来源：用户供稿（2026-11-25）+ 主编核实
- 套装 slug：`riemann-rashomon`

## 事实清单（已核实，带来源）

- 2026-11-20，Anthropic 数学家 Levent Alpöge 在个人网站发 4 页说明，
  称与 Claude 合作“发现了黎曼猜想的一个证明”，并宣称覆盖更强的广义
  黎曼猜想（GRH）。来源：Wikipedia "Alpöge proof of the Riemann
  hypothesis"、Asahi Shimbun。
- 证明只以 Lean 形式化代码发布：约 **175,187 个文件、1,740 万行代码、
  818,755 个定理**，约 1GB，无注释。来源：Wikipedia、dev.to 统计、
  postcutoff 11-20 核查。
- 所谓“25 万页文字证明”：Alpöge 11-23 在社交媒体承认**只是玩笑**并
  道歉。来源：Wikipedia（引其 11-23 推文 "250,000+ pages was a joke
  guys!"）、Asahi。
- 11-21，Lean FRO 与 Mathlib Initiative 联合声明，对证明的陈述与证明
  本身“完全有信心”（full confidence）；Andrew Sutherland 独立编译通过。
  来源：postcutoff（引联合声明）、Wikipedia。
- 黎曼猜想 1859 年提出，167 年未解，克雷研究所千禧年难题，悬赏 100 万
  美元。来源：Wikipedia、KuCoin 转 WSJ。
- 发布时间与 Anthropic 上市次日重合：Alpöge 11-20 发布，Anthropic 前一
  日（11-19）IPO。来源：Asahi、WSJ。
- 质疑：J. L. Nielsen 11-20 发表论文《The Invalidity of Alpöge's
  Proposed Proof of the Riemann Hypothesis》（PhilArchive），指代码中
  `anyGeometry := fun _ _ _ => True` 的几何条件恒真，论证是同义反复
  （"Riemann to Riemann"）。来源：PhilArchive 原文、postcutoff 摘要。
- Andrew Granville 称公开材料“混乱不清”（garbled）。来源：postcutoff
  （引 Nature）。
- James Maynard 认为证明最终会被证实是正确的。来源：postcutoff（引
  Nature）。Thomas Bloom 表示 95% 以上有信心。来源：postcutoff。

## 专栏说法（未独立核实，按专栏口径采用）

- 丘成桐称“数论上的伟大贡献”“数学进入新纪元”；陶哲轩承认可能历史性，
  但强调“消化需要时间”，且目前只有“巨大、仅有 Lean 的证明”。
- James Maynard 称有 **98% 把握**认为证明正确。未核实到 98% 这一精确
  数字；可核实的最接近数字是 Thomas Bloom 的 95%+。贴纸沿用专栏的
  98%，QA 时记一笔。
- 初期 Google CEO Sundar Pichai 等科技界人士互动放大影响；反转后 Reddit
  等社区出现困惑与愤怒。
- Robert Edward Grant 指控 Claude 可能抄袭其此前工作。

## 利益相关方

| 方 | 立场 |
|---|---|
| Alpöge + Claude | 宣布者：相信证明成立，代码已编译通过 |
| Lean / Mathlib 社区 | 认证者：联合声明完全有信心 |
| Maynard、丘成桐、陶哲轩 | 谨慎积极：可能是里程碑，但需时间消化 |
| Granville、Nielsen | 尖锐质疑：材料混乱、恒真条件、疑似同义反复 |
| Anthropic（上市公司） | 商业方：发布时机与 IPO 次日重合 |
| 公众 / 社交媒体 | 先热后冷：从“历史性时刻”到困惑与愤怒 |

## 矛盾

证明“成立”的标准本身分裂了：机器说编译通过、社区联合认证；人类说
没人读过、读不懂、也还不能确认定义是否忠实、论证有无隐藏假设。一边
是形式的正确，一边是理解的缺席。

## 隐藏洞察

这件事真正的主角不是黎曼猜想有没有被解决，而是**证明的可理解性本
身成了问题**：当证明的体量远超人类可阅读极限，数学共同体赖以运作的
同行评议与可理解性基础就动摇了。形式化验证验证的是代码与所声称命
题的一致性，而不是命题在人类意义上的真理性——而这两者的缝隙，正是
这场罗生门长出来的地方。

## 编辑角度（一句话）

一张没人读过的证明，让所有人各说各话——这就是罗生门。

Tags: 黎曼猜想, 罗生门, AI证明, Lean

## 核实备注（主编留给 QA）

- 专栏第 7 点说 Lean/Mathlib“仅确认顶层定理陈述编译无误”——这个说法
  比实际弱：联合声明实际是“对陈述与证明完全有信心”，且多方独立编译
  通过。贴纸不直接引用这句，QA 时注意：不要把“仅编译通过”画成事实。
- “98%”按专栏口径采用，未独立核实。
- 丘成桐、陶哲轩、Pichai、Grant 的说法均来自专栏，未独立核实；贴纸
  不点名画真人，只画阵营（积极派 / 质疑派）。
