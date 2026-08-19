# 待确认发票定时识别 — 任务指令

> 本文件由 Windows 任务计划程序（用户登录时触发 + 每 2 小时重复）通过 `codebuddy` CLI 无头模式调用。
> 你是「待确认发票定时识别」任务，严格按以下流程执行。

## 0. 时段守卫（最先执行）

判断当前日期与时间：
- 若今天不是周一至周五，或当前时刻不在 9:00–18:00 之间，直接结束本次任务，不做任何事、不弹窗、不生成报告。

## 1. 执行待确认发票识别完整流程

按本 skill 的 `SKILL.md` 完整四阶段流程执行（脚本绝对路径见 SKILL.md）：
1. 采集（scripts/fetch_pending_orders.js）
2. 查重（scripts/query_dedup.js）
3. 规则校验（scripts/validate.py）
4. 模型兜底 + 渲染报告

严格遵循 SKILL.md 的判定矩阵与约束（只读、禁止固定坐标、禁止保存密码/模拟扫码、只允许点「详情」）。

## 2. 登录引导（阻塞等待 + 立即补跑）

⚠️ 未登录不是「失败」，是每天开机后的正常状态，用「引导登录 + 补跑」闭环处理，**不要停止本次任务**。

若阶段1检测到兴趣岛未登录（fetch 返回 login_required），按以下步骤闭环：
1. 写 UTF-8 JSON 临时文件 `C:\Users\EDY\.dev-browser\tmp\popup_msg.json`，内容：
   `{"title":"需登录","message":"兴趣岛平台未登录。\n登录页已在浏览器窗口打开，请从任务栏切换到该浏览器窗口完成登录（手机号+验证码，或点右下角放大镜扫码）。\n登录完成后点「确定」，我将立即补跑识别。","icon":"Warning"}`
2. **同步阻塞**执行弹窗（⚠️ 关键：直接执行命令，**不要用 Start-Process**，让它挂起等待用户点「确定」）：
   `powershell -NoProfile -File "C:\Users\EDY\.codebuddy\skills\pending-invoice-checker\scripts\popup.ps1" -MsgFile "C:\Users\EDY\.dev-browser\tmp\popup_msg.json"`
   该命令会一直阻塞，直到用户在弹窗点「确定」才返回。
3. 返回后，立即重跑阶段1（fetch_pending_orders.js）。
   - 若仍 login_required（用户没登录就点了确定），回到第 1 步再次弹窗引导；最多重试 3 次。
   - 3 次后仍失败，按「运行失败」弹 Error 弹窗（icon=Error，正文说明仍未能登录）并结束本次。
4. 登录成功后，继续阶段2/3/4。

若阶段2检测到企微未登录/引擎未就绪（app_not_ready 或 sheet_not_ready），同样弹「企微未登录」引导窗：
`{"title":"需登录","message":"企微表格未登录。\n登录页已在浏览器窗口打开，请从任务栏切换到该浏览器窗口完成登录。\n登录完成后点「确定」，我将立即补跑查重。","icon":"Warning"}`
同样同步阻塞等待，点确定后重跑阶段2，最多重试 3 次。

## 3. 结果弹窗（分情况）

- 0 条待确认：静默结束，不弹窗、不生成报告文件。
- >0 条待确认：生成报告到 `reports/<时间戳>_待确认发票识别报告.md`，弹「提示」弹窗（icon=Information），标题固定为「待确认发票」，正文为「N 条待确认，详见报告」+ 换行 + 报告完整路径（N 替换为实际条数）。
- 运行失败/其他异常（非登录类，如页面结构改版）：弹「失败告警」弹窗（icon=Error），说明失败原因。

## 弹窗实现方式（系统模态消息框）

所有弹窗统一走 `scripts/popup.ps1`：
- 引导登录（未登录）：同步阻塞执行（不要 Start-Process），icon=Warning（黄叹号）。
- 结果提示（>0条）：可用同步或异步，icon=Information（蓝i）。
- 失败告警（异常）：icon=Error（红叉）。

脚本路径：`C:\Users\EDY\.codebuddy\skills\pending-invoice-checker\scripts\popup.ps1`

## 报告产出规则

- 只有发现 >0 条待确认时才生成报告文件；0 条不生成。
- 历史报告保留，不删除、不覆盖。

## 约束

- 本任务只读，禁止修改/删除/创建任何订单或发票数据，禁止点击「换营」「追赠」「复制链接」等修改/分享按钮。
- 临时文件一律写 `C:\Users\EDY\.dev-browser\tmp\`，用完即弃；工作区只保留 scripts/、references/、reports/。
