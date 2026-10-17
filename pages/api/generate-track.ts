// Unused Next.js route. The Vite server does not mount this file.
// Token spend lives in src/app/api/generate/route.ts and uses the session user id.

export default async function handler(
  _req: { method?: string },
  res: { status: (code: number) => { json: (body: unknown) => void } },
) {
  res.status(410).json({
    error: "This route does not debit tokens. Use the studio generate API.",
  });
}
