import { useCallback, useEffect, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import {
  listNotifications,
  markNotificationsRead,
  type AppNotification,
} from "@/lib/notifications.functions";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useReturnFocus } from "@/hooks/use-return-focus";

/** Fires after any action that can create a notification (credit, failure). */
export const NOTIFICATIONS_CHANGED = "hybrid:notifications-changed";

export function refreshNotifications() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED));
  }
}

/** Bell with unread count plus a short inbox of token and generation alerts. */
export function NotificationBell({ signedIn = true }: { signedIn?: boolean }) {
  const load = useServerFn(listNotifications);
  const markRead = useServerFn(markNotificationsRead);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const { triggerRef, open, setOpen, contentProps } = useReturnFocus<HTMLButtonElement>();

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    setLoading(true);
    try {
      const result = await load({ data: undefined });
      setItems(result.items);
      setUnread(result.unread);
    } catch {
      /* signed out or offline — keep the bell quiet */
    } finally {
      setLoading(false);
    }
  }, [load, signedIn]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(NOTIFICATIONS_CHANGED, onChange);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED, onChange);
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (!signedIn) return null;

  async function handleMarkAll() {
    setUnread(0);
    setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() })));
    try {
      await markRead({ data: {} });
    } catch {
      void refresh();
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
          className="relative inline-flex size-8 items-center justify-center rounded-full border border-border/70 bg-background/60"
        >
          <Bell className="size-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" {...contentProps} className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void handleMarkAll()}>
              Mark all read
            </Button>
          ) : null}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {loading && items.length === 0 ? (
            <p className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-xs text-muted-foreground">
              No notifications yet. Token credits and generation issues show up here.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={`px-3 py-2 ${item.readAt ? "opacity-70" : "bg-primary/5"}`}
                >
                  <p className="text-xs font-semibold">{item.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                    {item.emailed ? " · emailed" : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default NotificationBell;
