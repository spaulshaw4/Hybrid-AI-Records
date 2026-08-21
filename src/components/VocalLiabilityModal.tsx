import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  VOCAL_CONSENT_MODAL_CHECK_ID,
  VOCAL_LIABILITY_CHECKBOX_LABEL,
  VOCAL_LIABILITY_MODAL_BODY,
  VOCAL_LIABILITY_MODAL_TITLE,
  writeStoredVocalConsent,
} from "@/lib/vocal-consent";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccepted: () => void;
};

export function VocalLiabilityModal({ open, onOpenChange, onAccepted }: Props) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{VOCAL_LIABILITY_MODAL_TITLE}</AlertDialogTitle>
          <AlertDialogDescription className="text-start leading-relaxed">
            {VOCAL_LIABILITY_MODAL_BODY}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <label
          htmlFor={VOCAL_CONSENT_MODAL_CHECK_ID}
          className="flex cursor-pointer items-start gap-3 rounded-md border border-border-strong bg-muted/20 px-3 py-3"
        >
          <Checkbox
            id={VOCAL_CONSENT_MODAL_CHECK_ID}
            checked={checked}
            onCheckedChange={(value) => setChecked(value === true)}
            className="mt-0.5"
          />
          <span className="text-sm font-medium leading-snug text-foreground">
            {VOCAL_LIABILITY_CHECKBOX_LABEL}
          </span>
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            type="button"
            disabled={!checked}
            onClick={() => {
              writeStoredVocalConsent(true);
              onAccepted();
              onOpenChange(false);
            }}
          >
            Continue
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
