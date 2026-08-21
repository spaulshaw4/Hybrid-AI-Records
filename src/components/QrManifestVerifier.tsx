import { useRef, useState } from "react";
import { toast } from "sonner";

/** SHA-256 checksum, hex encoded — must match the manifest's `sha256` column. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "unavailable";
  const digest = await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Minimal RFC4180 CSV parser (handles quoted cells, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ManifestEntry = {
  filename: string;
  format: string;
  sha256: string;
  size: string;
  /** Expected byte size on disk from the manifest's `fileSizeBytes` column, when present. */
  fileSizeBytes: number | null;
};

/** Pulls filename/format/sha256/fileSizeBytes rows out of a parsed qr-manifest.csv. */
export function manifestEntries(rows: string[][]): ManifestEntry[] {
  const [header = [], ...body] = rows;
  const idx = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const fi = idx("filename");
  const hi = idx("sha256");
  if (fi < 0 || hi < 0) return [];
  const fmt = idx("format");
  const si = idx("size_px");
  const bi = idx("filesizebytes");
  const toBytes = (raw: string) => {
    const n = Number((raw ?? "").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return body
    .map((r) => ({
      filename: (r[fi] ?? "").trim(),
      format: (fmt >= 0 ? r[fmt] ?? "" : "").trim(),
      sha256: (r[hi] ?? "").trim().toLowerCase(),
      size: (si >= 0 ? r[si] ?? "" : "").trim(),
      fileSizeBytes: bi >= 0 ? toBytes(r[bi] ?? "") : null,
    }))
    .filter((e) => e.filename);
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Reads the same entries out of a qr-manifest.json document. */
export function manifestEntriesFromJson(text: string): ManifestEntry[] {
  try {
    const doc = JSON.parse(text) as { files?: unknown };
    const files = Array.isArray(doc?.files) ? doc.files : Array.isArray(doc) ? doc : [];
    return (files as Record<string, unknown>[])
      .map((f) => {
        const bytes = Number(f?.["fileSizeBytes"]);
        return {
          filename: String(f?.["filename"] ?? "").trim(),
          format: String(f?.["format"] ?? "").trim(),
          sha256: String(f?.["sha256"] ?? "").trim().toLowerCase(),
          size: f?.["size_px"] == null ? "" : String(f["size_px"]),
          fileSizeBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
        };
      })
      .filter((e) => e.filename);
  } catch {
    return [];
  }
}



export type VerifyRow = {
  filename: string;
  status: "pass" | "fail" | "missing" | "extra" | "unhashable";
  expected: string;
  actual: string;
  detail: string;
};

/** Compares dropped files against manifest entries and returns one row per file. */
export async function verifyFiles(entries: ManifestEntry[], files: File[]): Promise<VerifyRow[]> {
  const byName = new Map(entries.map((e) => [baseName(e.filename).toLowerCase(), e]));
  const seen = new Set<string>();
  const rows: VerifyRow[] = [];

  for (const file of files) {
    const key = baseName(file.name).toLowerCase();
    const entry = byName.get(key);
    if (!entry) {
      rows.push({
        filename: file.name,
        status: "extra",
        expected: "—",
        actual: "—",
        detail: "Not listed in qr-manifest.csv",
      });
      continue;
    }
    seen.add(key);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const actual = await sha256Hex(bytes);
    const sizeOk = entry.fileSizeBytes == null || entry.fileSizeBytes === bytes.byteLength;
    const sizeNote =
      entry.fileSizeBytes == null
        ? ""
        : sizeOk
          ? ` · ${bytes.byteLength} bytes as expected`
          : ` · size mismatch: expected ${entry.fileSizeBytes} bytes, got ${bytes.byteLength}`;
    if (actual === "unavailable" || entry.sha256 === "unavailable" || !entry.sha256) {
      rows.push({
        filename: file.name,
        status: sizeOk ? "unhashable" : "fail",
        expected: entry.sha256 || "—",
        actual: actual === "unavailable" ? "—" : actual,
        detail: `No checksum available to compare${sizeNote}`,
      });
      continue;
    }
    const hashOk = actual === entry.sha256;
    rows.push({
      filename: file.name,
      status: hashOk && sizeOk ? "pass" : "fail",
      expected: entry.sha256,
      actual,
      detail: hashOk
        ? `${entry.format || "file"} matches manifest${sizeNote}`
        : `Checksum mismatch — file was altered or re-encoded${sizeNote}`,
    });

  }

  for (const entry of entries) {
    const key = baseName(entry.filename).toLowerCase();
    if (seen.has(key)) continue;
    rows.push({
      filename: entry.filename,
      status: "missing",
      expected: entry.sha256 || "—",
      actual: "—",
      detail: "Listed in the manifest but not dropped in",
    });
  }

  return rows;
}

const STATUS_STYLE: Record<VerifyRow["status"], string> = {
  pass: "text-[#4ade80]",
  fail: "text-[#ff6b6b]",
  missing: "text-[#ffb347]",
  extra: "text-[#8fb8ff]",
  unhashable: "text-white/60",
};

/**
 * Drag-and-drop verifier: take the extracted PNG/SVG files plus qr-manifest.csv
 * and confirm every file's SHA256 still matches what was exported.
 */
export default function QrManifestVerifier() {
  const [entries, setEntries] = useState<ManifestEntry[] | null>(null);
  const [manifestName, setManifestName] = useState("");
  const [rows, setRows] = useState<VerifyRow[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function ingest(fileList: File[]) {
    if (!fileList.length) return;
    setBusy(true);
    try {
      const manifestFile = fileList.find((f) => /\.(csv|json)$/i.test(f.name));
      let current = entries;
      let name = manifestName;
      if (manifestFile) {
        const text = await manifestFile.text();
        const parsed = /\.json$/i.test(manifestFile.name)
          ? manifestEntriesFromJson(text)
          : manifestEntries(parseCsv(text));
        if (!parsed.length) {
          toast.error("That file doesn't look like a qr-manifest");
          return;
        }
        current = parsed;
        name = manifestFile.name;
        setEntries(parsed);
        setManifestName(manifestFile.name);
      }
      const assets = fileList.filter((f) => /\.(png|svg)$/i.test(f.name));
      if (!current) {
        toast.error("Drop qr-manifest.csv or qr-manifest.json first, then the PNG/SVG files");
        return;
      }

      if (!assets.length) {
        setRows(null);
        toast.success(`Loaded ${name} — ${current.length} manifest rows. Now drop the PNG/SVG files.`);
        return;
      }
      const result = await verifyFiles(current, assets);
      setRows(result);
      const failed = result.filter((r) => r.status === "fail").length;
      const missing = result.filter((r) => r.status === "missing").length;
      if (failed || missing) toast.error(`${failed} mismatch${failed === 1 ? "" : "es"}, ${missing} missing`);
      else toast.success(`All ${result.filter((r) => r.status === "pass").length} files match the manifest`);
    } catch {
      toast.error("Couldn't verify those files");
    } finally {
      setBusy(false);
    }
  }

  const counts = rows
    ? rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})
    : null;
  const allGood = rows ? rows.every((r) => r.status === "pass") : false;

  return (
    <section data-testid="qr-manifest-verifier" className="space-y-3 border border-white/15 p-3">
      <div className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-widest text-white">Verify extracted files</h4>
        <p className="text-[11px] text-white/60">
          Drop <span className="font-mono">qr-manifest.csv</span> or <span className="font-mono">qr-manifest.json</span> together with the extracted PNG/SVG files to confirm
          every SHA256 still matches the export.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void ingest(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Drop qr-manifest.csv or qr-manifest.json and extracted PNG or SVG files to verify checksums"
        data-testid="qr-verifier-dropzone"
        className={`flex min-h-24 cursor-pointer items-center justify-center border border-dashed px-4 py-6 text-center text-[11px] uppercase tracking-widest transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff] ${
          dragging ? "border-[#4b8bff] bg-white/10 text-white" : "border-white/30 text-white/70 hover:border-white/60"
        }`}
      >
        {busy ? "Hashing files…" : "Drop manifest + PNG/SVG files, or click to choose"}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".csv,.json,.png,.svg"
        className="sr-only"
        data-testid="qr-verifier-input"
        onChange={(e) => {
          void ingest(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {entries ? (
        <p className="text-[11px] text-white/60" data-testid="qr-verifier-manifest-loaded">
          Manifest loaded: <span className="font-mono">{manifestName}</span> — {entries.length} row
          {entries.length === 1 ? "" : "s"}.
        </p>
      ) : null}

      {rows ? (
        <div className="space-y-2" data-testid="qr-verifier-report">
          <p
            className={`text-[11px] font-semibold uppercase tracking-widest ${allGood ? "text-[#4ade80]" : "text-[#ff6b6b]"}`}
            data-testid="qr-verifier-summary"
          >
            {allGood ? "Pass" : "Fail"} — {counts?.pass ?? 0} matched, {counts?.fail ?? 0} mismatched,{" "}
            {counts?.missing ?? 0} missing, {counts?.extra ?? 0} unlisted
          </p>
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[620px] border-collapse text-left text-[11px] text-white/80">
              <thead className="sticky top-0 bg-ink/80 backdrop-blur-sm">
                <tr>
                  {["file", "result", "detail", "expected sha256", "actual sha256"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="whitespace-nowrap border-b border-white/20 px-2 py-1 font-semibold uppercase tracking-widest text-white"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.filename}-${i}`} className="odd:bg-white/5">
                    <td className="max-w-[200px] truncate border-b border-white/10 px-2 py-1 font-mono" title={r.filename}>
                      {r.filename}
                    </td>
                    <td className={`border-b border-white/10 px-2 py-1 font-semibold uppercase ${STATUS_STYLE[r.status]}`}>
                      {r.status}
                    </td>
                    <td className="border-b border-white/10 px-2 py-1">{r.detail}</td>
                    <td className="max-w-[160px] truncate border-b border-white/10 px-2 py-1 font-mono" title={r.expected}>
                      {r.expected}
                    </td>
                    <td className="max-w-[160px] truncate border-b border-white/10 px-2 py-1 font-mono" title={r.actual}>
                      {r.actual}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => setRows(null)}
            data-testid="qr-verifier-clear"
            className="min-h-9 border border-white/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
          >
            Clear report
          </button>
        </div>
      ) : null}
    </section>
  );
}
