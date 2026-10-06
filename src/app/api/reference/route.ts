const UPLOAD_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/create-upload-id";
const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "Audio file is required" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: "Audio file must be 15MB or smaller" }, { status: 400 });
    }

    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "Missing WaveSpeed API key" }, { status: 500 });
    }

    const filename = file instanceof File && file.name ? file.name : "audio";
    const body = new FormData();
    body.append("file", file, filename);
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
    });
    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      data?: { upload_id?: string };
    };
    if (!res.ok || !data.data?.upload_id) {
      return Response.json({ error: data.message || "Failed to create reference ID" }, { status: 500 });
    }

    return Response.json({
      success: true,
      referenceId: data.data.upload_id,
      filename,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
