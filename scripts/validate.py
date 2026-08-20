#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pending-invoice-checker 阶段3 — 规则校验（纯脚本，确定性）

输入:
  --orders  pending_orders.json  (阶段1产出: 订单号 + 抬头类型/发票抬头/税号)
  --dedup   dedup_result.json    (阶段2产出: 订单号 -> found)
  --output  输出中间 JSON 路径

输出:
  validate_result.json:
  {
    "meta": {"run_time", "total", "determined_yes", "determined_no", "uncertain"},
    "orders": [
      {
        "order_id", "title_type", "invoice_title", "tax_id",
        "decision": "determined" | "uncertain",
        "result": "yes" | "no" | null,
        "reason_code": "...",      # 见 references/rules.md
        "reason_text": "...",
        "uncertain_field": "...",  # 不确定的字段, 供模型判断
        "uncertain_reason": "..."
      }
    ]
  }

规则依据: references/rules.md
脚本只做「确定」判断，规则判不了的交模型（decision=uncertain）。
"""

import sys
import re
import json
import argparse
from datetime import datetime

# ===================== 原因码 -> 备注文案 =====================
REASON_TEXT = {
    "ALREADY_INVOICED": "已开票（命中企微表格）",
    "TITLE_TYPE_MISMATCH": "抬头类型与发票抬头不符",
    "TITLE_FORMAT_PERSONAL": "个人抬头为网名/不符合姓名格式",
    "TITLE_FORMAT_ENTERPRISE": "企业抬头未写全称/含特殊符号或空格",
    "TAX_ID_FORMAT": "企业税号含空格或特殊符号",
}

# 企业完整主体后缀
ENTERPRISE_FULL_SUFFIX = [
    "有限公司", "股份有限公司", "集团有限公司", "学校", "医院",
    "事务所", "中心", "合作社", "大学", "学院", "研究院", "厂",
    "工作室", "经营部", "商行", "农场", "林场", "牧场", "养殖场",
]

# 常见百家姓（用于区分姓名 vs 网名；仅单姓）
BAIJIAXING = set(
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公"
)


def normalize_title_type(title_type):
    """抬头类型归一化: 企业 / 个人 / unknown"""
    if not title_type:
        return "unknown"
    t = str(title_type)
    if "企业" in t:
        return "enterprise"
    if "个人" in t or "自然人" in t:
        return "personal"
    return "unknown"


def check_type_cross(title_type, invoice_title):
    """抬头类型 vs 发票抬头 明显交叉"""
    if not invoice_title:
        return False
    t = str(invoice_title)
    if title_type == "enterprise":
        # 企业类型 + 个人抬头特征(先生/女士/小姐 或 纯2-4字姓名)
        if re.search(r"(先生|女士|小姐)", t):
            return True
    elif title_type == "personal":
        # 个人类型 + 企业主体后缀
        if any(s in t for s in ["有限公司", "集团", "学校", "医院", "事务所", "中心", "合作社"]):
            return True
    return False


def validate_personal(title):
    """个人抬头校验: ok / fail / uncertain"""
    t = str(title).strip()
    # 确定合法：姓+先生/女士/小姐
    if re.match(r"^[\u4e00-\u9fa5](先生|女士|小姐)$", t):
        return "ok", None
    # 确定非法
    if re.search(r"[0-9a-zA-Z]", t):
        return "fail", "含数字或英文"
    if re.search(r"[^\u4e00-\u9fa5先生女士小姐]", t):
        return "fail", "含特殊符号"
    if "个人" in t or "自然人" in t:
        return "fail", "为占位词而非真实姓名"
    if len(t) < 2 or len(t) > 6:
        return "fail", "长度异常"
    # 纯汉字 2-4 字：用百家姓首字区分姓名 vs 网名
    if re.match(r"^[\u4e00-\u9fa5]{2,4}$", t):
        if t[0] in BAIJIAXING:
            return "ok", None
        return "uncertain", "首字非常见姓氏，可能为网名或罕见姓氏"
    # 其余不确定
    return "uncertain", "无法判定是姓名还是网名"


def validate_enterprise_title(title):
    """企业抬头校验: ok / fail / uncertain"""
    t = str(title).strip()
    if "个人" in t or "自然人" in t:
        return "fail", "含个人/自然人占位词"
    if re.search(r"\s", t):
        return "fail", "含空格"
    # 特殊符号（· 除外，集团名可能含）
    if re.search(r"[^\u4e00-\u9fa5A-Za-z0-9（）()·]", t):
        return "fail", "含特殊符号"
    has_full = any(s in t for s in ENTERPRISE_FULL_SUFFIX)
    # 以"公司"结尾但无完整主体字样 → 简称
    if t.endswith("公司") and not any(s in t for s in ["有限", "股份", "集团"]):
        return "fail", "为简称，未写全称"
    if has_full:
        return "ok", None
    # 不确定：疑似简称或生僻主体类型
    return "uncertain", "疑似简称或规则库未覆盖的主体类型"


def validate_tax_id(tax_id):
    """企业税号校验: ok / fail"""
    t = str(tax_id).strip()
    if not t:
        return "fail", "税号缺失"
    if re.search(r"\s", t):
        return "fail", "含空格"
    if not re.match(r"^[0-9A-Z]{18}$", t):
        return "fail", "含特殊符号或长度不为18位"
    return "ok", None


def validate_one(order, dedup_found):
    """校验单个订单，返回订单结果 dict"""
    order_id = str(order.get("order_id", ""))
    title_type_raw = order.get("title_type", "")
    invoice_title = order.get("invoice_title", "")
    tax_id = order.get("tax_id", "")

    base = {
        "order_id": order_id,
        "title_type": title_type_raw,
        "invoice_title": invoice_title,
        "tax_id": tax_id,
    }

    # 1) 查重命中
    if dedup_found:
        base.update({
            "decision": "determined", "result": "no",
            "reason_code": "ALREADY_INVOICED",
            "reason_text": REASON_TEXT["ALREADY_INVOICED"],
            "uncertain_field": None, "uncertain_reason": None,
        })
        return base

    # 2) 抬头类型归一化
    tt = normalize_title_type(title_type_raw)
    if tt == "unknown":
        base.update({
            "decision": "uncertain", "result": None,
            "reason_code": None, "reason_text": None,
            "uncertain_field": "title_type",
            "uncertain_reason": "抬头类型缺失或无法识别(个人/企业)",
        })
        return base

    # 3) 抬头类型 vs 抬头格式 明显交叉
    if check_type_cross(tt, invoice_title):
        base.update({
            "decision": "determined", "result": "no",
            "reason_code": "TITLE_TYPE_MISMATCH",
            "reason_text": REASON_TEXT["TITLE_TYPE_MISMATCH"],
            "uncertain_field": None, "uncertain_reason": None,
        })
        return base

    # 4) 按类型分流校验
    if tt == "personal":
        verdict, detail = validate_personal(invoice_title)
        if verdict == "ok":
            base.update({"decision": "determined", "result": "yes",
                         "reason_code": None, "reason_text": None,
                         "uncertain_field": None, "uncertain_reason": None})
        elif verdict == "fail":
            base.update({"decision": "determined", "result": "no",
                         "reason_code": "TITLE_FORMAT_PERSONAL",
                         "reason_text": REASON_TEXT["TITLE_FORMAT_PERSONAL"] + (f"（{detail}）" if detail else ""),
                         "uncertain_field": None, "uncertain_reason": None})
        else:
            base.update({"decision": "uncertain", "result": None,
                         "reason_code": None, "reason_text": None,
                         "uncertain_field": "invoice_title",
                         "uncertain_reason": detail or "个人抬头无法判定"})
        return base

    # 企业
    verdict_t, detail_t = validate_enterprise_title(invoice_title)
    verdict_x, detail_x = validate_tax_id(tax_id)

    # 税号确定非法优先
    if verdict_x == "fail":
        base.update({"decision": "determined", "result": "no",
                     "reason_code": "TAX_ID_FORMAT",
                     "reason_text": REASON_TEXT["TAX_ID_FORMAT"] + (f"（{detail_x}）" if detail_x else ""),
                     "uncertain_field": None, "uncertain_reason": None})
        return base

    if verdict_t == "fail":
        base.update({"decision": "determined", "result": "no",
                     "reason_code": "TITLE_FORMAT_ENTERPRISE",
                     "reason_text": REASON_TEXT["TITLE_FORMAT_ENTERPRISE"] + (f"（{detail_t}）" if detail_t else ""),
                     "uncertain_field": None, "uncertain_reason": None})
        return base

    # 抬头 uncertain → 交模型
    if verdict_t == "uncertain":
        base.update({"decision": "uncertain", "result": None,
                     "reason_code": None, "reason_text": None,
                     "uncertain_field": "invoice_title",
                     "uncertain_reason": detail_t or "企业抬头疑似简称"})
        return base

    # 抬头 ok，税号 ok → 通过
    base.update({"decision": "determined", "result": "yes",
                 "reason_code": None, "reason_text": None,
                 "uncertain_field": None, "uncertain_reason": None})
    return base


def main():
    parser = argparse.ArgumentParser(description="待确认发票规则校验")
    parser.add_argument("--orders", required=True, help="pending_orders.json 路径")
    parser.add_argument("--dedup", required=True, help="dedup_result.json 路径")
    parser.add_argument("--output", default="-", help="输出路径，默认 stdout")
    args = parser.parse_args()

    # 读取输入
    with open(args.orders, "r", encoding="utf-8") as f:
        orders_data = json.load(f)
    with open(args.dedup, "r", encoding="utf-8") as f:
        dedup_data = json.load(f)

    # 归一化订单列表
    if isinstance(orders_data, dict) and "orders" in orders_data:
        orders = orders_data["orders"]
    elif isinstance(orders_data, list):
        orders = orders_data
    else:
        orders = []

    # 构建 dedup map
    dedup_map = {}
    dedup_error = False
    if isinstance(dedup_data, dict) and "error" in dedup_data:
        dedup_error = True
    elif isinstance(dedup_data, list):
        for d in dedup_data:
            if isinstance(d, dict) and "order_id" in d:
                dedup_map[str(d["order_id"])] = bool(d.get("found", False))

    # 校验每个订单
    results = []
    determined_yes = 0
    determined_no = 0
    uncertain = 0
    for order in orders:
        oid = str(order.get("order_id", ""))
        if dedup_error:
            # 查重失败，不能判未命中，交人工/模型
            r = {
                "order_id": oid,
                "title_type": order.get("title_type", ""),
                "invoice_title": order.get("invoice_title", ""),
                "tax_id": order.get("tax_id", ""),
                "decision": "uncertain", "result": None,
                "reason_code": None, "reason_text": None,
                "uncertain_field": "dedup",
                "uncertain_reason": "企微查重失败，无法确认是否已开票",
            }
        else:
            r = validate_one(order, dedup_map.get(oid, False))

        if r["decision"] == "determined" and r["result"] == "yes":
            determined_yes += 1
        elif r["decision"] == "determined" and r["result"] == "no":
            determined_no += 1
        else:
            uncertain += 1
        results.append(r)

    output = {
        "meta": {
            "run_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "total": len(results),
            "determined_yes": determined_yes,
            "determined_no": determined_no,
            "uncertain": uncertain,
            "dedup_error": dedup_error,
        },
        "orders": results,
    }

    content = json.dumps(output, ensure_ascii=False, indent=2)
    if args.output == "-":
        print(content)
    else:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(content)
    sys.exit(0)


if __name__ == "__main__":
    main()
