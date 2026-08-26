import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, Save, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  STUDIO_BUCKET,
  STUDIO_STATUSES,
  createStudioUploadTicket,
  listStudioRequests,
  updateStudioRequest,
  type StudioRequestRow,
  type StudioStatus,
} from "@/lib/studio-queue.functions";

const STATUS_LABEL: Record<StudioStatus, string> = {
  queued: "Queued",
  in_production: "In production",
  delivered: "Delivered",
};

export function StudioAdminQueue() {
  const list = useServerFn(listStudioRequests);
  const update = useServerFn(updateStudioRequest);
  const ticket = useServerFn(createStudioUploadTicket);

  const [rows, setRows] = useState<StudioRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingRef, setSavingRef] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<
    Record<string, { status: StudioStatus; deliveryUrl: string; deliveryNote: string; deliveryPath: string }>
  >({});

  async function refresh() {
    setLoading(true);
    try {
      const result = await list({ data: { status: "all" } });
      setRows(result.requests);
      setDrafts(
        Object.fromEntries(
          result.requests.map((row) => [
            row.reference,
            {
              status: row.status,
              deliveryUrl: row.deliveryUrl ?? "",
              deliveryNote: row.deliveryNote ?? "",
              deliveryPath: row.deliveryPath ?? "",
            },
          ]),
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the queue.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload(reference: string, file: File) {
    setSavingRef(reference);
    try {
      const slot = await ticket({ data: { reference, fileName: file.name } });
      const { error } = await supabase.storage
        .from(STUDIO_BUCKET)
        .uploadToSignedUrl(slot.path, slot.token, file);
      if (error) throw new Error(error.message);
      setDrafts((prev) => ({
        ...prev,
        [reference]: {
          ...prev[reference]!,
          deliveryPath: slot.path,
          status: "delivered",
        },
      }));
      toast.success("Master uploaded — save to release it to the client.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setSavingRef(null);
    }
  }

  async function handleSave(reference: string) {
    const draft = drafts[reference];
    if (!draft) return;
    setSavingRef(reference);
    try {
      await update({
        data: {
          reference,
          status: draft.status,
          deliveryUrl: draft.deliveryUrl.trim(),
          deliveryPath: draft.deliveryPath.trim(),
          deliveryNote: draft.deliveryNote.trim(),
        },
      });
      toast.success("Session updated.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSavingRef(null);
    }
  }

  return (
    <Card className="border-primary/30 bg-card/70 backdrop-blur">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <Badge variant="outline" className="border-primary/40 text-primary">
            Staff only
          </Badge>
          <CardTitle className="mt-3 text-xl">Hybrid Engine 1.0 Alpha review panel</CardTitle>
          <CardDescription>
            Upload or link the finished master for each session. Clients only ever see Hybrid AI Records
            branding.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="mr-2 size-4" aria-hidden /> Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading queue…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No client sessions yet.</p>
        ) : (
          rows.map((row) => {
            const draft = drafts[row.reference];
            if (!draft) return null;
            return (
              <div key={row.id} className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{row.reference}</span>
                  <Badge variant="outline">{STATUS_LABEL[row.status]}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {row.artist} · {row.email}
                  </span>
                </div>
                <p className="text-sm">
                  <span className="font-semibold">{row.title || "Untitled"}</span>
                  {row.style ? <span className="text-muted-foreground"> — {row.style}</span> : null}
                  {row.instrumental ? <span className="text-muted-foreground"> · instrumental</span> : null}
                </p>
                <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                  {row.brief}
                </p>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`status-${row.id}`}>Status</Label>
                    <Select
                      value={draft.status}
                      onValueChange={(value) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [row.reference]: { ...prev[row.reference]!, status: value as StudioStatus },
                        }))
                      }
                    >
                      <SelectTrigger id={`status-${row.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STUDIO_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            {STATUS_LABEL[status]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`url-${row.id}`}>Audio link (optional)</Label>
                    <Input
                      id={`url-${row.id}`}
                      value={draft.deliveryUrl}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [row.reference]: { ...prev[row.reference]!, deliveryUrl: e.target.value },
                        }))
                      }
                      placeholder="https://…/master.mp3"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`file-${row.id}`}>Upload master</Label>
                  <Input
                    id={`file-${row.id}`}
                    type="file"
                    accept="audio/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleUpload(row.reference, file);
                    }}
                  />
                  {draft.deliveryPath ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Upload className="size-3" aria-hidden /> {draft.deliveryPath}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`note-${row.id}`}>Client note</Label>
                  <Textarea
                    id={`note-${row.id}`}
                    rows={2}
                    value={draft.deliveryNote}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [row.reference]: { ...prev[row.reference]!, deliveryNote: e.target.value },
                      }))
                    }
                    placeholder="Shown on the client status screen."
                  />
                </div>

                <Button
                  size="sm"
                  onClick={() => void handleSave(row.reference)}
                  disabled={savingRef === row.reference}
                >
                  {savingRef === row.reference ? (
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  ) : (
                    <Save className="mr-2 size-4" aria-hidden />
                  )}
                  Save session
                </Button>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

export default StudioAdminQueue;
