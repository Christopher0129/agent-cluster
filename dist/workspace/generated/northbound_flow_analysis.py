#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
北向资金（沪深股通）流向分析脚本
获取近5个交易日北向资金流向数据
"""
import json
from datetime import datetime, timedelta

try:
    import akshare as ak
    AKSHARE_AVAILABLE = True
except ImportError:
    AKSHARE_AVAILABLE = False

def get_northbound_flow_data():
    """
    获取北向资金近5日流向数据
    优先使用akshare获取实时数据，否则返回数据结构模板
    """
    result = {
        "data_source": "陆股通(沪股通+深股通)",
        "data_date": datetime.now().strftime("%Y-%m-%d"),
        "5日累计净流入亿元": None,
        "每日流向": [],
        "趋势判断": "",
        "主要流向板块": [],
        "method": ""
    }
    
    if AKSHARE_AVAILABLE:
        try:
            # 使用akshare获取北向资金数据
            # 获取历史资金流向
            stock_hsgt_hist_em = ak.stock_hsgt_hist_em(symbol="沪股通")
            if stock_hsgt_hist_em is not None and len(stock_hsgt_hist_em) > 0:
                # 取最近5个交易日
                recent_5 = stock_hsgt_hist_em.tail(5)
                daily_flows = recent_5['净流入'].tolist() if '净流入' in recent_5.columns else []
                result["每日流向"] = [float(x) for x in daily_flows if pd.notna(x)]
                result["5日累计净流入亿元"] = sum(result["每日流向"])
                result["method"] = "akshare_realtime"
                
                # 趋势判断
                if len(daily_flows) >= 3:
                    recent_avg = sum(daily_flows[-3:]) / 3
                    prev_avg = sum(daily_flows[:2]) / 2 if len(daily_flows) >= 5 else sum(daily_flows[:2]) / 2
                    if recent_avg > prev_avg * 1.2:
                        result["趋势判断"] = "加速流入"
                    elif recent_avg > 0:
                        result["趋势判断"] = "持续流入但增速放缓"
                    elif recent_avg > prev_avg:
                        result["趋势判断"] = "流出放缓"
                    else:
                        result["趋势判断"] = "加速流出"
        except Exception as e:
            result["method"] = f"akshare_error: {str(e)}"
    else:
        result["method"] = "manual_input_required"
        result["note"] = "akshare未安装，需要手动输入或通过其他方式获取数据"
    
    return result

def get_sector_preference():
    """
    获取北向资金主要流向板块
    注：板块数据需要通过专业数据源获取
    """
    # 常见北向资金偏好板块（基于历史规律）
    typical_sectors = {
        "传统偏好板块": ["白酒", "家电", "医药生物", "银行", "保险"],
        "近期热点": ["新能源", "半导体", "消费电子"],
        "防御性": ["公用事业", "高速公路", "港口"]
    }
    return typical_sectors

if __name__ == "__main__":
    import pandas as pd
    
    print("=" * 60)
    print("北向资金（沪深股通）流向分析")
    print("=" * 60)
    
    flow_data = get_northbound_flow_data()
    
    print(f"\n数据来源: {flow_data['data_source']}")
    print(f"数据日期: {flow_data['data_date']}")
    print(f"获取方式: {flow_data['method']}")
    
    if flow_data['5日累计净流入亿元'] is not None:
        print(f"\n5日累计净流入: {flow_data['5日累计净流入亿元']:.2f} 亿元")
        print(f"每日流向: {flow_data['每日流向']}")
        print(f"趋势判断: {flow_data['趋势判断']}")
    else:
        print("\n[需要手动补充实时数据]")
    
    sectors = get_sector_preference()
    print(f"\n典型关注板块:")
    for category, items in sectors.items():
        print(f"  {category}: {', '.join(items)}")
    
    # 保存JSON结果
    output_file = "northbound_flow_result.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(flow_data, f, ensure_ascii=False, indent=2)
    
    print(f"\n结果已保存至: {output_file}")
