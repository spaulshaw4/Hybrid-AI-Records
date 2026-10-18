import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoStudio } from "@/components/VideoStudio";
import { hiddenStyleDirection } from "@/lib/video-studio";

const noop = () => undefined;

function studio(overrides: Partial<Parameters<typeof VideoStudio>[0]> = {}) {
  return render(
    <VideoStudio
      audioName={null}
      vocalName={null}
      mode="auto"
      personaId={null}
      styleId={null}
      customText=""
      lyrics=""
      characterImageName={null}
      busy={false}
      status={null}
      exportUrl={null}
      exportName="hybrid-music-video.mp4"
      onMasterFile={noop}
      onVocalFile={noop}
      onMode={noop}
      onPersona={noop}
      onStyle={noop}
      onCustomText={noop}
      onLyrics={noop}
      onCharacterImage={noop}
      onGenerate={noop}
      {...overrides}
    />,
  );
}

describe("video studio flow", () => {
  afterEach(() => cleanup());

  it("starts empty, with generate disabled and no character image", () => {
    studio();
    expect(
      screen.getByRole("heading", { name: "HYBRID AI RECORDS: VIDEO STUDIO" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Music Video" })).toBeDisabled();
    expect(screen.queryByLabelText("Character image")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Song lyrics")).toBeInTheDocument();
    expect(screen.queryByLabelText("Custom visual style")).not.toBeInTheDocument();
    expect(screen.queryByText(/flux|hailuo|seedance|replicate|wavespeed/i)).not.toBeInTheDocument();
  });

  it("keeps generate disabled without audio", () => {
    studio({ styleId: "amapiano", mode: "auto" });
    expect(screen.getByRole("button", { name: "Generate Music Video" })).toBeDisabled();
    expect(screen.getByText("Add a master track first.")).toBeInTheDocument();
  });

  it("does not ask for a character image in auto mode", () => {
    studio({ audioName: "song.wav", styleId: "bedroom-pop", mode: "auto" });
    expect(screen.queryByLabelText("Character image")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Music Video" })).toBeEnabled();
  });

  it("blocks generate in character mode until a character image is added", () => {
    studio({
      audioName: "song.mp3",
      mode: "character",
      personaId: "frontperson",
      styleId: "symphonic-rock",
      characterImageName: null,
    });
    expect(screen.getByLabelText("Character image")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate Music Video" })).toBeDisabled();
    expect(screen.getByText("Add a character image.")).toBeInTheDocument();
  });

  it("enables generate once character mode has a persona and an image", () => {
    const onGenerate = vi.fn();
    studio({
      audioName: "song.mp3",
      mode: "character",
      personaId: "frontperson",
      styleId: "roots-reggae",
      characterImageName: "face.png",
      onGenerate,
    });
    const button = screen.getByRole("button", { name: "Generate Music Video" });
    expect(button).toBeEnabled();
    button.click();
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it("shows one custom field and hides preset direction", () => {
    const { rerender } = studio({ styleId: "custom", audioName: "song.wav" });
    expect(screen.getByLabelText("Custom visual style")).toBeInTheDocument();
    expect(screen.queryByText(hiddenStyleDirection("amapiano", ""))).not.toBeInTheDocument();
    rerender(
      <VideoStudio
        audioName="song.wav"
        vocalName={null}
        mode="auto"
        personaId={null}
        styleId="amapiano"
        customText=""
        lyrics=""
        characterImageName={null}
        busy={false}
        status={null}
        exportUrl={null}
        exportName="hybrid-music-video.mp4"
        onMasterFile={noop}
        onVocalFile={noop}
        onMode={noop}
        onPersona={noop}
        onStyle={noop}
        onCustomText={noop}
        onLyrics={noop}
        onCharacterImage={noop}
        onGenerate={noop}
      />,
    );
    expect(screen.queryByLabelText("Custom visual style")).not.toBeInTheDocument();
    expect(screen.queryByText(/log-drum/i)).not.toBeInTheDocument();
  });
});
