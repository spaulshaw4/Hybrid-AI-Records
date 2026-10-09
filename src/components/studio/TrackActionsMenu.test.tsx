import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrackActionsMenu } from "./TrackActionsMenu";

const MP3 = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/night.mp3";
const WAV = "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/night.wav";
const WAV_UNAVAILABLE = "WAV master is currently processing or unavailable for this take.";

function installMenuPolyfills() {
  const proto = HTMLElement.prototype;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => undefined;
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
  if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;
}

function captureAnchors() {
  const anchors: HTMLAnchorElement[] = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    const element = realCreate(tagName);
    if (tagName.toLowerCase() === "a") {
      element.click = () => undefined;
      anchors.push(element as HTMLAnchorElement);
    }
    return element;
  });
  return anchors;
}

describe("TrackActionsMenu", () => {
  beforeEach(() => {
    installMenuPolyfills();
    vi.restoreAllMocks();
  });

  it("opens download and delete only, with no reference or injection", async () => {
    const user = userEvent.setup();
    render(<TrackActionsMenu title="Night Drive" mp3Url={MP3} wavUrl={WAV} onDelete={vi.fn()} />);

    const options = screen.getByRole("button", { name: "Track options" });
    expect(options).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: "Use as Reference Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Track Injection (Swap)" })).not.toBeInTheDocument();

    await user.click(options);

    expect(options).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("menuitem", { name: "Use as Reference Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Track Injection (Swap)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Download Master" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download MP3" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Download WAV" })).toBeEnabled();
    const remove = screen.getByRole("menuitem", { name: "Delete from Vault" });
    expect(remove).toBeEnabled();
    expect(remove.className).toContain("text-rose-300");
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("disables Download MP3 when neither url is https", async () => {
    const user = userEvent.setup();
    render(<TrackActionsMenu title="Night Drive" mp3Url={null} wavUrl="" onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Track options" }));
    expect(screen.queryByRole("menuitem", { name: "Use as Reference Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Track Injection (Swap)" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download MP3" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Download WAV" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Delete from Vault" })).toBeEnabled();
  });

  it("forces an mp3 download with Supabase's download query", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const anchors = captureAnchors();
    const locationBefore = window.location.href;

    render(
      <TrackActionsMenu
        title="Night Drive"
        mp3Url={`${MP3}?token=abc`}
        wavUrl={WAV}
        onDelete={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Download MP3" }));

    const filename = encodeURIComponent("Night_Drive.mp3");
    expect(anchors[0]?.getAttribute("href")).toContain(`download=${filename}`);
    expect(anchors[0]?.getAttribute("href")).toContain("Night_Drive.mp3");
    expect(anchors[0]?.getAttribute("href")).toContain(`${MP3}?token=abc&download=`);
    expect(anchors[0]?.hasAttribute("download")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBe(locationBefore);
    vi.unstubAllGlobals();
  });

  it("falls back to an https wav for the mp3 item when mp3_url is empty", async () => {
    const user = userEvent.setup();
    const anchors = captureAnchors();

    render(<TrackActionsMenu title="Night Drive" mp3Url="" wavUrl={WAV} onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Download MP3" }));

    expect(anchors[0]?.getAttribute("href")).toBe(`${WAV}?download=${encodeURIComponent("Night_Drive.mp3")}`);
  });

  it("downloads a distinct https wav without leaving the page", async () => {
    const user = userEvent.setup();
    const anchors = captureAnchors();
    const locationBefore = window.location.href;

    render(<TrackActionsMenu title="Night Drive" mp3Url={MP3} wavUrl={WAV} onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Download WAV" }));

    expect(anchors[0]?.getAttribute("href")).toBe(`${WAV}?download=${encodeURIComponent("Night_Drive.wav")}`);
    expect(anchors[0]?.hasAttribute("download")).toBe(false);
    expect(window.location.href).toBe(locationBefore);
  });

  it("alerts instead of downloading a fake wav when mp3 and wav urls match", async () => {
    const user = userEvent.setup();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const anchors = captureAnchors();
    const locationBefore = window.location.href;

    render(<TrackActionsMenu title="Night Drive" mp3Url={MP3} wavUrl={MP3} onDelete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Download WAV" }));

    expect(alertSpy).toHaveBeenCalledWith(WAV_UNAVAILABLE);
    expect(anchors).toHaveLength(0);
    expect(window.location.href).toBe(locationBefore);
  });

  it("calls onDelete from Delete from Vault and closes on an outside click", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <div>
        <button type="button">Outside</button>
        <TrackActionsMenu title="Night Drive" mp3Url={null} wavUrl={null} onDelete={onDelete} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Track options" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Track options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete from Vault" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
