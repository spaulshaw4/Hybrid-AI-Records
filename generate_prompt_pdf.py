import itertools

from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, KeepTogether, HRFlowable, PageBreak


def build_prompt_pdf(output_filename="Prompt_Master_Database.pdf", target_count=500):
    # Setup document geometry
    doc = SimpleDocTemplate(
        output_filename,
        pagesize=letter,
        rightMargin=40,
        leftMargin=40,
        topMargin=40,
        bottomMargin=40
    )

    styles = getSampleStyleSheet()

    # Custom styling
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontSize=22,
        leading=26,
        textColor=colors.HexColor('#1E293B'),
        spaceAfter=10
    )

    meta_style = ParagraphStyle(
        'MetaStyle',
        parent=styles['Normal'],
        fontSize=10,
        leading=14,
        textColor=colors.HexColor('#64748B'),
        spaceAfter=20
    )

    item_title_style = ParagraphStyle(
        'ItemTitle',
        parent=styles['Heading3'],
        fontSize=11,
        leading=14,
        textColor=colors.HexColor('#0F172A'),
        spaceAfter=3
    )

    prompt_body_style = ParagraphStyle(
        'PromptBody',
        parent=styles['Normal'],
        fontSize=9,
        leading=13,
        textColor=colors.HexColor('#334155')
    )

    # Modular prompt components
    camera_moves = [
        "Slow-motion low-angle tracking shot",
        "Extreme close-up macro push-in",
        "Wide-angle sweeping drone shot",
        "Handheld dynamic 360-degree orbit",
        "Steadicam lateral glide",
        "High-angle dramatic crane down",
        "Static medium shot with subtle micro-shake",
        "Snap-zoom low-angle hero framing"
    ]

    subjects = [
        "weathered lead vocalist with dark Stetson and distressed leather",
        "intense performer gripping a vintage chrome stand microphone",
        "lone outlaw leaning against an idling vintage truck",
        "guitarist tearing through an emotional solo under blinding backlights",
        "shadowy figure clutching a tarnished brass pocket watch",
        "street performer executing sharp rhythmic steps",
        "performer in worn denim sitting on a rustic wooden porch"
    ]

    environments = [
        "inside a smoke-filled, wood-paneled roadhouse backroom",
        "along a cracked, empty desert highway at twilight",
        "in an abandoned brutalist industrial warehouse",
        "under flickering roadside sodium-vapor streetlamps",
        "on a rain-slicked asphalt crossroad surrounded by drifting fog",
        "inside an intimate stage venue with glowing tube amplifiers"
    ]

    lighting_styles = [
        "pierced by warm amber tungsten and deep chiaroscuro shadows",
        "illuminated by blinding overhead white strobes and pyrotechnic flares",
        "bathed in golden hour sunlight with heavy atmospheric haze",
        "lit by moody indigo rim lights and flickering warm lanterns",
        "framed in high-contrast silhouette with glowing cherry-red amp tubes",
        "under saturated purple twilight skies and long stretching shadows"
    ]

    cinematics = [
        "cinematic 35mm film grain, hyper-detailed textures, 8k resolution, Photorealistic.",
        "raw 16mm gritty aesthetic, anamorphic lens flare, motion blur, 4k render.",
        "Arri Alexa cinematic lighting, shallow depth of field, ultra-sharp focus, volumetric fog."
    ]

    story = []

    # Generate Combinations up front so the cover can preview them
    combinations = []
    for cam, subj, env, light, cine in itertools.product(
        camera_moves, subjects, environments, lighting_styles, cinematics
    ):
        if len(combinations) >= target_count:
            break
        combinations.append((cam, subj, env, light, cine))

    def format_prompt(parts):
        cam, subj, env, light, cine = parts
        return f"<b>Visual:</b> {cam} of {subj}, {env}.<br/><b>Lighting &amp; Render:</b> {light}, {cine}"

    # ---- Cover page ----
    story.append(Paragraph("AI Video Generation: Master Prompt Index", title_style))
    story.append(Paragraph(
        "Structured prompt database for high-contrast music video pipelines, locked visual "
        "consistency, and cinematic lighting.", meta_style))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#CBD5E1'), spaceAfter=15))
    story.append(Paragraph(
        f"Total prompts: {len(combinations)} &nbsp;|&nbsp; Camera moves: {len(camera_moves)} &nbsp;|&nbsp; "
        f"Subjects: {len(subjects)} &nbsp;|&nbsp; Environments: {len(environments)} &nbsp;|&nbsp; "
        f"Lighting: {len(lighting_styles)} &nbsp;|&nbsp; Render styles: {len(cinematics)}", meta_style))
    story.append(Paragraph("Style preview — first 5 prompts", item_title_style))
    story.append(Spacer(1, 6))

    for idx, parts in enumerate(combinations[:5], start=1):
        story.append(KeepTogether([
            Paragraph(f"PROMPT #{idx:04d}", item_title_style),
            Paragraph(format_prompt(parts), prompt_body_style),
            Spacer(1, 8),
            HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#E2E8F0'), spaceAfter=8)
        ]))

    story.append(Spacer(1, 10))
    story.append(Paragraph(
        "Full index begins on the next page.", meta_style))
    story.append(PageBreak())

    # ---- Full index ----
    count = 0
    for parts in combinations:
        count += 1
        item_block = [
            Paragraph(f"PROMPT #{count:04d}", item_title_style),
            Paragraph(format_prompt(parts), prompt_body_style),
            Spacer(1, 8),
            HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#E2E8F0'), spaceAfter=8)
        ]
        story.append(KeepTogether(item_block))

    # Build the document
    doc.build(story)

    print(f"Successfully generated '{output_filename}' with {count} structured prompts.")


if __name__ == "__main__":
    # Adjust target_count to export as many prompts as needed (e.g. 500, 2000, 5000)
    build_prompt_pdf(target_count=500)
