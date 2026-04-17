# 三信号归因执行进度

| 步骤 | 状态 | 说明 |
|------|------|------|
| 1. 修复正文命中策略（支持片段/特征行） | ✅ 完成 | `bodyCore` 全文命中失败时，回退 `keyLines` 片段命中 |
| 2. 去除 Notion `Completion Time` 硬编码 | ✅ 完成 | 查询/排序改为 `notion_property_names.executed_at` |
| 3. 强化实体抽取（兼容更多文本形态） | ✅ 完成 | 增加 CJK 短语与小写短语提取 |
| 4. 校验并回归（语法 + lints） | ✅ 完成 | `node --check` + `ReadLints` 均通过 |

**整体进度：100%**
