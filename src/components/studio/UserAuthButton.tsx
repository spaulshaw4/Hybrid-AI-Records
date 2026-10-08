import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

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

  if (!user) {
    return (
      <button
        type="button"
        onClick={handleSignInRedirect}
        style={{
          background: "linear-gradient(90deg, #e11d48 0%, #be123c 100%)",
          color: "#ffffff",
          border: "none",
          borderRadius: 8,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Sign In
      </button>
    );
  }

  const initial = user.email?.charAt(0).toUpperCase() || "U";
  const shortName = user.email?.split("@")[0] || "Account";

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          backgroundColor: "rgba(255, 255, 255, 0.05)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: 20,
          padding: "4px 12px",
          color: "#f8fafc",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            backgroundColor: "#e11d48",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            fontWeight: 800,
          }}
        >
          {initial}
        </span>
        <span
          style={{
            maxWidth: 120,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {shortName}
        </span>
        <span style={{ fontSize: 10, color: "#94a3b8" }}>▾</span>
      </button>
      {isOpen && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            marginTop: 8,
            width: 200,
            backgroundColor: "#130b14",
            border: "1px solid rgba(244, 63, 94, 0.3)",
            borderRadius: 10,
            padding: 10,
            boxShadow: "0 12px 30px rgba(0, 0, 0, 0.8)",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              padding: "6px 8px",
              fontSize: 11,
              color: "#94a3b8",
              borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
              marginBottom: 6,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {user.email}
          </div>
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
              padding: "8px",
              color: "#fda4af",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              borderRadius: 6,
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.backgroundColor = "rgba(225, 29, 72, 0.15)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
