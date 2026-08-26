import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Music4, Radio, CheckCircle2, Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { submitStudioRequest, getStudioRequestStatus } from "@/lib/studio-queue.functions";

const STORAGE_KEY = "har-studio-ticket";

type Ticket = { reference: string; email: string };

type StatusView = Awaited<ReturnType<typeof getStudioRequestStatus>> | null;

const STATUS_COPY: Record<string, { label: string; detail: string }> = {
  queued: {
    label: "Track in Queue — Hybrid Engine 1.0 Alpha",
    detail: "Your session is locked in. Our engine and engineers are working through the queue in order.",
  },
  in_production: {
    label: "In Production — Hybrid Engine 1.0 Alpha",
    detail: "Your track is being composed and mixed right now. You'll see the master here as soon as it clears review.",
  },
  delivered: {
    label: "Delivered — Hybrid Engine 1.0 Alpha",
    detail: "Your master is ready. Stream or download it below.",
  },
};

export function StudioQueue() {
  const submit = useServerFn(submitStudioRequest);
  const getStatus = useServerFn(getStudioRequestStatus);

  const [artist, setArtist] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [style, setStyle] = useState("");
  const [brief, setBrief] = useState("");
  const [instrumental, setInstrumental] = useState(false);

  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [view, setView] = useState<StatusView>(null);

  const [lookupRef, setLookupRef] = useState("");
  const [lookupEmail, setLookupEmail] = useState("");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setTicket(JSON.parse(raw) as Ticket);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!ticket) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getStatus({ data: ticket });
        if (!cancelled) setView(result);
      } catch {
        /* ignore transient */
      }
    };
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ticket, getStatus]);

  async function handleSubmit() {
    if (brief.trim().length < 10) {
      toast.error("Tell us a bit more about the track first.");
      return;
    }
    setBusy(true);
    try {
      const { reference } = await submit({
        data: {
          artist: artist.trim(),
          email: email.trim(),
          title: title.trim(),
          style: style.trim(),
          brief: brief.trim(),
          instrumental,
        },
      });
      const next = { reference, email: email.trim() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setTicket(next);
      toast.success("Track placed in the Hybrid Engine 1.0 Alpha queue.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not submit your track.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLookup() {
    setBusy(true);
    try {
      const next = { reference: lookupRef.trim().toUpperCase(), email: lookupEmail.trim() };
      const result = await getStatus({ data: next });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setTicket(next);
      setView(result);
    } catch {
      toast.error("Could not look up that session.");
    } finally {
      setBusy(false);
    }
  }

  function startNew() {
    localStorage.removeItem(STORAGE_KEY);
    setTicket(null);
    setView(null);
  }

  if (ticket && view?.ok) {
    const copy = STATUS_COPY[view.status] ?? STATUS_COPY['queued']!;
    return (
      <Card className="border-border/60 bg-card/70 backdrop-blur">
        <CardHeader>
          <Badge className="w-fit border border-primary/30 bg-primary/15 text-primary">
            <Radio className="mr-1 size-3" aria-hidden /> Hybrid Engine 1.0 Alpha
          </Badge>
          <CardTitle className="mt-3 text-2xl md:text-3xl">{copy.label}</CardTitle>
          <CardDescription>{copy.detail}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <dl className="grid gap-3 rounded-xl border border-border/60 bg-background/60 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Reference</dt>
              <dd className="font-mono font-semibold">{view.reference}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Artist</dt>
              <dd className="font-semibold">{view.artist}</dd>
            </div>
            {view.title ? (
              <div>
                <dt className="text-muted-foreground">Working title</dt>
                <dd className="font-semibold">{view.title}</dd>
              </div>
            ) : null}
            {view.style ? (
              <div>
                <dt className="text-muted-foreground">Direction</dt>
                <dd className="font-semibold">{view.style}</dd>
              </div>
            ) : null}
          </dl>

          {view.note ? (
            <p className="rounded-lg border border-border/60 bg-background/50 p-4 text-sm text-muted-foreground">
              {view.note}
            </p>
          ) : null}

          {view.audioUrl ? (
            <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-primary">
                <CheckCircle2 className="size-4" aria-hidden /> Your master is ready
              </p>
              <audio controls preload="none" src={view.audioUrl} className="w-full" />
              <Button asChild variant="outline" size="sm" className="w-full">
                <a href={view.audioUrl} download target="_blank" rel="noreferrer">
                  <Download className="mr-2 size-4" aria-hidden /> Download master
                </a>
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This page refreshes automatically. Keep your reference code — you can return any time with
              your reference and email.
            </p>
          )}

          <Button variant="ghost" size="sm" onClick={startNew}>
            Submit another track
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="border-border/60 bg-card/70 backdrop-blur">
        <CardHeader>
          <Badge className="w-fit border border-primary/30 bg-primary/15 text-primary">
            <Radio className="mr-1 size-3" aria-hidden /> Hybrid Engine 1.0 Alpha
          </Badge>
          <CardTitle className="mt-3 text-2xl md:text-3xl">Submit your track</CardTitle>
          <CardDescription>
            Give us the concept. Our engine and engineers build the record, and you track its progress right
            here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="studio-artist">Artist name</Label>
              <Input
                id="studio-artist"
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                placeholder="Sage Zimba"
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="studio-email">Email</Label>
              <Input
                id="studio-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="studio-title">Working title</Label>
              <Input
                id="studio-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Raw Words"
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="studio-style">Style / genre</Label>
              <Input
                id="studio-style"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="dark trap, cinematic strings, 140bpm"
                maxLength={200}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="studio-brief">Lyrics or concept</Label>
            <Textarea
              id="studio-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={7}
              maxLength={3000}
              placeholder="Write the lyrics, or describe the mood, story and arrangement you want."
            />
            <p className="text-xs text-muted-foreground">{brief.length}/3000</p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3">
            <div>
              <Label htmlFor="studio-instrumental" className="cursor-pointer">
                Instrumental only
              </Label>
              <p className="text-xs text-muted-foreground">No vocals — beat and arrangement only.</p>
            </div>
            <Switch id="studio-instrumental" checked={instrumental} onCheckedChange={setInstrumental} />
          </div>

          <Button size="lg" className="w-full" onClick={handleSubmit} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> Placing in queue…
              </>
            ) : (
              <>
                <Music4 className="mr-2 size-4" aria-hidden /> Send to the Hybrid Engine 1.0 Alpha
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-border/60 bg-card/50">
        <CardHeader>
          <CardTitle className="text-lg">Already submitted?</CardTitle>
          <CardDescription>Check your session status with your reference code and email.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            aria-label="Reference code"
            value={lookupRef}
            onChange={(e) => setLookupRef(e.target.value)}
            placeholder="HAR-XXXX-XXXX"
          />
          <Input
            aria-label="Email"
            type="email"
            value={lookupEmail}
            onChange={(e) => setLookupEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Button variant="outline" onClick={handleLookup} disabled={busy}>
            Check status
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default StudioQueue;
