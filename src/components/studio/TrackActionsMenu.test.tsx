import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrackActionsMenu } from "./TrackActionsMenu";

const MP3 = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/night.mp3";

function installMenuPolyfills() {
  const proto = HTMLElement.prototype;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;
}

describe("TrackActionsMenu", () => {
  beforeEach(() => {
    installMenuPolyfills();
  });

  it("opens the four vault actions and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <TrackActionsMenu
        title="Night Drive"
        mp3Url={MP3}
        referenceUrl={MP3}
        onUseAsReference={vi.fn()}
        onTrackInjection={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const options = screen.getByRole("button", { name: "Track actions" });
    expect(options).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: "Use as Reference Track" })).not.toBeInTheDocument();

    await user.click(options);

    expect(options).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Use as Reference Track" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Track Injection (Swap)" })).toBeEnabled();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download Master" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Delete from Vault" })).toBeEnabled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("disables reference and download when those urls are missing", async () => {
    const user = userEvent.setup();
    render(
      <TrackActionsMenu
        title="Night Drive"
        mp3Url={null}
        referenceUrl={null}
        onUseAsReference={vi.fn()}
        onTrackInjection={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    expect(screen.getByRole("menuitem", { name: "Use as Reference Track" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Track Injection (Swap)" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Download Master" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Delete from Vault" })).toBeEnabled();
  });

  it("downloads the https mp3 using the track title as the filename", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["mp3"], { type: "audio/mpeg" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:master");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.fn();
    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = realCreate(tagName);
      if (tagName.toLowerCase() === "a") {
        element.click = click;
        anchors.push(element as HTMLAnchorElement);
      }
      return element;
    });

    render(
      <TrackActionsMenu
        title="Night Drive"
        mp3Url={MP3}
        referenceUrl={MP3}
        onUseAsReference={vi.fn()}
        onTrackInjection={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Download Master" }));

    expect(fetchMock).toHaveBeenCalledWith(MP3, { credentials: "omit" });
    expect(createObjectURL).toHaveBeenCalled();
    expect(anchors[0]).toHaveAttribute("download", "Night Drive.mp3");
    expect(click).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("calls onDelete from Delete from Vault and closes on an outside click", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <div>
        <button type="button">Outside</button>
        <TrackActionsMenu
          title="Night Drive"
          mp3Url={null}
          referenceUrl={null}
          onUseAsReference={vi.fn()}
          onTrackInjection={vi.fn()}
          onDelete={onDelete}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Track actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete from Vault" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
