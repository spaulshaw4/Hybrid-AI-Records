import json
from pathlib import Path

transcript = Path(
    r"C:\Users\spaul\.cursor\projects\c-Users-spaul-Downloads-Hybrid-AI-Forge-10\agent-transcripts\e6ae2c57-c255-45d1-9042-08d209d10932\e6ae2c57-c255-45d1-9042-08d209d10932.jsonl"
)
root = Path(r"C:\Users\spaul\Downloads\Hybrid AI Forge (10)")
out_dir = root / "scripts" / "_paste_extract"
out_dir.mkdir(parents=True, exist_ok=True)

wanted = {10853: "catalog.ts", 10856: "modal.tsx"}
found = {}
with transcript.open(encoding="utf-8") as handle:
    for index, line in enumerate(handle, 1):
        if index not in wanted:
            continue
        obj = json.loads(line)
        text = obj["message"]["content"][0]["text"]
        start = text.find("<user_query>")
        end = text.rfind("</user_query>")
        body = text[start + len("<user_query>") : end]
        if body.startswith("\n"):
            body = body[1:]
        if body.endswith("\n"):
            body = body[:-1]
        found[index] = body
        (out_dir / wanted[index]).write_text(body + "\n", encoding="utf-8")

catalog = found[10853]
print("catalog_chars", len(catalog))
print("id_count", catalog.count("\n    id:"))
print("ends_with", repr(catalog[-40:]))
print("has_old", "oklahoma-red-dirt" in catalog)
print("modal_chars", len(found[10856]))
