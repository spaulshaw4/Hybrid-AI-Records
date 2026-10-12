import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SettingsMenu } from "@/components/SettingsMenu";

function signInHref(): string {
  const path = window.location.pathname;
  const next = path.startsWith("/auth") ? "/engine" : `${path}${window.location.search}`;
  const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/engine";
  return `/auth?next=${encodeURIComponent(safe)}`;
}

/** Same sign-in navigation the header Sign In button uses. */
export function openSiteSignIn(): void {
  window.location.assign(signInHref());
}

export default function UserAuthButton() {
  const [user, setUser] = useState<User | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 8 });

  useEffect(() => {
    let cancelled = false;
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (cancelled) return;
        setUser(session?.user ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setLoading(false);
      });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[role='dialog']")) return;
      setIsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[role='dialog']")) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setIsOpen(false);
    window.location.reload();
  };

  const handleSignInRedirect = () => {
    openSiteSignIn();
  };

  if (loading) {
    return (
      <div style={{ fontSize: 12, color: "#64748b", padding: "6px 12px" }}>
        ...
      </div>
    );
  }

  const initial = user?.email?.charAt(0).toUpperCase() || "U";
  const shortName = user?.email?.split("@")[0] || "Account";
  const accountLabel = user ? `Account menu, ${shortName}` : "Account menu";

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) {
            setMenuPos({
              top: rect.bottom + 8,
              right: Math.max(8, window.innerWidth - rect.right),
            });
          }
          setIsOpen((prev) => !prev);
        }}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label={accountLabel}
        className="account-trigger"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: user ? "rgba(255, 255, 255, 0.05)" : "linear-gradient(90deg, #e11d48 0%, #be123c 100%)",
          border: user ? "1px solid rgba(255, 255, 255, 0.12)" : "none",
          borderRadius: 20,
          padding: "4px 8px",
          color: "#f8fafc",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            backgroundColor: user ? "#e11d48" : "rgba(255,255,255,0.18)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            fontWeight: 800,
          }}
        >
          {user ? initial : "S"}
        </span>
        <span className="account-menu-name" style={{ whiteSpace: "nowrap" }}>
          {user ? shortName : "Sign In"}
        </span>
        <span className="account-menu-chevron" style={{ fontSize: 10, color: user ? "#94a3b8" : "#fecdd3" }}>▾</span>
      </button>
      {isOpen && typeof document !== "undefined"
        ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          style={{
            position: "fixed",
            top: menuPos.top,
            right: menuPos.right,
            width: 280,
            maxWidth: "calc(100vw - 1.5rem)",
            backgroundColor: "#130b14",
            border: "1px solid rgba(244, 63, 94, 0.3)",
            borderRadius: 10,
            padding: 10,
            boxShadow: "0 12px 30px rgba(0, 0, 0, 0.8)",
            zIndex: 1000,
            overflow: "visible",
          }}
        >
          {user ? (
            <div
              style={{
                padding: "6px 8px",
                fontSize: 11,
                color: "#94a3b8",
                borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
                marginBottom: 8,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {user.email}
            </div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 4px 8px" }}>
            <div>
              <p style={{ margin: "0 0 6px", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#94a3b8" }}>
                Language
              </p>
              <LanguageSwitcher menuAlign="end" />
            </div>
            <div>
              <p style={{ margin: "0 0 6px", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#94a3b8" }}>
                Currency
              </p>
              <CurrencySwitcher variant="pill" />
            </div>
            <div>
              <p style={{ margin: "0 0 6px", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#94a3b8" }}>
                Settings
              </p>
              <SettingsMenu />
            </div>
          </div>
          {user ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void handleSignOut();
              }}
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderTop: "1px solid rgba(255, 255, 255, 0.06)",
                padding: "10px 8px",
                color: "#fda4af",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                borderRadius: 6,
              }}
            >
              Sign Out
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={handleSignInRedirect}
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderTop: "1px solid rgba(255, 255, 255, 0.06)",
                padding: "10px 8px",
                color: "#ffffff",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                borderRadius: 6,
              }}
            >
              Sign In
            </button>
          )}
        </div>,
          document.body,
        )
        : null}
    </div>
  );
}
