# Output Groups — Mapping Tools to Verifiers

Tools produce different output shapes. Verifiers are scoped by **output group** — the kind of data a tool returns.

---

## Output Group Inference

Infer from tool description, tags, schema, or response shape:

| Output Group | Keywords / Signals | Example Tools |
|--------------|-------------------|---------------|
| holdings | holdings, positions, allocation | get_holdings, portfolio_summary |
| dividends | dividends, income, yield | get_dividends |
| performance | performance, P&L, returns | portfolio_summary, get_performance |
| transactions | transactions, orders, trades | get_transactions, log_transaction |
| quotes | quotes, prices, market data | market_data |
| * (all) | — | source_attribution applies to all |

---

## Verifier → Output Group Mapping

| Verifier | Output Groups | When to Create |
|----------|---------------|----------------|
| source_attribution | * (all) | Always — one per project |
| concentration_risk | holdings | When tools return positions/allocation |
| stale_data | holdings, performance, quotes | When tools return time-sensitive data |
| (custom) | dividends, transactions | Per-domain |

---

## Gap Detection

1. Load tool registry → infer output group per tool
2. Load existing verifiers (from barrel)
3. Map: which verifiers cover which output groups?
4. Report: tools/output groups with no verifier coverage
5. Suggest verifiers to create
