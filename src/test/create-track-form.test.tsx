import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { TrackGeneratorStatus } from "@/hooks/useTrackGenerator";

const { hook } = vi.hoisted(() => ({
  hook: {
    generateTrack: vi.fn(),
    status: "idle" as TrackGeneratorStatus,
    sessionId: null as string | null,
    error: null as string | null,
    audioUrl: null as string | null,
  },
}));

vi.mock("@/hooks/useTrackGenerator", () => ({
  useTrackGenerator: () => hook,
}));

import { CreateTrackForm } from "@/components/CreateTrackForm";

async function violationsIn(container: HTMLElement) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.html) }));
}

describe("CreateTrackForm retry control", () => {
  beforeEach(() => {
    hook.generateTrack.mockReset();
    hook.status = "idle";
    hook.sessionId = null;
    hook.error = null;
    hook.audioUrl = null;
  });

  it("names the retry control and alerts the failure without nesting interactives", async () => {
    hook.status = "failed";
    hook.error = "Headless API is not reachable at 127.0.0.1:8000.";
    hook.sessionId = "sess-1";

    const { container } = render(<CreateTrackForm />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Headless API is not reachable at 127.0.0.1:8000.");

    const retry = screen.getByRole("button", { name: "Retry generation" });
    expect(retry).toHaveAttribute("aria-label", "Retry generation");
    expect(retry).toHaveTextContent("Retry generation");
    expect(alert.contains(retry)).toBe(false);
    expect(retry.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(await violationsIn(container)).toEqual([]);
  });

  it("retries with the current prompt instead of submitting a new form", async () => {
    hook.status = "failed";
    hook.error = "Generation failed.";
    const user = userEvent.setup();
    render(<CreateTrackForm />);

    await user.type(screen.getByLabelText("Prompt"), "night drive synthwave");
    await user.click(screen.getByRole("button", { name: "Retry generation" }));

    expect(hook.generateTrack).toHaveBeenCalledWith("night drive synthwave", "");
  });
});
