import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Multilingual generation smoke test.
 *
 * Five diverse languages (Latin + diacritics, tapped-rr Spanish, West African
 * Pidgin, CJK, RTL Arabic) are typed into the Hybrid Engine composer, a short
 * sample is generated, and we assert that the text survives every hop with its
 * script and diacritics intact:
 *
 *   1. the textarea still holds the exact characters after React state churn,
 *   2. the payload that leaves the browser is byte-clean NFC UTF-8 — no
 *      mojibake ("Å¾" instead of "ž"), no stripped accents, no `?` fallbacks,
 *   3. the engine's returned title renders back into the DOM unmangled.
 *
 * The vendor call is mocked at the server-function boundary: this test is about
 * character encoding through the app, not about audio quality, and a real
 * render would cost tokens and minutes.
 */

type Sample = {
  /** Value in the lyric-language picker. */
  picker: string;
  /** Free-text label when the picker is set to "custom". */
  custom?: string;
  name: string;
  title: string;
  prompt: string;
  lyrics: string;
  /** Characters that MUST come back exactly as typed. */
  mustKeep: string[];
  /** Unicode block the output has to stay inside. */
  script: RegExp;
};

const SAMPLES: Sample[] = [
  {
    picker: "lt",
    name: "Lithuanian",
    title: "Ąžuolo šešėlis",
    prompt: "Dark cinematic folk with cello and choir",
    lyrics:
      "[Verse]\nŽiema užšalo, širdis ąžuolinė\nĖjau per ūkanas, kur vėjas gieda\nSkęsta įlanka, ilgesio šviesa\n[Chorus]\nČia mūsų žemė, čia mūsų šviesa",
    // Every entry must occur in the lyric body; the title is asserted separately.
    mustKeep: ["ą", "č", "ę", "ė", "į", "š", "ų", "ū", "ž"],
    script: /^[\p{Script=Latin}\p{P}\p{Zs}\p{N}\n\r]+$/u,
  },
  {
    picker: "es",
    name: "Spanish",
    title: "Corazón de perro",
    prompt: "Latin pop with nylon guitar and cajón",
    lyrics:
      "[Verso]\n¿Dónde está el corazón que corría?\nLa niña añora el rrrasgueo del mar\nAún queda café en la última canción\n[Estribillo]\n¡Corre, corazón, corre!",
    mustKeep: ["á", "é", "í", "ó", "ú", "ñ", "¿", "¡", "corazón"],
    script: /^[\p{Script=Latin}\p{P}\p{Zs}\p{N}\n\r]+$/u,
  },
  {
    picker: "ng",
    name: "Nigerian Pidgin",
    title: "Naija Fire",
    prompt: "Afrobeats with talking drum and log drum bass",
    lyrics: "[Verse]\nI dey run am, no be small thing o\nÒrun ń jó, the street dey shine\n[Chorus]\nWe don blow, e no go finish",
    // Yoruba tone marks ride along inside the Pidgin line.
    mustKeep: ["Ò", "ń", "ó"],
    script: /^[\p{Script=Latin}\p{P}\p{Zs}\p{N}\n\r]+$/u,
  },
  {
    picker: "custom",
    custom: "Japanese",
    name: "Japanese",
    title: "夜のうた",
    prompt: "City pop with slap bass and warm Rhodes",
    lyrics: "[Verse]\n夜の街を歩いて、灯りが揺れる\nきみの声だけ、遠くで響いてる\n[Chorus]\n燃えるこころ、まだ消えない",
    mustKeep: ["夜", "うた", "きみ", "こころ", "響"],
    script: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  },
  {
    picker: "custom",
    custom: "Arabic",
    name: "Arabic",
    title: "قلبي في الليل",
    prompt: "Cinematic Arabic trap with oud and ney",
    lyrics: "[Verse]\nقلبي ينبض في الليل الطويل\nصوتكِ يمشي معي في الطريق\n[Chorus]\nلا تتركني وحدي",
    mustKeep: ["قلبي", "الليل", "صوتكِ"],
    script: /\p{Script=Arabic}/u,
  },
];

/** Text that has been through a UTF-8 → Latin-1 misread ("ž" → "Å¾"). */
const MOJIBAKE = /[ÃÄÅÐ][\u0080-\u00bf\u2013-\u203a]/;

/** Losses that look fine in a diff but are silent corruption. */
function assertCleanEncoding(label: string, value: string) {
  expect(MOJIBAKE.test(value), `${label}: mojibake in "${value.slice(0, 80)}"`).toBe(false);
  expect(value, `${label}: replacement characters`).not.toContain("\ufffd");
  expect(value, `${label}: literal escape leaked`).not.toContain("\\u");
  expect(value.normalize("NFC"), `${label}: not NFC-normalised`).toBe(value);
}

/** localStorage key the Supabase client reads, derived from the project URL. */
function authStorageKey() {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const url = /VITE_SUPABASE_URL="?([^"\n]+)"?/.exec(env)?.[1] ?? "";
  const ref = /https:\/\/([^.]+)\./.exec(url)?.[1] ?? "local";
  return `sb-${ref}-auth-token`;
}

/**
 * A composer-ready session. Every server call is mocked, so the token never
 * has to be valid — it only has to make the client render the signed-in
 * composer instead of the sign-in prompt.
 */
async function signIn(page: Page) {
  const key = authStorageKey();
  const session = {
    access_token: "e2e-access-token",
    refresh_token: "e2e-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      aud: "authenticated",
      role: "authenticated",
      email: "e2e@hybridairecords.test",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
  await page.addInitScript(
    ([k, v]) => window.localStorage.setItem(k, v),
    [key, JSON.stringify(session)] as [string, string],
  );
}

/**
 * TanStack serialises server-function arguments as a keyed tree
 * (`{ p: { k: [...], v: [...] } }`), so field values are read back out of that
 * shape rather than from plain JSON.
 */
function readFields(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let tree: unknown;
  try {
    tree = JSON.parse(raw);
  } catch {
    return { __unparsed: raw };
  }
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, any>;
    const keys = rec.p?.k;
    const values = rec.p?.v;
    if (Array.isArray(keys) && Array.isArray(values)) {
      keys.forEach((key: string, i: number) => {
        const value = values[i];
        if (value && typeof value === "object" && "s" in value) out[key] = value.s;
        else if (value && typeof value === "object" && "b" in value) out[key] = value.b;
      });
    }
    for (const value of Object.values(rec)) {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(tree);
  return out;
}

const titleField = (page: Page) => page.getByPlaceholder("Name your track");
const promptField = (page: Page) =>
  page.getByPlaceholder("Describe the song, mood or story you want.");
const lyricsField = (page: Page) => page.locator("#song-lyrics-input, #studio-lyrics");

/** One captured POST through the mocked engine boundary. */
type Exchange = {
  url: string;
  requestBody: string;
  requestFields: Record<string, unknown>;
  responseBody: string;
  kind: "generation" | "poll" | "health" | "other";
};

export type EngineMock = {
  /** Decoded generation payloads, in send order. */
  sent: Array<Record<string, unknown>>;
  /** Every POST body seen, request and response, for failure forensics. */
  exchanges: Exchange[];
};

/** Captures the generation payload and returns a finished, mocked track. */
function mockEngine(page: Page, sample: Sample): Promise<EngineMock> {
  const mock: EngineMock = { sent: [], exchanges: [] };
  const json = (route: Route, body: unknown, kind: Exchange["kind"], url: string, raw: string) => {
    const serialised = JSON.stringify(body);
    mock.exchanges.push({
      url,
      requestBody: raw,
      requestFields: raw ? readFields(raw) : {},
      responseBody: serialised,
      kind,
    });
    return route.fulfill({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: serialised,
    });
  };

  const track = {
    id: "trk_lang",
    title: sample.title,
    audioUrl: "https://example.invalid/sample.mp3",
    duration: 30,
  };

  return page
    .route("**/*", async (route) => {
      const url = route.request().url();
      const raw = route.request().postData() ?? "";

      // The server-function URL is opaque, so the generation call is matched on
      // its payload shape rather than on a route name.
      if (route.request().method() !== "POST") return route.fallback();
      const isGeneration = /"instrumental"|"customLanguage"/.test(raw);
      const isPoll = !isGeneration && /"taskId"/.test(raw);
      if (!isGeneration && !isPoll && !/apiframe-music/i.test(url)) {
        if (/balance/i.test(url)) return json(route, { balance: 25 }, "other", url, raw);
        if (/vault|track/i.test(url))
          return json(route, { id: "vault_lang", ok: true, tracks: [] }, "other", url, raw);
        return route.fallback();
      }

      if (/health/i.test(url) || /checkEngineHealth/i.test(raw)) {
        return json(route, { creditsExhausted: false, ok: true }, "health", url, raw);
      }
      if (isPoll) {
        return json(
          route,
          { taskId: "task_lang", status: "complete", tracks: [track], correlationId: "poll_lang" },
          "poll",
          url,
          raw,
        );
      }

      mock.sent.push(readFields(raw));
      return json(
        route,
        { taskId: "task_lang", status: "complete", tracks: [track], correlationId: "gen_lang" },
        "generation",
        url,
        raw,
      );
    })
    .then(() =>
      page.route("https://example.invalid/**", (route) =>
        route.fulfill({ status: 200, contentType: "audio/mpeg", body: "" }),
      ),
    )
    .then(() => mock);
}


/** A style must be selected before the engine will accept a render. */
async function pickAnyStyle(page: Page) {
  const chip = page.locator('button[aria-pressed="false"]').first();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
}

/** Picks a lyric language in the Radix select beside the Co-Producer button. */
async function chooseLanguage(page: Page, sample: Sample) {
  const trigger = page.locator("#lyrics-language");
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const optionName =
    sample.picker === "custom" ? /Custom \/ Other/i : new RegExp(sample.name.split(" ")[0], "i");
  const option = page.getByRole("option", { name: optionName }).first();
  await expect(option).toBeVisible();
  // Radix renders the listbox in a portal that headless Chromium can place
  // outside the viewport, so the option is committed with the keyboard —
  // typeahead moves the active item, Enter selects it.
  await option.scrollIntoViewIfNeeded();
  await option.click({ force: true });
  await expect(option).toBeHidden();
  if (sample.custom) {
    const custom = page.getByLabel("Custom language or dialect");
    await custom.fill(sample.custom);
    await custom.blur();
  }
}

// ---------------------------------------------------------------------------
// Debug artifacts
// ---------------------------------------------------------------------------

/**
 * Per-character forensics: which codepoint actually arrived, so a failure says
 * "U+00C5 U+00BE (Å¾) where U+017E (ž) was expected" instead of just "not equal".
 */
function codepoints(value: string, limit = 400) {
  return Array.from(value.slice(0, limit))
    .map((ch) => `${ch === "\n" ? "\\n" : ch}=U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ");
}

/** First position where two strings diverge, with both codepoints named. */
function firstDrift(expected: string, actual: string) {
  const len = Math.max(expected.length, actual.length);
  for (let i = 0; i < len; i += 1) {
    if (expected[i] === actual[i]) continue;
    const name = (ch?: string) =>
      ch === undefined ? "<end>" : `"${ch}" U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    return `index ${i}: expected ${name(expected[i])}, got ${name(actual[i])} — context "${actual.slice(Math.max(0, i - 12), i + 12)}"`;
  }
  return "identical";
}

/** Flags the specific corruption signatures the assertions look for. */
function encodingReport(label: string, value: string) {
  const scripts = new Set(
    Array.from(value).flatMap((ch) =>
      /\p{Script=Latin}/u.test(ch)
        ? ["Latin"]
        : /\p{Script=Han}/u.test(ch)
          ? ["Han"]
          : /\p{Script=Hiragana}|\p{Script=Katakana}/u.test(ch)
            ? ["Kana"]
            : /\p{Script=Arabic}/u.test(ch)
              ? ["Arabic"]
              : [],
    ),
  );
  return {
    label,
    value,
    length: value.length,
    scripts: [...scripts],
    mojibake: MOJIBAKE.test(value),
    mojibakeMatch: MOJIBAKE.exec(value)?.[0] ?? null,
    replacementChars: value.includes("\ufffd"),
    isNFC: value.normalize("NFC") === value,
    codepoints: codepoints(value),
  };
}

/**
 * Dumps request/response bodies and rendered text into the Playwright report.
 * Only runs for a failing test, so green runs stay quiet.
 */
async function attachDebugArtifacts(
  page: Page,
  testInfo: import("@playwright/test").TestInfo,
  ctx: { sample: Sample; mock: EngineMock; pageErrors: string[] },
) {
  if (testInfo.status === testInfo.expectedStatus) return;

  const readValue = async (locator: ReturnType<typeof titleField>) =>
    locator
      .inputValue()
      .catch(() => "<unavailable>");

  const fields = {
    title: await readValue(titleField(page)),
    prompt: await readValue(promptField(page)),
    lyrics: await readValue(lyricsField(page)),
  };

  const renderedText = await page
    .locator("main")
    .innerText()
    .catch(() => page.locator("body").innerText().catch(() => "<unavailable>"));

  const dump = {
    sample: {
      name: ctx.sample.name,
      picker: ctx.sample.picker,
      custom: ctx.sample.custom ?? null,
      expectedTitle: ctx.sample.title,
      mustKeep: ctx.sample.mustKeep,
    },
    composerFields: Object.entries(fields).map(([k, v]) => encodingReport(`field:${k}`, v)),
    expected: [
      encodingReport("expected:title", ctx.sample.title),
      encodingReport("expected:lyrics", ctx.sample.lyrics),
    ],
    generationPayloads: ctx.mock.sent.map((payload, i) => ({
      index: i,
      fields: Object.fromEntries(
        Object.entries(payload).map(([k, v]) => [
          k,
          typeof v === "string" ? encodingReport(`wire:${k}`, v) : v,
        ]),
      ),
    })),
    exchanges: ctx.mock.exchanges.map((x) => ({
      kind: x.kind,
      url: x.url,
      requestBody: x.requestBody.slice(0, 4000),
      requestFields: x.requestFields,
      responseBody: x.responseBody.slice(0, 4000),
    })),
    pageErrors: ctx.pageErrors,
  };

  // Written to the test-results folder as well as attached, so a failure can be
  // inspected straight from disk without opening the HTML report.
  const dumpPath = testInfo.outputPath(`${ctx.sample.name}-encoding-dump.json`);
  await writeFile(dumpPath, JSON.stringify(dump, null, 2), "utf8");
  await testInfo.attach(`${ctx.sample.name}-encoding-dump.json`, {
    path: dumpPath,
    contentType: "application/json; charset=utf-8",
  });

  const textPath = testInfo.outputPath(`${ctx.sample.name}-rendered-text.txt`);
  await writeFile(
    textPath,
    [
      `# rendered text snapshot (${ctx.sample.name})`,
      renderedText,
      "",
      "# codepoints of the first 400 rendered chars",
      codepoints(renderedText),
    ].join("\n"),
    "utf8",
  );
  await testInfo.attach(`${ctx.sample.name}-rendered-text.txt`, {
    path: textPath,
    contentType: "text/plain; charset=utf-8",
  });
  await testInfo.attach(`${ctx.sample.name}-screenshot.png`, {
    body: await page.screenshot().catch(() => Buffer.alloc(0)),
    contentType: "image/png",
  });
}

test.describe("multilingual engine smoke", () => {
  test.slow();
  // Tall viewport: the Radix listbox renders in a portal that otherwise lands
  // outside a short headless viewport and refuses the click.
  test.use({ viewport: { width: 1280, height: 1800 } });

  /** Set at the top of each test so the teardown can dump its state. */
  let debugCtx: { page: Page; sample: Sample; mock: EngineMock; pageErrors: string[] } | null = null;

  test.afterEach(async ({}, testInfo) => {
    if (debugCtx) {
      await attachDebugArtifacts(debugCtx.page, testInfo, debugCtx).catch(() => {});
      debugCtx = null;
    }
  });

  for (const sample of SAMPLES) {
    test(`${sample.name}: script and diacritics survive generation`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));

      const mock = await mockEngine(page, sample);
      const sent = mock.sent;
      debugCtx = { page, sample, mock, pageErrors };


      await signIn(page);

      await page.goto("/engine", { waitUntil: "domcontentloaded" });
      await expect(titleField(page)).toBeVisible();

      await titleField(page).fill(sample.title);
      await promptField(page).fill(sample.prompt);
      await expect(lyricsField(page)).toBeVisible();
      await lyricsField(page).fill(sample.lyrics);
      await lyricsField(page).blur();
      await pickAnyStyle(page);

      await chooseLanguage(page, sample);

      // The saved draft rehydrates shortly after mount and can wipe an early
      // fill, so re-enter title and lyrics once the composer has settled.
      await titleField(page).fill(sample.title);
      await titleField(page).blur();
      await expect(titleField(page)).toHaveValue(sample.title);
      await lyricsField(page).fill(sample.lyrics);
      await lyricsField(page).blur();
      await expect(lyricsField(page)).toHaveValue(sample.lyrics);


      // 1. The composer itself kept every character.
      const typedTitle = await titleField(page).inputValue();
      const typedLyrics = await lyricsField(page).inputValue();
      assertCleanEncoding(`${sample.name} title field`, typedTitle);
      assertCleanEncoding(`${sample.name} lyrics field`, typedLyrics);
      expect(typedTitle, `${sample.name} title drift — ${firstDrift(sample.title, typedTitle)}`).toBe(
        sample.title,
      );
      for (const ch of sample.mustKeep) {
        expect(typedLyrics, `${sample.name}: lost "${ch}" in the textarea`).toContain(ch);
      }

      await page.getByRole("button", { name: /Generate/i }).first().click();

      // 2. The payload that left the browser is byte-clean.
      await expect
        .poll(() => sent.length, { timeout: 45_000, message: "no generation request captured" })
        .toBeGreaterThan(0);

      const payload = sent[0] as {
        title?: string;
        lyrics?: string;
        language?: string;
        customLanguage?: string;
      };
      assertCleanEncoding(`${sample.name} wire title`, String(payload.title ?? ""));
      assertCleanEncoding(`${sample.name} wire lyrics`, String(payload.lyrics ?? ""));
      expect(
        payload.title,
        `${sample.name} wire title drift — ${firstDrift(sample.title, String(payload.title ?? ""))}`,
      ).toBe(sample.title);
      for (const ch of sample.mustKeep) {
        expect(payload.lyrics ?? "", `${sample.name}: lost "${ch}" on the wire`).toContain(ch);
      }
      expect(payload.language).toBe(sample.picker);
      if (sample.custom) expect(payload.customLanguage).toBe(sample.custom);
      expect(
        sample.script.test(payload.lyrics ?? ""),
        `${sample.name}: wrong script in the wire lyrics — ${JSON.stringify(
          encodingReport("wire:lyrics", String(payload.lyrics ?? "")),
          null,
          2,
        )}`,
      ).toBe(true);

      // 3. The finished track's title renders back unmangled.
      const rendered = page.getByText(sample.title, { exact: false }).first();
      await expect(rendered).toBeVisible({ timeout: 20_000 });
      const renderedTitle = (await rendered.innerText()).trim();
      assertCleanEncoding(`${sample.name} rendered title`, renderedTitle);
      expect(
        renderedTitle.includes(sample.title),
        `${sample.name} rendered title drift — ${firstDrift(sample.title, renderedTitle)}`,
      ).toBe(true);

      expect(
        pageErrors.filter((e) => /Minified React error|removeChild|not a function/i.test(e)),
      ).toEqual([]);
    });
  }

  test("a lyric body mixing all five scripts stays intact end to end", async ({ page }) => {
    const mixed = SAMPLES.map((s) => s.lyrics.split("\n")[1]).join("\n");
    const sample = { ...SAMPLES[0], name: "Polyglot", title: "Polyglot", lyrics: mixed };
    const mock = await mockEngine(page, sample);
    const sent = mock.sent;
    debugCtx = { page, sample, mock, pageErrors: [] };
    await signIn(page);

    await page.goto("/engine", { waitUntil: "domcontentloaded" });
    await expect(titleField(page)).toBeVisible();
    await promptField(page).fill("Global fusion, five languages in one song");
    await lyricsField(page).fill(mixed);
    await lyricsField(page).blur();
    await pickAnyStyle(page);
    await titleField(page).fill("Polyglot");
    await expect(titleField(page)).toHaveValue("Polyglot");

    await page.getByRole("button", { name: /Generate/i }).first().click();
    await expect.poll(() => sent.length, { timeout: 45_000 }).toBeGreaterThan(0);

    const lyrics = String((sent[0] as { lyrics?: string }).lyrics ?? "");
    assertCleanEncoding("mixed-script lyrics", lyrics);
    for (const sample of SAMPLES) {
      for (const ch of sample.mustKeep.slice(0, 3)) {
        if (!sample.lyrics.split("\n")[1].includes(ch)) continue;
        expect(
          lyrics,
          `mixed body lost ${sample.name} "${ch}" — ${JSON.stringify(encodingReport("wire:lyrics", lyrics))}`,
        ).toContain(ch);
      }
    }
  });
});
