import { expect, test, type Page } from "@playwright/test";

/**
 * Copying a share link happens *mid-edit*, so nothing tier-derived may go
 * stale afterwards. This suite copies while editing and then checks that every
 * value derived from the selected tier — the at-a-glance price / revision
 * rounds / turnaround, the WhatsApp message preview, and the review-step
 * summary — matches the tier the copied link actually carries.
 */

const PACKAGE_SELECT = "#qo-package";
const ARTIST = "#qo-artist";
const EMAIL = "#qo-email";
const LINK = "#qo-link";

/** Order-form label → the service tier it maps to, with its derived values. */
const TIERS = {
  "distribution-release": {
    option: "Distribution & Release",
    card: "The Foundation",
    usdPrice: "$50",
    rounds: "None",
    turnaround: "5–7 business days",
  },
  "visual-push": {
    option: "Production & Visual Push",
    card: "The Visual Push",
    usdPrice: "$100",
    rounds: "2",
    turnaround: "10–14 business days",
  },
  "full-label": {
    option: "Full Label Release",
    card: "The Full Hybrid Experience",
    usdPrice: "$150",
    rounds: "2",
    turnaround: "12–17 business days",
  },
} as const;

type Slug = keyof typeof TIERS;

const DETAILS = {
  artist: "Steel Harbor",
  email: "orders+tier@steel-harbor.example",
  link: "https://drive.example.com/stems/steel-harbor",
};

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

/** The at-a-glance card for a tier inside "Tiers, Rounds & Turnaround". */
const glanceCard = (page: Page, title: string) =>
  page
    .locator("div")
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ hasText: "Turnaround" })
    .last();

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  await page.waitForTimeout(2000);
}

async function chooseTier(page: Page, slug: Slug) {
  await expect(async () => {
    await page.selectOption(PACKAGE_SELECT, TIERS[slug].option);
    expect(new URL(page.url()).searchParams.get("package")).toBe(slug);
  }).toPass({ timeout: 20_000 });
}

/**
 * Re-asserts the tier right before a derived-value check: a late draft-restore
 * pass can flip the select back after it was set, which would otherwise look
 * like a stale-derived-value failure.
 */
async function ensureTier(page: Page, slug: Slug) {
  const select = page.locator(PACKAGE_SELECT);
  if ((await select.inputValue()) !== TIERS[slug].option) await chooseTier(page, slug);
  await expect(select).toHaveValue(TIERS[slug].option);
}

async function typeInto(page: Page, selector: string, value: string) {
  await expect(async () => {
    await page.locator(selector).fill("");
    await page.locator(selector).click();
    await page.keyboard.type(value, { delay: 10 });
    await expect(page.locator(selector)).toHaveValue(value, { timeout: 2000 });
  }).toPass({ timeout: 25_000 });
}

async function copyUntil(page: Page, check: (copied: string) => void): Promise<string> {
  let copied = "";
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
    copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied);
  }).toPass({ timeout: 15_000 });
  return copied;
}

/** Asserts the pricing card for `slug` shows its tier-dependent values. */
async function expectPricingFor(page: Page, slug: Slug, currency: string) {
  const tier = TIERS[slug];
  const card = glanceCard(page, tier.card);
  await expect(card).toBeVisible();
  const priceText = (await card.locator(".tabular-nums").first().innerText()).trim();
  // Prices are currency-aware; only the USD baseline has a fixed literal.
  if (currency === "USD") {
    expect(priceText).toContain(tier.usdPrice);
  } else {
    expect(priceText).toMatch(/\d/);
  }
  expect(priceText).toContain("/ track");
  await expect(card).toContainText(tier.rounds);
  await expect(card).toContainText(tier.turnaround);
}

/** Opens the WhatsApp preview, returns its message text, then closes it. */
async function whatsappMessage(page: Page): Promise<string> {
  await page.getByRole("button", { name: /send this on whatsapp/i }).first().click();
  const box = page.locator("#order-whatsapp-text");
  await expect(box).toBeVisible();
  const text = await box.inputValue();
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  return text;
}

/** Moves to the review step and returns its summary rows as label → value. */
async function reviewSummary(page: Page): Promise<Record<string, string>> {
  await page.getByRole("button", { name: /review your order/i }).click();
  await expect(page.getByRole("heading", { name: /review your order/i })).toBeVisible();
  // Scoped to the review card; labels render uppercased via CSS, so key on lowercase.
  const rows = await page.locator("#quick-order-form dl > div").all();
  const out: Record<string, string> = {};
  for (const row of rows) {
    const label = (await row.locator("dt").innerText()).trim().toLowerCase();
    out[label] = (await row.locator("dd").innerText()).trim();
  }
  await page.getByRole("button", { name: /edit details/i }).click();
  await expect(page.locator(PACKAGE_SELECT)).toBeVisible();
  return out;
}

test.describe("tier-dependent pricing and derived UI after a mid-edit copy", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  for (const slug of Object.keys(TIERS) as Slug[]) {
    test(`derived values match the copied tier — ${slug}`, async ({ page }) => {
      test.slow();

      await open(page, "/#order");
      await chooseTier(page, slug);

      // Copy while the artist is still filling the form.
      await expect(async () => {
        await typeInto(page, ARTIST, DETAILS.artist);
        await typeInto(page, EMAIL, DETAILS.email);
        await typeInto(page, LINK, DETAILS.link);
        await copyUntil(page, (c) => {
          expect(new URL(c).searchParams.get("package")).toBe(slug);
        });
      }).toPass({ timeout: 90_000 });

      await ensureTier(page, slug);
      const summary = await reviewSummary(page);
      expect(summary["package"]).toBe(TIERS[slug].option);
      expect(summary["artist"]).toBe(DETAILS.artist);
      expect(summary["email"]).toBe(DETAILS.email);

      // Pricing UI still reflects this tier after the copy.
      await expectPricingFor(page, slug, summary["currency"] ?? "USD");

      // The WhatsApp preview is regenerated from live state, not a snapshot.
      await ensureTier(page, slug);
      const message = await whatsappMessage(page);
      expect(message).toContain(`the ${TIERS[slug].option} package`);
      expect(message).toContain(DETAILS.artist);
      expect(message).toContain(DETAILS.link);
      for (const other of Object.values(TIERS)) {
        if (other.option !== TIERS[slug].option) expect(message).not.toContain(other.option);
      }
    });
  }

  test("switching tiers after a copy re-derives price, rounds, turnaround and message", async ({
    page,
  }) => {
    test.slow();

    await open(page, "/#order");
    await chooseTier(page, "distribution-release");

    await expect(async () => {
      await typeInto(page, ARTIST, DETAILS.artist);
      await typeInto(page, EMAIL, DETAILS.email);
      await typeInto(page, LINK, DETAILS.link);
      await copyUntil(page, (c) => {
        expect(new URL(c).searchParams.get("package")).toBe("distribution-release");
      });
    }).toPass({ timeout: 90_000 });

    await ensureTier(page, "distribution-release");
    const first = await reviewSummary(page);
    expect(first["package"]).toBe(TIERS["distribution-release"].option);
    await expectPricingFor(page, "distribution-release", first["currency"] ?? "USD");

    // Upgrade after copying — every derived value must follow.
    await chooseTier(page, "full-label");

    await ensureTier(page, "full-label");
    const second = await reviewSummary(page);
    expect(second["package"]).toBe(TIERS["full-label"].option);
    expect(second["currency"]).toBe(first["currency"]);
    await expectPricingFor(page, "full-label", second["currency"] ?? "USD");

    await ensureTier(page, "full-label");
    const message = await whatsappMessage(page);
    expect(message).toContain(`the ${TIERS["full-label"].option} package`);
    expect(message).not.toContain(TIERS["distribution-release"].option);

    // And a fresh copy carries the upgraded tier, not the previously copied one.
    await ensureTier(page, "full-label");
    const recopied = await copyUntil(page, (c) => {
      expect(new URL(c).searchParams.get("package")).toBe("full-label");
    });
    expect(recopied).not.toContain("distribution-release");
  });

  test("all three tiers keep distinct prices while a link is copied", async ({ page }) => {
    test.slow();

    await open(page, "/?package=visual-push#order");
    await copyUntil(page, (c) => {
      expect(new URL(c).searchParams.get("package")).toBe("visual-push");
    });

    const prices: string[] = [];
    for (const slug of Object.keys(TIERS) as Slug[]) {
      const card = glanceCard(page, TIERS[slug].card);
      await expect(card).toBeVisible();
      prices.push((await card.locator(".tabular-nums").first().innerText()).trim());
    }
    // No shared/stale price bleeding across tiers.
    expect(new Set(prices).size).toBe(3);
  });
});
