import shutil
from pathlib import Path

root = Path(r"C:\Users\spaul\Downloads\Hybrid AI Forge (10)")
extract = root / "scripts" / "_paste_extract"
shutil.copyfile(extract / "catalog.ts", root / "src" / "data" / "murekaTemplates.ts")

modal = (extract / "modal.tsx").read_text(encoding="utf-8")
modal = modal.replace('"use client";\n', "", 1)
old_import = (
    'import React, { useState } from "react";\n'
    'import { MUREKA_CATEGORIES, MUREKA_TEMPLATES, TrackTemplate } from "@/data/murekaTemplates";\n'
)
new_import = (
    'import { useState } from "react";\n'
    'import { MUREKA_CATEGORIES, MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";\n'
)
if old_import not in modal:
    raise SystemExit("import block not found")
modal = modal.replace(old_import, new_import, 1)
if "export { TemplatesModal };" not in modal:
    modal = modal.rstrip() + "\n\nexport { TemplatesModal };\n"
(root / "src" / "components" / "studio" / "TemplatesModal.tsx").write_text(modal, encoding="utf-8")
print("ok")
