#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""机械校验诡镇奇谭（Arkham Horror LCG）DIY 卡牌的数值是否在官方预算内。

用法:
  python3 balance_check.py '{"name":"测试","type":"调查员","attribute":[3,3,4,2],"health":9,"horror":5}'
  python3 balance_check.py < card.json        # 从文件/stdin 读 JSON
  echo '{"type":"敌人卡","attack":8,"enemy_health":8}' | python3 balance_check.py

输入: 一张卡的 JSON，字段名与卡牌数据库一致——
  type: 调查员/支援卡/事件卡/技能卡/敌人卡/地点卡
  attribute: [意志,学识,战斗,敏捷]（调查员）
  health / horror: 健康/理智（调查员；支援卡可吸收伤害，-1=无）
  attack / evade / enemy_health / enemy_damage / enemy_damage_horror: 敌人数值
  traits: 列表（含"精英"则视为精英）
  shroud / clues / victory: 地点数值（clues 可为 "1<调查员>" 这类缩放写法）
  location_type: "已揭示"/"未揭示"
  cost / level: 费用/等级

输出: 命中的越界项：error（官方从未出现的组合，必须改）+ warning（官方存在但必配补偿，DIY 需给理由）。
退出码: 0 = 无 error；1 = 有 error。

全部 error 规则已对官方全量卡牌语料验证 0 误报；warning 规则在官方语料上会有少量命中（那些正是"带补偿的特例"）。
"""

import json
import re
import sys


def _int(v):
    """转整数；缩放串 '1<调查员>' 返回 1；None/'-'/'X' 返回 None。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    s = str(v).strip()
    if s in ('-', 'X', 'x', ''):
        return None
    m = re.match(r'^(\d+)', s)
    return int(m.group(1)) if m else None


def _is_per_player(v):
    return v is not None and isinstance(v, str) and '<调查员>' in v


def _num(v):
    """数值转 int，无法解析返回 None（非 error）。"""
    return _int(v)


def check(card):
    hits = []

    def add(sev, rule, note, where=''):
        hits.append((sev, rule, note, where))

    ctype = card.get('type', '')

    # ---------- 通用 ----------
    cost = card.get('cost')
    level = card.get('level')
    if _num(cost) is not None and _num(cost) > 10:
        add('error', '费用超官方上限', '官方最高 10 费（契约/降费事件），DIY cost 最高到 10', f"cost={cost}")
    elif _num(cost) is not None and _num(cost) > 7:
        add('warning', '费用≥8', '官方 8-10 费只出现在契约/降费型事件（每X降低费用），DIY 需配降费机制背书', f"cost={cost}")
    if _num(level) is not None and _num(level) > 5:
        add('error', '等级超官方上限', '官方等级 0-5，-1=未升级', f"level={level}")
    if _num(level) is not None and _num(level) < -1:
        add('error', '等级非法', '等级范围 -1~5', f"level={level}")

    # ---------- 调查员 ----------
    if ctype == '调查员':
        attr = card.get('attribute') or []
        attr = [_num(a) for a in attr]
        attr = [a for a in attr if a is not None]
        hp = _num(card.get('health'))
        hr = _num(card.get('horror'))
        skill_sum = sum(attr)
        vit = (hp or 0) + (hr or 0)
        if attr:
            if skill_sum > 14:
                add('error', '技能总和超上限', '官方技能总和上限 14（汉克·萨姆森·坚毅）', f"技能总和={skill_sum}")
            if skill_sum + vit > 27:
                add('error', '技能+生命理智合计超上限', '官方合计上限 27（12+15 或 13+14），28 即超模', f"技能{skill_sum}+生命理智{vit}={skill_sum+vit}")
            if skill_sum > 12 and vit > 14:
                add('error', '双高互斥越界', '官方从无「技能>12 且 生命理智>14」', f"技能{skill_sum}/生命理智{vit}")
            if any(a > 5 for a in attr):
                add('error', '单属性超上限', '官方单属性最高 5', f"max={max(attr)}")
            if any(a < 0 for a in attr):
                add('error', '属性为负', '属性最低 0', f"{attr}")
            if min(attr) == 1 and skill_sum >= 13:
                add('error', '高技能无弱项约束', '官方技能≥13 的调查员全部无 1 弱项', f"技能{skill_sum} min=1")
        if vit > 15:
            add('error', '生命理智超上限', '官方健康+理智上限 15', f"生命理智={vit}")
        if vit > 14 and attr and max(attr) >= 5:
            add('error', '高生命不配5属性', '官方 15 生命的调查员全部不带 5 属性', f"生命理智={vit} max={max(attr)}")
        if skill_sum != 12:
            add('warning', '技能总和偏离标准12', '官方标准=12；偏离必须用签名机制补偿', f"技能总和={skill_sum}")
        if vit != 14:
            add('warning', '生命理智偏离标准14', '官方标准=14；偏离必须用签名机制补偿', f"生命理智={vit}")
        if attr and min(attr) == 1:
            add('warning', '有1弱项', '官方单属性1只在技能≤12出现，意志1必须配规避/取消/成长引擎', f"min=1 {attr}")

    # ---------- 敌人 ----------
    if ctype == '敌人卡':
        elite = '精英' in (card.get('traits') or [])
        atk = _num(card.get('attack'))
        hp = _num(card.get('enemy_health'))
        dmg = _num(card.get('enemy_damage'))
        hr = _num(card.get('enemy_damage_horror'))
        ev = _num(card.get('evade'))
        hp_scaled = isinstance(card.get('enemy_health'), str) and '<调查员>' in card.get('enemy_health')
        label = '精英' if elite else '非精英'
        if hp_scaled and not elite:
            add('warning', '非精英使用<调查员>生命缩放', '官方仅精英用缩放（唯一例外是具名boss暗红骑士·誓约勇士，0.2%），DIY 非精英禁用', f"{label} {card.get('enemy_health')}")
        if not elite and atk is not None and hp is not None and atk >= 7 and hp >= 7:
            add('error', '超模红线：非精英攻7+命7+', '官方非精英从无同时攻击≥7且生命≥7', f"攻{atk} 命{hp}")
        if not elite and atk is not None and atk >= 7:
            add('warning', '非精英攻击≥7', '官方攻击7+只留给不可击败/沉睡古神（唯一例外具名鞭笞异兽1血）', f"攻{atk}")
        if not elite and dmg == 3 and hr == 3:
            add('warning', '非精英伤害3/3', '官方3/3仅精英/古神，非精英仅2张具名带弱点', f"{dmg}/{hr}")
        if not elite and (dmg or 0) >= 3:
            add('warning', '非精英单值伤害≥3', '官方3伤必配低生命(≤2)/不猎手/具名补偿', f"伤{dmg}")
        if elite and atk is not None and atk >= 7:
            add('warning', '精英攻击≥7', '官方攻击7-8的精英全部「生命=-」不可击败；可被击败精英最高6', f"攻{atk}")
        if ev is not None and hp is not None and ev >= 5 and hp >= 5:
            add('warning', '高躲避5+高生命5', '官方高躲避(5)=滑溜型，生命全部≤4', f"躲{ev} 命{hp}")

    # ---------- 地点 ----------
    if ctype == '地点卡':
        revealed = card.get('location_type') != '未揭示'
        sh = _num(card.get('shroud'))
        cl = card.get('clues')
        cl_n = _num(cl)
        vc = _num(card.get('victory'))
        if not revealed and (sh is not None or cl_n is not None or vc is not None):
            add('error', '未揭示面带数值', '官方未揭示面 100% 无隐匿/线索/胜利，只靠箭头与效果', f"shroud={card.get('shroud')} clues={card.get('clues')} victory={card.get('victory')}")
        if sh is not None:
            if sh > 9:
                add('error', '隐匿超上限', '官方最高隐匿 9', f"shroud={sh}")
            if sh == 0:
                add('warning', '隐匿=0', '全语料仅女巫作祟之林1张剧情豁免卡，DIY 隐匿下限应为1', f"shroud={sh}")
            if sh >= 7 and cl_n is not None and cl_n >= 1:
                add('warning', '隐匿7+还配线索', '官方9张隐匿7+里仅道具间(7/1)例外，其余全部0<调查员>或无', f"shroud={sh} clues={card.get('clues')}")
            if sh >= 5 and cl_n is not None and cl_n >= 2:
                add('warning', '高隐匿配高线索', '官方高隐匿配低线索，隐匿≥5线索2+需动态降难补偿', f"shroud={sh} clues={card.get('clues')}")
        if cl_n is not None:
            if _is_per_player(cl) and cl_n == 0 and vc is not None and vc > 0:
                add('warning', '起点刷点(0线索)配胜利', '官方169张0<调查员>仅3张带胜利，常规不把胜利挂在可反复刷的点', f"clues={cl} victory={vc}")
        if vc is not None and vc > 2:
            add('error', '胜利点超上限', '官方地点胜利点只有1和2', f"victory={vc}")

    # ---------- 支援卡/事件卡 ----------
    if ctype in ('支援卡', '事件卡'):
        body = card.get('body', '') or ''
        if ctype == '支援卡' and _num(cost) == 1 and '武器' in (card.get('traits') or []):
            if re.search(r'你得到\+2👊', body):
                add('warning', 'cost1武器常驻+2👊', '官方cost1武器最高常驻+1👊，+2👊必须弃置/交战敌数/升级等条件', f"cost={cost}")
        if ctype == '事件卡' and _num(cost) == 0:
            body_n = body.replace('\n', '')
            # 0费无条件发现线索：官方0费线索必带代价（恐怖揭露=被击败+精神创伤、掀起麻烦=加🌑、飞蛾扑火=抽遭遇），语料验证 0 误报
            gate = r'如果|当你|时：|时。|后|作为|选择|快速|前提|最终|专用|必须|被击败|承受|精神创伤|恐惧|🌑|遭遇|其中|每有|每控制|交换|忽略|取消|移除|放逐|等级|最后|需要|少于|任意|横置|交战|混洗'
            if re.match(r'^发现.{0,8}\d+个线索', body_n) and not re.search(gate, body_n):
                add('error', '0费无条件发现线索', '官方0费线索必带代价（恐怖揭露=自杀+精神创伤、掀起麻烦=加🌑、飞蛾扑火=抽遭遇）；0费无条件线索=越线', f"cost=0 {body_n[:30]}")
            # 0费未升级无条件获得4+资源：官方0费资源基线=3（应急物品L0），4资源需L3
            m = re.match(r'^获得(\d+)资源', body_n)
            if m and _num(level) in (-1, 0) and int(m.group(1)) >= 4 and not re.search(gate, body_n):
                add('warning', '0费未升级无条件4+资源', '官方0费资源基线=3（应急物品），4资源只出现在L3（应急物品L3）', f"cost=0 level={level}")

    return hits


def _fmt(card):
    """卡片概述，用于定位。"""
    name = card.get('name') or '未命名'
    ctype = card.get('type') or '?'
    return f"{name}（{ctype}）"


def main():
    raw = ''
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        try:
            if arg.strip().startswith('{'):
                raw = arg
            else:
                raw = open(arg, encoding='utf-8').read()
        except OSError:
            raw = arg
    else:
        raw = sys.stdin.read()

    try:
        card = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f'❌ JSON 解析失败: {e}\n用法: python3 balance_check.py \'{{"type":"调查员",...}}\' 或管道输入 JSON')
        return 2
    if not isinstance(card, dict):
        print('❌ 输入应为单个卡牌 JSON 对象。')
        return 2

    hits = check(card)
    if not hits:
        print(f'✅ {_fmt(card)} 数值在官方预算内，未命中任何越界项。')
        return 0

    errors = [h for h in hits if h[0] == 'error']
    print(f'⚠️  {_fmt(card)} 命中 {len(hits)} 处数值越界（error {len(errors)}，warning {len(hits) - len(errors)}）：\n')
    for sev, rule, note, where in hits:
        mark = '❌' if sev == 'error' else '⚠️'
        extra = f'  [{where}]' if where else ''
        print(f'{mark} [{sev}] {rule}{extra}')
        print(f'     说明: {note}')
        print()
    print('→ 完整预算公式见 references/ 各分域文件；超模红线汇总见 references/balance-redlines.md。')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
