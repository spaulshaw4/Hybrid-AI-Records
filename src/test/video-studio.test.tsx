import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoStudio } from "@/components/VideoStudio";
import { scenesFromVision } from "@/lib/cinematic-script-director";
import { videoStudioGate } from "@/lib/video-studio";

function renderStudio(
  overrides: Partial<{
    audioName: string | null;
    characterPreview: string | null;
    vision: string;
    autoWrite: boolean;
    onGenerate: () => void;
    onAutoWrite: (value: boolean) => void;
    onMasterFile: (file: File | null) => void;
    onCharacterImage: (file: File | null) => void;
  }> = {},
) {
  return render(
    <VideoStudio
      audioName={overrides.audioName ?? null}
      characterPreview={overrides.characterPreview ?? null}
      vision={overrides.vision ?? ""}
      autoWrite={overrides.autoWrite ?? true}
      busy={false}
      status={null}
      exportUrl={null}
      exportName="hybrid-music-video.mp4"
      onMasterFile={overrides.onMasterFile ?? vi.fn()}
      onCharacterImage={overrides.onCharacterImage ?? vi.fn()}
      onVision={vi.fn()}
      onAutoWrite={overrides.onAutoWrite ?? vi.fn()}
      onGenerate={overrides.onGenerate ?? vi.fn()}
    />,
  );
}

describe("video studio canvas", () => {
  it("shows the track, the star, and the script on one screen", () => {
    renderStudio();
    expect(
      screen.getByRole("heading", { name: /HYBRID AI RECORDS\s+│\s+VIDEO ENGINE/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /1\. The Track/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /2\. The Star/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /3\. The Script \/ Vision/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/The Script & Vision/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Auto-Write with Claude/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByText(/Nightcrooner|Roots Voice|Frontperson|Amapiano/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/vocal stem/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate Music Video/i })).toBeDisabled();
  });

  it("opens Generate once a track and a vision are present", () => {
    const onGenerate = vi.fn();
    renderStudio({
      audioName: "night-drive.mp3",
      vision: "Cyberpunk street race at night with heavy neon lighting",
      onGenerate,
    });
    const button = screen.getByRole("button", { name: /Generate Music Video/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it("shows a large preview after a character photo is dropped", () => {
    const onCharacterImage = vi.fn();
    const { rerender } = render(
      <VideoStudio
        audioName={null}
        characterPreview={null}
        vision=""
        autoWrite
        busy={false}
        status={null}
        exportUrl={null}
        exportName="hybrid-music-video.mp4"
        onMasterFile={vi.fn()}
        onCharacterImage={onCharacterImage}
        onVision={vi.fn()}
        onAutoWrite={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    const photo = new File(["face"], "star.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Drop character photo here/i), {
      target: { files: [photo] },
    });
    expect(onCharacterImage).toHaveBeenCalledWith(photo);
    rerender(
      <VideoStudio
        audioName={null}
        characterPreview="data:image/png;base64,iVBORw0KGgo="
        vision=""
        autoWrite
        busy={false}
        status={null}
        exportUrl={null}
        exportName="hybrid-music-video.mp4"
        onMasterFile={vi.fn()}
        onCharacterImage={onCharacterImage}
        onVision={vi.fn()}
        onAutoWrite={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    const preview = screen.getByRole("img", { name: /Character preview/i });
    expect(preview).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(preview.className).toContain("object-contain");
  });

  it("lets Auto-Write with Claude be turned off", () => {
    const onAutoWrite = vi.fn();
    renderStudio({ onAutoWrite });
    fireEvent.click(screen.getByRole("button", { name: /Auto-Write with Claude/i }));
    expect(onAutoWrite).toHaveBeenCalledWith(false);
  });
});

describe("vision gate", () => {
  it("asks for a track and a description, and never a persona", () => {
    expect(videoStudioGate({ hasAudio: false, vision: "a night drive" }).ok).toBe(false);
    expect(videoStudioGate({ hasAudio: true, vision: "short" }).ok).toBe(false);
    expect(videoStudioGate({ hasAudio: true, vision: "a night drive through neon" }).ok).toBe(true);
  });

  it("turns a pasted script into scenes without calling Claude", () => {
    const scenes = scenesFromVision(
      "They sing in a red room. The camera stays wide on the street.",
      12,
      true,
    );
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.some((scene) => scene.vocalSync)).toBe(true);
    expect(scenes.every((scene) => scene.stillPrompt.length > 0)).toBe(true);
  });
});
