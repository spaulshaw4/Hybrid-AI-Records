export type TrackCreationEmailProps = {
  trackTitle: string;
  creatorName: string;
  generatedAtLabel: string;
  masterDownloadUrl: string;
  vaultUrl: string;
};

/** Congratulatory track-ready email rendered by Resend (`react:` payload). */
export function TrackCreationEmail({
  trackTitle,
  creatorName,
  generatedAtLabel,
  masterDownloadUrl,
  vaultUrl,
}: TrackCreationEmailProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Your New Track Is Ready</title>
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
                          Your vision just became a master.
                        </h1>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "8px 28px 0" }}>
                        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.65, color: "#334155" }}>
                          {creatorName}, congratulations. Your creativity, bold vision, and
                          dedication to writing and making hybrid music brought{" "}
                          <strong style={{ color: "#0F172A" }}>{trackTitle}</strong> into the world —
                          and the high-quality master is ready for you.
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "22px 28px 0" }}>
                        <table
                          width="100%"
                          cellPadding={0}
                          cellSpacing={0}
                          style={{
                            backgroundColor: "#FAF8F4",
                            border: "1px solid #E7E0D4",
                            borderRadius: 10,
                          }}
                        >
                          <tbody>
                            <tr>
                              <td style={{ padding: "20px 22px" }}>
                                <p
                                  style={{
                                    margin: 0,
                                    fontSize: 10,
                                    letterSpacing: "0.16em",
                                    textTransform: "uppercase",
                                    color: "#E11D48",
                                    fontWeight: 700,
                                  }}
                                >
                                  Certificate of Creation
                                </p>
                                <p
                                  style={{
                                    margin: "10px 0 0",
                                    fontSize: 18,
                                    fontWeight: 700,
                                    color: "#0F172A",
                                  }}
                                >
                                  {trackTitle}
                                </p>
                                <p style={{ margin: "8px 0 0", fontSize: 13, color: "#64748B" }}>
                                  Creator · {creatorName}
                                </p>
                                <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748B" }}>
                                  Generated · {generatedAtLabel}
                                </p>
                                <p style={{ margin: "14px 0 0", fontSize: 12, color: "#94A3B8" }}>
                                  Official Hybrid AI Records seal attached as PDF.
                                </p>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "24px 28px 8px" }}>
                        <a
                          href={masterDownloadUrl}
                          style={{
                            display: "inline-block",
                            backgroundColor: "#E11D48",
                            color: "#ffffff",
                            textDecoration: "none",
                            fontWeight: 600,
                            fontSize: 14,
                            padding: "12px 18px",
                            borderRadius: 8,
                            marginRight: 10,
                          }}
                        >
                          Download your master
                        </a>
                        <a
                          href={vaultUrl}
                          style={{
                            display: "inline-block",
                            backgroundColor: "#0F172A",
                            color: "#ffffff",
                            textDecoration: "none",
                            fontWeight: 600,
                            fontSize: 14,
                            padding: "12px 18px",
                            borderRadius: 8,
                          }}
                        >
                          Open Audio Vault
                        </a>
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "8px 28px 32px" }}>
                        <p style={{ margin: "12px 0 0", fontSize: 12, color: "#64748B", lineHeight: 1.5 }}>
                          Keep making fearless hybrid records. Questions? Reply to this email or
                          write{" "}
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
