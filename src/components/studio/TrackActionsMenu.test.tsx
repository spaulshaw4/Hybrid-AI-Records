import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrackActionsMenu } from "./TrackActionsMenu";

const MP3 = "Download MP3 (320 kbps)";
const WAV = "Download Master WAV";

describe("TrackActionsMenu", () => {
  it("opens from the options button and shows both download actions", async () => {
    const user = userEvent.setup();
    render(
      <TrackActionsMenu
        trackId="track-9"
        title="Night Drive"
        mp3Url="/masters/night.mp3"
        wavUrl="/masters/night.wav"
        onDelete={vi.fn()}
      />,
    );

    const options = screen.getByRole("button", { name: "Actions for Night Drive" });
    expect(options).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: MP3 })).not.toBeInTheDocument();

    await user.click(options);

    expect(options).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: MP3 })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: WAV })).toBeEnabled();
  });

  it("disables a download when that url is missing", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TrackActionsMenu
        trackId="track-9"
        title="Night Drive"
        mp3Url={null}
        wavUrl="/masters/night.wav"
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Night Drive" }));
    expect(screen.getByRole("menuitem", { name: MP3 })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: WAV })).toBeEnabled();

    rerender(
      <TrackActionsMenu
        trackId="track-9"
        title="Night Drive"
        mp3Url="/masters/night.mp3"
        wavUrl={null}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole("menuitem", { name: MP3 })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: WAV })).toBeDisabled();
  });

  it("calls onDelete with the track id from the vault delete action", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <TrackActionsMenu
        trackId="track-9"
        title="Night Drive"
        mp3Url={null}
        wavUrl={null}
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Night Drive" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("track-9");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
