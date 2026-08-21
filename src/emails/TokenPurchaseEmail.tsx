type TokenKind = "hybrid" | "v" | "artist";

export type TokenPurchaseEmailProps = {
  amount: number;
  balance: number;
  tokenKind: TokenKind;
  studioUrl: string;
};

function labels(kind: TokenKind): { name: string; use: string } {
  if (kind === "v") {
    return { name: "V Tokens", use: "cinematic video renders" };
  }
  if (kind === "artist") {
    return { name: "Artist Tokens", use: "catalog track downloads" };
  }
  return { name: "Hybrid Tokens", use: "studio generations" };
}

/** Transactional receipt rendered by Resend (`react:` payload). */
export function TokenPurchaseEmail({
  amount,
  balance,
  tokenKind,
  studioUrl,
}: TokenPurchaseEmailProps) {
  const { name, use } = labels(tokenKind);
  const amountLabel = `${amount} ${name}`;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Your Tokens Have Been Credited!</title>
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: "#F8FAFC",
          color: "#0F172A",
          fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
        }}
      >
        <table width="100%" cellPadding={0} cellSpacing={0} style={{ backgroundColor: "#F8FAFC" }}>
          <tbody>
            <tr>
              <td style={{ padding: "32px 16px" }}>
                <table
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{
                    maxWidth: 560,
                    margin: "0 auto",
                    backgroundColor: "#ffffff",
                    border: "1px solid #E2E8F0",
                    borderLeft: "4px solid #E11D48",
                    borderRadius: 12,
                  }}
                >
                  <tbody>
                    <tr>
                      <td style={{ padding: "28px 28px 8px" }}>
                        <p
                          style={{
                            margin: 0,
                            fontSize: 11,
                            letterSpacing: "0.18em",
                            textTransform: "uppercase",
                            color: "#E11D48",
                            fontWeight: 700,
                          }}
                        >
                          Hybrid AI Records
                        </p>
                        <h1
                          style={{
                            margin: "12px 0 0",
                            fontSize: 22,
                            lineHeight: 1.3,
                            letterSpacing: "-0.02em",
                          }}
                        >
                          Your Tokens Have Been Credited!
                        </h1>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "8px 28px 0" }}>
                        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "#334155" }}>
                          {amountLabel} {amount === 1 ? "was" : "were"} added to your account and
                          are ready for {use}.
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "20px 28px 0" }}>
                        <table
                          width="100%"
                          cellPadding={0}
                          cellSpacing={0}
                          style={{ backgroundColor: "#F8FAFC", borderRadius: 8 }}
                        >
                          <tbody>
                            <tr>
                              <td style={{ padding: "16px 18px" }}>
                                <p style={{ margin: 0, fontSize: 12, color: "#64748B" }}>Credited</p>
                                <p style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700 }}>
                                  {amount}
                                </p>
                              </td>
                              <td style={{ padding: "16px 18px" }}>
                                <p style={{ margin: 0, fontSize: 12, color: "#64748B" }}>
                                  New {name} balance
                                </p>
                                <p style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700 }}>
                                  {balance}
                                </p>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "24px 28px 32px" }}>
                        <a
                          href={studioUrl}
                          style={{
                            display: "inline-block",
                            backgroundColor: "#E11D48",
                            color: "#ffffff",
                            textDecoration: "none",
                            fontWeight: 600,
                            fontSize: 14,
                            padding: "12px 18px",
                            borderRadius: 8,
                          }}
                        >
                          Open the studio
                        </a>
                        <p style={{ margin: "20px 0 0", fontSize: 12, color: "#64748B" }}>
                          Questions? Reply to this email or write{" "}
                          <a href="mailto:info@hybrid-ai-records.com" style={{ color: "#2563EB" }}>
                            info@hybrid-ai-records.com
                          </a>
                          .
                        </p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}
