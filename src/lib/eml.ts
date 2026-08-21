/**
 * Minimal RFC 822 / RFC 2045 message builder.
 *
 * Produces a `multipart/alternative` message (plain text + HTML) that mail
 * clients such as Apple Mail, Outlook and Thunderbird open natively from a
 * downloaded `.eml` file. Bodies are base64 encoded so any UTF-8 content
 * survives without quoted-printable escaping rules.
 */

export type EmlInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | undefined;
  date?: Date | undefined;
  /** Extra informational headers, emitted with an `X-` prefix when unprefixed. */
  extraHeaders?: [string, string][] | undefined;
};

/** Base64 for arbitrary UTF-8 text, wrapped at 76 chars per RFC 2045. */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** RFC 2047 encoded-word so non-ASCII subjects survive transport. */
function encodeHeaderValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${base64Utf8(clean).replace(/\r\n/g, "")}?=`;
}

function headerName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9-]/g, "-");
  return /^(x-|from$|to$|subject$|date$|reply-to$|message-id$|mime-version$|content-)/i.test(clean)
    ? clean
    : `X-${clean}`;
}

export function buildEml(input: EmlInput): string {
  const date = input.date ?? new Date();
  const boundary = `----hybrid-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const messageId = `<${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2)}@hybrid-ai-records.com>`;

  const lines: string[] = [
    `From: ${encodeHeaderValue(input.from)}`,
    `To: ${encodeHeaderValue(input.to)}`,
  ];
  if (input.replyTo) lines.push(`Reply-To: ${encodeHeaderValue(input.replyTo)}`);
  lines.push(
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
  );
  for (const [name, value] of input.extraHeaders ?? []) {
    if (!value) continue;
    lines.push(`${headerName(name)}: ${encodeHeaderValue(value)}`);
  }
  lines.push(
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    "This is a multi-part message in MIME format.",
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Utf8(input.text),
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Utf8(input.html),
    "",
    `--${boundary}--`,
    "",
  );

  return lines.join("\r\n");
}

/** Safe, descriptive filename for a downloaded message. */
export function emlFileName(subject: string, date: Date = new Date()): string {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const slug =
    subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "email";
  return `${stamp}_${slug}.eml`;
}

/** Triggers a browser download of the message as an `.eml` file. */
export function downloadEml(input: EmlInput): void {
  const blob = new Blob([buildEml(input)], { type: "message/rfc822" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = emlFileName(input.subject, input.date ?? new Date());
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
