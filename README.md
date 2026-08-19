# pending_invoice_checker

兴趣岛「待确认发票识别器」— 郑老师待确认发票识别 Skill。

批量拉取兴趣岛「开票审核」中状态为 **待确认** 的订单，逐个校验发票抬头/税号格式并查重企微表格，最终输出 `.md` 报告（主订单ID / 是否确认开票 / 备注）供人工确认。

> 本 skill **只读**，不修改/删除/创建任何订单或发票数据，也不进入后续开票流水线。

## 内容结构

```
pending_invoice_checker/
├── SKILL.md                    ← skill 主文件（完整流程 + 判定矩阵 + 约束）
├── SCHEDULED_TASK.md           ← 定时任务指令（Windows 任务计划调用）
├── references/
│   ├── rules.md                ← 校验规则库 + 原因码枚举
│   └── report_template.md      ← 报告模板({{PLACEHOLDER}})
└── scripts/
    ├── fetch_pending_orders.js ← 阶段1: 登录+遍历待确认+详情提取
    ├── query_dedup.js          ← 阶段2: 双sheet引擎API查重
    ├── validate.py             ← 阶段3: 规则校验, 出中间JSON(含uncertain)
    ├── popup.ps1               ← 定时任务: 系统模态弹窗
    └── run_scheduled.ps1       ← 定时任务: 调codebuddy CLI入口
```

## 完整流程

1. **采集**：`fetch_pending_orders.js` — 登录检测 → 开票审核页筛选「待确认」→ 遍历列表取主订单ID → 逐个「详情」提取 抬头类型/发票抬头/企业税号
2. **查重**：`query_dedup.js` — 引擎 API 遍历企微两个 sheet（`沐思和思坞开票` + `新增兴趣岛开票登记2`）查重
3. **规则校验**：`validate.py` — 纯规则校验，产出 `determined`（已确定项）+ `uncertain`（需模型兜底项）
4. **模型兜底 + 渲染报告**：仅对 `uncertain` 项做语义判断，汇总判定，按模板渲染报告

## 判定矩阵

规则：**全部校验通过才「是」，任一不通过 →「否」+ 原因码**，短路判断：

```
1. 查重命中(任一sheet)            → 否  ALREADY_INVOICED
2. 抬头类型 vs 抬头格式 明显不符    → 否  TITLE_TYPE_MISMATCH
3. 个人 → 姓名格式校验             → 失败:否 / 不确定:uncertain
   企业 → 抬头全称校验 + 税号校验   → 失败:否 / 不确定:uncertain
4. 全部通过                        → 是
```

原因码：`ALREADY_INVOICED` / `TITLE_TYPE_MISMATCH` / `TITLE_FORMAT_PERSONAL` / `TITLE_FORMAT_ENTERPRISE` / `TAX_ID_FORMAT`

## 定时任务

由 Windows 任务计划程序「PendingInvoiceChecker」驱动（用户登录时触发 + 每 2 小时重复），通过 `scripts/run_scheduled.ps1` 调用 CLI 无头模式执行 `SCHEDULED_TASK.md`。详见 `SCHEDULED_TASK.md`。

## 安全与隐私

- 脚本运行于 dev-browser QuickJS 沙箱（非 Node.js），文件 I/O 限制在 `~/.dev-browser/tmp/`
- 业务报告（含真实订单号/税号）已通过 `.gitignore` 排除，不入库
