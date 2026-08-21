import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSlackAlertPayload, sendSlackAlert, slackAlertConfigured } from "@/lib/slack-alert.server";

const VALID = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";

const original = process.env.SLACK_ALERT_WEBHOOK_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (original === undefined) delete process.env.SLACK_ALERT_WEBHOOK_URL;
  else process.env.SLACK_ALERT_WEBHOOK_URL = original;
});

describe("sendSlackAlert", () => {
  beforeEach(() => {
    delete process.env.SLACK_ALERT_WEBHOOK_URL;
  });

  it("is a no-op when the webhook env is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(slackAlertConfigured()).toBe(false);
    await sendSlackAlert("pipeline down");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-Slack URLs", async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = "https://example.com/services/steal";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(slackAlertConfigured()).toBe(false);
    await sendSlackAlert("should not send");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a formatted payload to a Slack incoming webhook", async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = VALID;
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const err = new Error("upstream 502");
    await sendSlackAlert("Hybrid Engine dispatch failed", err);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VALID);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { text: string };
    expect(body.text).toContain("System Alert");
    expect(body.text).toContain("Hybrid Engine dispatch failed");
    expect(body.text).toContain("upstream 502");
    expect(body.text).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("swallows dispatch failures so the caller is never blocked", async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = VALID;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendSlackAlert("still online")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("builds a payload without an error block when none is given", () => {
    const payload = buildSlackAlertPayload("monitoring pipeline is online");
    expect(payload.text).toContain("monitoring pipeline is online");
    expect(payload.text).not.toContain("Error Detail");
  });
});
