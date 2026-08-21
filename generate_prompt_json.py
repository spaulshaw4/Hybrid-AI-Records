import itertools
import json


def build_prompt_json(output_filename="Prompt_Master_Database.json", target_count=500):
    camera_moves = [
        "Slow-motion low-angle tracking shot",
        "Extreme close-up macro push-in",
        "Wide-angle sweeping drone shot",
        "Handheld dynamic 360-degree orbit",
        "Steadicam lateral glide",
        "High-angle dramatic crane down",
        "Static medium shot with subtle micro-shake",
        "Snap-zoom low-angle hero framing",
    ]

    subjects = [
        "weathered lead vocalist with dark Stetson and distressed leather",
        "intense performer gripping a vintage chrome stand microphone",
        "lone outlaw leaning against an idling vintage truck",
        "guitarist tearing through an emotional solo under blinding backlights",
        "shadowy figure clutching a tarnished brass pocket watch",
        "street performer executing sharp rhythmic steps",
        "performer in worn denim sitting on a rustic wooden porch",
    ]

    environments = [
        "inside a smoke-filled, wood-paneled roadhouse backroom",
        "along a cracked, empty desert highway at twilight",
        "in an abandoned brutalist industrial warehouse",
        "under flickering roadside sodium-vapor streetlamps",
        "on a rain-slicked asphalt crossroad surrounded by drifting fog",
        "inside an intimate stage venue with glowing tube amplifiers",
    ]

    lighting_styles = [
        "pierced by warm amber tungsten and deep chiaroscuro shadows",
        "illuminated by blinding overhead white strobes and pyrotechnic flares",
        "bathed in golden hour sunlight with heavy atmospheric haze",
        "lit by moody indigo rim lights and flickering warm lanterns",
        "framed in high-contrast silhouette with glowing cherry-red amp tubes",
        "under saturated purple twilight skies and long stretching shadows",
    ]

    cinematics = [
        "cinematic 35mm film grain, hyper-detailed textures, 8k resolution, Photorealistic.",
        "raw 16mm gritty aesthetic, anamorphic lens flare, motion blur, 4k render.",
        "Arri Alexa cinematic lighting, shallow depth of field, ultra-sharp focus, volumetric fog.",
    ]

    records = []
    combinations = itertools.product(camera_moves, subjects, environments, lighting_styles, cinematics)

    for count, (cam, subj, env, light, cine) in enumerate(combinations, start=1):
        if count > target_count:
            break
        records.append(
            {
                "id": count,
                "prompt_id": f"PROMPT #{count:04d}",
                "camera_move": cam,
                "subject": subj,
                "environment": env,
                "lighting": light,
                "render": cine,
                "prompt": f"Visual: {cam} of {subj}, {env}. Lighting & Render: {light}, {cine}",
            }
        )

    with open(output_filename, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)

    print(f"Successfully generated '{output_filename}' with {len(records)} structured prompts.")


if __name__ == "__main__":
    build_prompt_json(target_count=500)
