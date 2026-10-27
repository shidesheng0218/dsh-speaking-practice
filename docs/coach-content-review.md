# 教练素材自检报告（v0.2 首批）

- 文件与条目：daily-chat.json（4 beats / 8 phrases）、job-interview.json（5 beats / 8 phrases）、topics.json 20 项、common-errors.md 20 条、drills.json 10 组最小对立体 + 30 句。
- 场景字段：id 与文件名一致；level、durationMinutes、goal、roles、opening、beats、usefulPhrases、successCriteria、wrapUp、recapFocus 均按 spec，无多余字段。
- job-interview beats 覆盖 self-intro / experience / challenge / motivation / questions-for-us；daily-chat 覆盖暖场、讲故事、观点、反问。
- topics.json：每项 id + prompt + 3 条具体 followups；覆盖日常、兴趣、旅行、工作、学习、科技、AI、健康、城市、文化差异、金钱、时间管理。
- common-errors.md：四列表格，类型分布为冠词 3、时态 2、单复数 2、介词 2、搭配 4、词性 5、中式表达 2。
- drills.json：覆盖 th、r-l、v-w、长短元音、辅音连缀、重音节奏；句子 6-15 词，id drill-01 至 drill-30 连续。
- JSON 校验：3 个 JSON 文件均已用 node -e JSON.parse 通过，UTF-8 无 BOM。
- 语言检查：英文自然可开口，中文解释均不超过 30 字，无政治宗教敏感内容。
- 可能问题：drills.json 的 focus 与 tipZh 是给教练看的，不会被朗读，接入时不要拼进朗读文本。
- 可能问题：句式/结构类错误归入“词性”与“中式表达”两类，若后续细分可加“句式”列值。
- 建议：src/coach.js 读取场景时按 id 选择，缺文件或字段时回退到 daily-chat，避免整个提示词注入失败。
- 建议：后续增加雅思 Part 2 场景卡与 B1 语法微练习，并给 topics 标 difficulty 字段。
- 未改动：content/coach.md、content/recap-template.md、profile.md、src/、scripts/、package.json。
