/**
 * In-memory Prometheus metrics for the music engine (server-only).
 *
 * Counters/gauges live per worker instance and reset on redeploy — that is the
 * normal shape for Prometheus scraping of a stateless runtime.
 */

type Labels = Record<string, string>;

const counters = new Map<string, { value: number; labels: Labels }>();
const gauges = new Map<string, { value: number; labels: Labels }>();

/** Fixed-bucket histogram (seconds) for retry backoff delays. */
const BACKOFF_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
const histograms = new Map<
  string,
  { labels: Labels; counts: number[]; sum: number; count: number }
>();

function key(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`);
  return `${name}{${parts.join(",")}}`;
}

export function incCounter(name: string, labels: Labels = {}, by = 1): void {
  const k = key(name, labels);
  const existing = counters.get(k);
  if (existing) existing.value += by;
  else counters.set(k, { value: by, labels });
}

export function setGauge(name: string, value: number, labels: Labels = {}): void {
  gauges.set(key(name, labels), { value, labels });
}

export function observeBackoff(name: string, seconds: number, labels: Labels = {}): void {
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    h = { labels, counts: new Array(BACKOFF_BUCKETS.length).fill(0), sum: 0, count: 0 };
    histograms.set(k, h);
  }
  h.sum += seconds;
  h.count += 1;
  BACKOFF_BUCKETS.forEach((bucket, index) => {
    if (seconds <= bucket) h!.counts[index] = (h!.counts[index] ?? 0) + 1;
  });
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const all = { ...labels, ...(extra ?? {}) };
  const parts = Object.entries(all).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

const HELP: Record<string, [string, string]> = {
  music_engine_requests_total: ["counter", "Music engine HTTP attempts by target and outcome"],
  music_engine_retries_total: ["counter", "Retry attempts made against the music engine"],
  music_engine_failovers_total: ["counter", "Times a request failed over to a secondary engine"],
  music_engine_breaker_transitions_total: ["counter", "Circuit breaker state transitions"],
  music_engine_calls_total: ["counter", "Completed music engine calls by result"],
  music_engine_breaker_open: ["gauge", "Circuit breaker open state per target (1=open)"],
  music_engine_breaker_failures: ["gauge", "Consecutive failures recorded per target"],
  music_engine_backoff_delay_seconds: ["histogram", "Retry backoff delay in seconds"],
};

/** Render the current registry in Prometheus text exposition format. */
export function renderPrometheusMetrics(): string {
  const lines: string[] = [];
  const emitted = new Set<string>();

  const header = (name: string) => {
    if (emitted.has(name)) return;
    emitted.add(name);
    const meta = HELP[name];
    if (meta) {
      lines.push(`# HELP ${name} ${meta[1]}`);
      lines.push(`# TYPE ${name} ${meta[0]}`);
    }
  };

  for (const [k, entry] of counters) {
    const name = k.slice(0, k.indexOf("{"));
    header(name);
    lines.push(`${name}${renderLabels(entry.labels)} ${entry.value}`);
  }
  for (const [k, entry] of gauges) {
    const name = k.slice(0, k.indexOf("{"));
    header(name);
    lines.push(`${name}${renderLabels(entry.labels)} ${entry.value}`);
  }
  for (const [k, h] of histograms) {
    const name = k.slice(0, k.indexOf("{"));
    header(name);
    BACKOFF_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `${name}_bucket${renderLabels(h.labels, { le: String(bucket) })} ${h.counts[index] ?? 0}`,
      );
    });
    lines.push(`${name}_bucket${renderLabels(h.labels, { le: "+Inf" })} ${h.count}`);
    lines.push(`${name}_sum${renderLabels(h.labels)} ${h.sum}`);
    lines.push(`${name}_count${renderLabels(h.labels)} ${h.count}`);
  }

  return `${lines.join("\n")}\n`;
}
