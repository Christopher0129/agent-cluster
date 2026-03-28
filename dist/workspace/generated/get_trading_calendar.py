#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股交易日历生成器
基于2025年A股已知的节假日安排计算
"""
import json
from datetime import datetime, timedelta

# 2025年A股节假日安排（根据交易所公告）
HOLIDAYS_2025 = [
    # 元旦
    "2025-01-01",
    # 春节
    "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
    # 清明节
    "2025-04-04", "2025-04-05", "2025-04-06",
    # 劳动节
    "2025-05-01", "2025-05-02", "2025-05-03", "2025-05-04", "2025-05-05",
    # 端午节
    "2025-05-31", "2025-06-01", "2025-06-02",
    # 中秋节、国庆节
    "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04", "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08"
]

def get_next_week_trading_days():
    """获取下周的A股交易日历"""
    # 使用系统当前日期或默认日期
    today = datetime.now()
    
    # 找到下周一
    days_until_monday = (7 - today.weekday()) % 7
    if days_until_monday == 0:
        days_until_monday = 7  # 如果今天是周一，跳到下周
    next_monday = today + timedelta(days=days_until_monday)
    
    # 生成周一至周五的日期
    week_dates = []
    for i in range(5):
        date = next_monday + timedelta(days=i)
        date_str = date.strftime("%Y-%m-%d")
        # 检查是否是节假日或周末（周六=5, 周日=6）
        if date.weekday() < 5 and date_str not in HOLIDAYS_2025:
            week_dates.append(date_str)
    
    # 计算是第几周
    week_number = next_monday.isocalendar()[1]
    year = next_monday.year
    
    result = {
        "dates": week_dates,
        "week_of": f"{year}年第{week_number}周",
        "trading_days_count": len(week_dates),
        "current_date": today.strftime("%Y-%m-%d"),
        "note": "基于2025年A股节假日安排计算"
    }
    
    return result

if __name__ == "__main__":
    result = get_next_week_trading_days()
    print(json.dumps(result, ensure_ascii=False, indent=2))
