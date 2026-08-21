/**
 * Watches an order's estimated delivery window across lookups so we can warn
 * the artist when the dates move or when the window has already passed.
 * Snapshots live in localStorage, keyed by reference code.
 */
const STORAGE_KEY = "hybrid:delivery-window-watch";

export type DeliveryWindow = {
  earliest: string | null;
  latest: string | null;
};

export type DeliveryAlert = {
  kind: "shifted" | "missed";
  title: string;
  message: string;
};

type Snapshots = Record<string, DeliveryWindow>;

function readAll(): Snapshots {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Snapshots) : {};
  } catch {
    return {};
  }
}

function writeAll(next: Snapshots) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — alerts simply won't persist between visits */
  }
}

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "not scheduled";

const dayKey = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

/**
 * Compares the freshly loaded window against the last one seen for this
 * reference, records the new one, and returns any alerts to surface.
 */
export function checkDeliveryWindow(
  reference: string,
  current: DeliveryWindow,
  status: string,
  now: Date = new Date(),
): DeliveryAlert[] {
  const alerts: DeliveryAlert[] = [];
  const all = readAll();
  const previous = all[reference];

  if (
    previous &&
    (dayKey(previous.earliest) !== dayKey(current.earliest) ||
      dayKey(previous.latest) !== dayKey(current.latest))
  ) {
    alerts.push({
      kind: "shifted",
      title: "Delivery window changed",
      message: `Your estimate moved from ${fmt(previous.earliest)} – ${fmt(previous.latest)} to ${fmt(current.earliest)} – ${fmt(current.latest)}.`,
    });
  }

  if (current.latest && status !== "delivered" && new Date(current.latest).getTime() < now.getTime()) {
    const daysLate = Math.max(
      1,
      Math.round((now.getTime() - new Date(current.latest).getTime()) / 86_400_000),
    );
    alerts.push({
      kind: "missed",
      title: "Delivery window missed",
      message: `The estimated window ended ${fmt(current.latest)} (${daysLate} day${daysLate === 1 ? "" : "s"} ago) and your order isn't marked delivered. Contact the team for an updated date.`,
    });
  }

  all[reference] = current;
  writeAll(all);
  return alerts;
}
