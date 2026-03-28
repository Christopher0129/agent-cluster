#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
创业板(300XXX)近5日15%-20%涨幅股票检索脚本
使用akshare数据源（A股免费开源数据接口）
排除已涨停(20%)标的，避免与sub_1结果重复

输出格式: stock_code, stock_name, surge_date, surge_percent
"""
import akshare as ak
import pandas as pd
from datetime import datetime, timedelta
import json
import sys

def get_recent_trading_dates(n_days=5, end_date=None):
    """获取最近N个交易日日期列表"""
    if end_date is None:
        end_date = datetime.now()
    
    # A股交易日历
    try:
        trade_cal = ak.tool_trade_date_hist_sina()
        trade_cal['trade_date'] = pd.to_datetime(trade_cal['trade_date'])
        trade_cal = trade_cal[trade_cal['trade_date'] <= end_date]
        recent_dates = trade_cal.tail(n_days)['trade_date'].tolist()
        return [d.strftime('%Y%m%d') for d in recent_dates]
    except:
        # 备用方案：简单回推（可能包含非交易日）
        dates = []
        current = end_date
        while len(dates) < n_days:
            if current.weekday() < 5:  # 周一到周五
                dates.append(current.strftime('%Y%m%d'))
            current -= timedelta(days=1)
        return dates

def get_chinext_stocks_surge_15_20(trade_dates):
    """
    检索创业板股票在指定日期范围内涨幅15%-20%的标的
    创业板代码段: 300000-301999
    """
    results = []
    
    for date_str in trade_dates:
        try:
            # 获取当日全部A股行情
            df = ak.stock_zh_a_spot_em()
            
            # 筛选创业板代码段 (300XXX, 301XXX)
            chinext_mask = df['代码'].str.match(r'^30[0-1]\d{3}$', na=False)
            chinext_df = df[chinext_mask].copy()
            
            # 转换涨跌幅为数值
            chinext_df['涨跌幅'] = pd.to_numeric(chinext_df['涨跌幅'], errors='coerce')
            
            # 筛选15% <= 涨幅 < 20%（未涨停）
            surge_mask = (chinext_df['涨跌幅'] >= 15.0) & (chinext_df['涨跌幅'] < 19.9)
            surge_stocks = chinext_df[surge_mask]
            
            for _, row in surge_stocks.iterrows():
                results.append({
                    'stock_code': row['代码'],
                    'stock_name': row['名称'],
                    'surge_date': date_str,
                    'surge_percent': round(float(row['涨跌幅']), 2)
                })
                
        except Exception as e:
            print(f"获取{date_str}数据失败: {e}", file=sys.stderr)
            continue
    
    return results

def main():
    print("=" * 60)
    print("创业板(300XXX)近5日15%-20%涨幅股票检索")
    print("=" * 60)
    
    # 获取近5个交易日
    trade_dates = get_recent_trading_dates(5)
    print(f"检索日期范围: {trade_dates[0]} 至 {trade_dates[-1]}")
    
    # 检索大涨股票
    surge_stocks = get_chinext_stocks_surge_15_20(trade_dates)
    
    # 去重（同一股票多日大涨）
    seen = set()
    unique_results = []
    for item in surge_stocks:
        key = (item['stock_code'], item['surge_date'])
        if key not in seen:
            seen.add(key)
            unique_results.append(item)
    
    # 按日期和涨幅排序
    unique_results.sort(key=lambda x: (x['surge_date'], -x['surge_percent']))
    
    print(f"\n共检索到 {len(unique_results)} 条记录（已去重）")
    print("\n检索结果:")
    print("-" * 60)
    print(f"{'代码':<10} {'名称':<12} {'日期':<12} {'涨幅':<8}")
    print("-" * 60)
    
    for item in unique_results:
        print(f"{item['stock_code']:<10} {item['stock_name']:<12} {item['surge_date']:<12} {item['surge_percent']:<8.2f}%")
    
    # 保存JSON结果
    output = {
        'query_date_range': trade_dates,
        'query_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'total_records': len(unique_results),
        'criteria': '创业板(300XXX)单日涨幅15%-20%（未涨停）',
        'data': unique_results
    }
    
    output_file = 'chinext_surge_15_20_results.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print(f"\n结果已保存至: {output_file}")
    
    # CSV格式输出（便于复制）
    print("\nCSV格式输出:")
    print("stock_code,stock_name,surge_date,surge_percent")
    for item in unique_results:
        print(f"{item['stock_code']},{item['stock_name']},{item['surge_date']},{item['surge_percent']}")
    
    return unique_results

if __name__ == '__main__':
    main()
