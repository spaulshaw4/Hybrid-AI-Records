export async function uploadDirectToS3(
  uploadUrl: string,
  file: Blob,
  customHeaders: Record<string, string> = {},
  contentType?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": contentType || (file instanceof File ? file.type : "") || "application/octet-stream",
    ...customHeaders,
  };
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: file,
  });
  if (!response.ok) {
    throw new Error(`Direct storage upload failed with status ${response.status}`);
  }
}
