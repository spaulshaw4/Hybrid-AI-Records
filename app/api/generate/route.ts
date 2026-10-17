// Unused Next.js route. The Vite server does not mount this file.
// Token spend lives in src/app/api/generate/route.ts and uses the session user id.

export async function POST() {
  return Response.json(
    { error: "This route does not debit tokens. Use the studio generate API." },
    { status: 410 },
  );
}
