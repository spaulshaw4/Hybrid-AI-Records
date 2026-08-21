export type CredentialStatus = {
  paidAiConfigured: boolean;
  freeAiConfigured: boolean;
  replicateConfigured: boolean;
};

function hasValue(name: string): boolean {
  const direct = process.env[name];
  if (direct?.trim()) return true;
  const wanted = name.toLowerCase();
  return Object.entries(process.env).some(
    ([key, value]) => key.toLowerCase() === wanted && Boolean(value?.trim()),
  );
}

export function readCredentialStatus(): CredentialStatus {
  return {
    // All text/script/prompt generation runs on the Replicate platform token.
    paidAiConfigured: hasValue("REPLICATE_API_TOKEN") || hasValue("REPLICATE_API_KEY"),
    freeAiConfigured: hasValue("REPLICATE_API_TOKEN") || hasValue("REPLICATE_API_KEY"),
    replicateConfigured: hasValue("REPLICATE_API_TOKEN") || hasValue("REPLICATE_API_KEY"),
  };
}
