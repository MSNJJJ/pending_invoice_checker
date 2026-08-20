<!-- references/report_template.md -->
<!-- 用途: 模型渲染最终报告 .md 的模板，占位符 {{UPPER_CASE}} 由模型填充 -->

# 待确认发票识别报告

生成时间：{{RUN_TIME}}
待确认订单总数：{{TOTAL}} | 确认开票：{{CONFIRMED}} | 不确认：{{REJECTED}}

| 序号 | 主订单ID | 是否确认开票 | 备注 |
|---|---------|-------------|------|
{{TABLE_ROWS}}

## 待人工复核（如有）

{{MANUAL_REVIEW}}

<!--
  TABLE_ROWS 渲染规则:
    - 「是否确认开票」= 是        → 备注栏留空
    - 「是否确认开票」= 否        → 备注栏写原因，红色加粗:
        <span style="color:#d32f2f;font-weight:bold;">原因</span>
    - 「是否确认开票」= 待复核     → 备注栏留空，订单列入下方「待人工复核」节

  MANUAL_REVIEW 渲染规则:
    - 仅列出 uncertain 项(规则判不了、需人工判断的订单):
        - 订单号：<字段> 无法判定，原因：<说明>，请人工确认是否开票
    - 无 uncertain 项 → 写「无」
    - 本节与「否」的备注(已确定拒绝原因)语义不同、不重复，故保留
-->
