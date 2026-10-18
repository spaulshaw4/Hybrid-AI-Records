import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoStudio } from "@/components/VideoStudio";
import { scenesFromManualShots } from "@/lib/cinematic-script-director";
import { scriptSlotsFromSections, videoStudioGate, type ScriptSlot } from "@/lib/video-studio";

const SLOTS: ScriptSlot[] = [
  { label: "Intro", start: 0, end: 15 },
  { label: "Verse", start: 15, end: 30 },
  { label: "Chorus", start: 30, end: 45 },
];

function renderStudio(
  overrides: Partial<{
    audioName: string | null;
    characterPreview: string | null;
    vision: string;
    scriptMode: "auto" | "manual";
    slots: ScriptSlot[];
    shotNotes: string[];
    onGenerate: () => void;
    onScriptMode: (mode: "auto" | "manual") => void;
    onShotNote: (index: number, value: string) => void;
    onMasterFile: (file: File | null) => void;
    onCharacterImage: (file: File | null) => void;
  }> = {},
) {
  return render(
    <VideoStudio
      audioName={overrides.audioName ?? null}
      characterPreview={overrides.characterPreview ?? null}
      vision={overrides.vision ?? ""}
      scriptMode={overrides.scriptMode ?? "auto"}
      slots={overrides.slots ?? []}
      shotNotes={overrides.shotNotes ?? []}
      busy={false}
      status={null}
      exportUrl={null}
      exportName="hybrid-music-video.mp4"
      onMasterFile={overrides.onMasterFile ?? vi.fn()}
      onCharacterImage={overrides.onCharacterImage ?? vi.fn()}
      onVision={vi.fn()}
      onScriptMode={overrides.onScriptMode ?? vi.fn()}
      onShotNote={overrides.onShotNote ?? vi.fn()}
      onGenerate={overrides.onGenerate ?? vi.fn()}
    />,
  );
}

describe("video studio canvas", () => {
  it("starts in Auto and hides the scene list", () => {
    renderStudio();
    expect(
      screen.getByRole("heading", { name: /HYBRID AI RECORDS\s+│\s+VIDEO ENGINE/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Auto-Direct \(Claude\)/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Manual Scene-by-Scene/i })).not.toBeChecked();
    expect(screen.getByLabelText(/Describe your video concept/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Scene 1/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Nightcrooner|Roots Voice|Frontperson|Amapiano/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/vocal stem/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate Music Video/i })).toBeDisabled();
  });

  it("opens Generate from one concept sentence", () => {
    const onGenerate = vi.fn();
    renderStudio({
      audioName: "night-drive.mp3",
      vision: "Moody neon city night drive, heavy rain, dramatic performance",
      onGenerate,
    });
    const button = screen.getByRole("button", { name: /Generate Music Video/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it("opens the section list only after Manual is selected", () => {
    const onScriptMode = vi.fn();
    const { rerender } = renderStudio({ onScriptMode, audioName: "night-drive.mp3", slots: SLOTS });
    expect(screen.queryByLabelText(/Scene 1 Intro/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Manual Scene-by-Scene/i }));
    expect(onScriptMode).toHaveBeenCalledWith("manual");
    rerender(
      <VideoStudio
        audioName="night-drive.mp3"
        characterPreview={null}
        vision=""
        scriptMode="manual"
        slots={SLOTS}
        shotNotes={["", "", ""]}
        busy={false}
        status={null}
        exportUrl={null}
        exportName="hybrid-music-video.mp4"
        onMasterFile={vi.fn()}
        onCharacterImage={vi.fn()}
        onVision={vi.fn()}
        onScriptMode={onScriptMode}
        onShotNote={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/Describe your video concept/i)).not.toBeInTheDocument();
    expect(screen.getByText(/0:00–0:15/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Scene 1 Intro/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Scene 3 Chorus/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate Music Video/i })).toBeDisabled();
  });

  it("enables Generate in Manual once every section is described", () => {
    renderStudio({
      audioName: "night-drive.mp3",
      scriptMode: "manual",
      slots: SLOTS,
      shotNotes: ["Close-up performance", "Walking through the alley", "Singer on the roof"],
    });
    expect(screen.getByRole("button", { name: /Generate Music Video/i })).toBeEnabled();
  });

  it("shows a large preview after a character photo is dropped", () => {
    const onCharacterImage = vi.fn();
    const { rerender } = renderStudio({ onCharacterImage });
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
        scriptMode="auto"
        slots={[]}
        shotNotes={[]}
        busy={false}
        status={null}
        exportUrl={null}
        exportName="hybrid-music-video.mp4"
        onMasterFile={vi.fn()}
        onCharacterImage={onCharacterImage}
        onVision={vi.fn()}
        onScriptMode={vi.fn()}
        onShotNote={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );
    const preview = screen.getByRole("img", { name: /Character preview/i });
    expect(preview).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(preview.className).toContain("object-contain");
  });
});

describe("script slots", () => {
  it("keeps detected intro, verse, and chorus times", () => {
    const slots = scriptSlotsFromSections(
      [
        { label: "intro", start: 0, end: 12 },
        { label: "verse", start: 12, end: 24 },
        { label: "chorus", start: 24, end: 36 },
      ],
      36,
    );
    expect(slots.map((slot) => slot.label)).toEqual(["Intro", "Verse", "Chorus"]);
    expect(slots[2]).toMatchObject({ start: 24, end: 36 });
  });

  it("asks for a concept in Auto and a line for every section in Manual", () => {
    expect(videoStudioGate({ hasAudio: true, mode: "auto", vision: "short", shots: [] }).ok).toBe(
      false,
    );
    expect(
      videoStudioGate({
        hasAudio: true,
        mode: "auto",
        vision: "a night drive through neon",
        shots: [],
      }).ok,
    ).toBe(true);
    expect(
      videoStudioGate({ hasAudio: true, mode: "manual", vision: "", shots: ["", "alley"] }).ok,
    ).toBe(false);
    expect(
      videoStudioGate({
        hasAudio: true,
        mode: "manual",
        vision: "",
        shots: ["Close-up performance", "Walking through the alley"],
      }).ok,
    ).toBe(true);
  });

  it("uses each manual line as its own shot and skips Claude", () => {
    const scenes = scenesFromManualShots(
      [
        { label: "Intro", start: 0, end: 5, description: "They sing in a red room" },
        { label: "Chorus", start: 5, end: 17, description: "Wide shot of the street" },
      ],
      true,
    );
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toMatchObject({ title: "Intro", seconds: 5, vocalSync: true });
    expect(scenes[1]).toMatchObject({
      seconds: 10,
      vocalSync: false,
      shot: "Wide shot of the street",
    });
  });
});
