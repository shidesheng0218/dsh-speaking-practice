# 教练素材格式规范（v0.2）

> 所有素材是纯文本，插件在 `/voice on` 时读取、拼进该系统提示词（agent 作用域，只在当前会话生效）。
> 不要在这些文件里使用会与 DSH 提示词变量冲突的语法；插件按原文拼接（section 设置 `interpolate: false`），但请避免无意义的双花括号。

## 目录结构

```
content/
├── coach.md                     # 教练协议（Lead 维护，其他人不要改）
├── recap-template.md            # 复盘文件模板（Lead）
├── scenarios/
│   ├── daily-chat.json
│   └── job-interview.json
├── topics.json                  # 20 个话题骨架
├── corrections/common-errors.md # 20 条中文母语者高频错误
└── pronunciation/drills.json    # 30 句跟读句 + 最小对立体
profile.md                       # 学习者画像（Lead 维护）
```

## scenarios/*.json 字段（严格）

```jsonc
{
  "id": "job-interview",            // 小写连字符，与文件名一致
  "name": "English Job Interview",
  "nameZh": "英文面试",
  "level": "B1-B2",                 // A2 / A2-B1 / B1 / B1-B2 / B2 / B2-C1
  "durationMinutes": 12,
  "goal": "一句话：本次练习结束时学习者应完成什么",
  "roles": {
    "coach": "你在场景中扮演谁、语气如何",
    "learner": "学习者扮演谁"
  },
  "opening": "教练开口的第一句话（英文，1-2 句，自然）",
  "beats": [                        // 3-5 个推进节点，按顺序
    { "id": "intro", "intent": "这一轮想让学习者说什么", "coachMove": "教练该做什么/追问什么" }
  ],
  "usefulPhrases": ["I'd describe myself as...", "..."],   // 6-10 条学习者可直接用的句型
  "successCriteria": ["...", "..."],                        // 3-5 条可观察的完成标准
  "wrapUp": "场景结束时的收尾引导（英文）",
  "recapFocus": ["本场景复盘时优先检查的 2-4 个点"]
}
```

## topics.json（数组，20 项）

```jsonc
[{ "id": "morning-routine", "prompt": "英文话题句（1 句，适合直接问学习者）",
   "followups": ["追问 1", "追问 2", "追问 3"] }]
```
覆盖：日常/兴趣/旅行/工作/学习/科技/AI/健康/城市生活/文化差异/金钱/时间管理 等，不要敏感政治宗教内容。

## corrections/common-errors.md（20 条）

Markdown 表格，四列：错误例句（英文） | 更自然的说法（英文） | 中文解释（1 句） | 类型（冠词/时态/单复数/介词/搭配/中式表达/词性）。
选择中文母语者真正高频的错误，错误例句要真实自然（例如 "I very like this movie."）。

## pronunciation/drills.json

```jsonc
{
  "minimalPairs": [{ "pair": ["ship", "sheep"], "focus": "短元音 /ɪ/ vs 长元音 /iː/" }],
  "sentences": [{ "id": "drill-01", "focus": "th 音", "text": "I think this is the third thing.", "tipZh": "舌尖轻触上齿" }]
}
```
共 10 组最小对立体 + 30 句跟读句，句子 6-15 词，覆盖 th / r-l / v-w / 长短元音 / 辅音连缀 / 重音节奏。

## 写作要求

- 英文素材面向 B1 左右学习者，自然、可开口，不要教科书腔。
- 教练动作要具体（"追问最近一次项目里的冲突"，不要"深入交流"）。
- 中文解释简短（≤30 字）。
- 输出纯 UTF-8，JSON 必须能被 `node -e "JSON.parse(...)"` 解析。
