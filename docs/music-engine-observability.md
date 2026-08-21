# Music engine observability

## Metrics endpoint

`GET /api/public/metrics` returns Prometheus text exposition format.
It requires the `METRICS_TOKEN` secret:

```
Authorization: Bearer <METRICS_TOKEN>
```

(or `?token=<METRICS_TOKEN>` for scrapers that cannot set headers).

Exported series:

| Metric | Type | Labels |
| --- | --- | --- |
| `music_engine_requests_total` | counter | `target`, `outcome` (success, upstream_error, network_error, short_circuit) |
| `music_engine_retries_total` | counter | `target` |
| `music_engine_failovers_total` | counter | `from`, `to` |
| `music_engine_breaker_transitions_total` | counter | `target`, `to` (open, half_open, closed) |
| `music_engine_calls_total` | counter | `result` (success, failure, short_circuit) |
| `music_engine_breaker_open` | gauge | `target` (1 = open) |
| `music_engine_breaker_failures` | gauge | `target` |
| `music_engine_backoff_delay_seconds` | histogram | `target` |

## Prometheus scrape config

```yaml
scrape_configs:
  - job_name: hybrid-music-engine
    scheme: https
    metrics_path: /api/public/metrics
    scrape_interval: 30s
    authorization:
      type: Bearer
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ["hybrid-ai-records.com"]
```

Counters are per-worker-instance and reset on redeploy; always graph them
through `rate()` / `increase()`, never as raw totals.

## Grafana dashboard

Import `observability/grafana/music-engine-dashboard.json`
(Grafana → Dashboards → New → Import → Upload JSON). Pick your Prometheus
data source when prompted; the `target` variable then populates itself from
`music_engine_requests_total`.

Panels:

- **Success rate (5m)** — `music_engine_calls_total{result="success"}` over all calls; red under 90%, green at 98%+.
- **Circuit breaker state** — per-target open/closed indicator.
- **Retries (5m rate)** and **Failovers (1h)** — pressure and secondary-engine usage.
- **Call outcomes per second** — stacked success / failure / short_circuit.
- **HTTP attempts by target and outcome** — where upstream and network errors land.
- **Retry backoff delay quantiles** + **heatmap** — p50/p90/p99 and the full distribution.
- **Breaker state and consecutive failures** / **Breaker transitions** — how often the breaker opens and recovers.

### Suggested alerts

```promql
# Sustained failure rate
sum(rate(music_engine_calls_total{result!="success"}[10m]))
  / clamp_min(sum(rate(music_engine_calls_total[10m])), 0.0000001) > 0.25

# Breaker stuck open
max(music_engine_breaker_open) == 1

# Failing over to the secondary engine
sum(increase(music_engine_failovers_total[15m])) > 0
```
