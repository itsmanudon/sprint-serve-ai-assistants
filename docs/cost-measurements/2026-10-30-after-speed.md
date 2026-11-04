# Assistant cost measurement - after-speed

- Date: 2026-10-29
- Model: muse-spark-1.3
- Base URL: http://localhost:5001/api/v1
- Tenant slug: sprint-serve
- Prices (USD per 1M tokens): input 1.25, output 4.25, cached 0.15
- USD/INR: 88
- Spend cap: $0.5000

## Per turn

| Scenario | Turn | Calls | Input | Output | Cached | Latency ms | USD | INR |
|---|---|---|---|---|---|---|---|---|
| veg-2-700 | 1 | 4 | 11732 | 2148 | 6370 | 18731 | $0.0168 | Rs 1.48 |
| nonveg-4-1600 | 1 | 3 | 7947 | 2389 | 6227 | 19254 | $0.0132 | Rs 1.16 |
| surprise-me | 1 | 1 | 1692 | 1200 | 1649 | 8598 | $0.0054 | Rs 0.48 |
| cafe-light | 1 | 2 | 4784 | 1834 | 1649 | 11070 | $0.0120 | Rs 1.05 |
| edit-chain | 1 | 3 | 7777 | 2288 | 4947 | 14085 | $0.0140 | Rs 1.23 |
| edit-chain | 2 | 2 | 5136 | 1628 | 482 | 8799 | $0.0128 | Rs 1.13 |
| edit-chain | 3 | 4 | 12083 | 3502 | 8260 | 17846 | $0.0209 | Rs 1.84 |
| hinglish-veg-600 | 1 | 3 | 7803 | 1924 | 6227 | 12340 | $0.0111 | Rs 0.98 |

## Summary

- Turns: 8 across 6 conversations
- Per turn: p50 $0.0128 (Rs 1.13), p90 $0.0209 (Rs 1.84)
- Per conversation: p50 $0.0120 (Rs 1.05), p90 $0.0477 (Rs 4.20)
- Mean model calls per turn: 2.75
- Latency: p50 12340 ms, p90 19254 ms

## Total spend

$0.1062 (Rs 9.34) of cap $0.5000
