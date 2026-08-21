/**
 * Producer identity lock.
 *
 * Every script asset, prompt set, log line and metadata tag must carry the
 * owner's real identity. The prompt layer is never allowed to invent a
 * placeholder producer/artist alias (e.g. "Vance Rider") in its place.
 */

export const PRODUCER_NAME = "Stephen Paul Shaw";
export const PRODUCER_LABEL = "Hybrid AI Records LLC";

/** Metadata tags attached to every generated master and script asset. */
export function producerMetadataTags(): Record<string, string> {
  return {
    artist: PRODUCER_NAME,
    author: PRODUCER_NAME,
    creator: PRODUCER_NAME,
    producer: PRODUCER_NAME,
    publisher: PRODUCER_LABEL,
    copyright: `© ${new Date().getUTCFullYear()} ${PRODUCER_NAME} / ${PRODUCER_LABEL}`,
  };
}

/** Fields merged into structured server logs so runs are attributable. */
export function producerLogFields(): Record<string, string> {
  return { producer: PRODUCER_NAME, label: PRODUCER_LABEL };
}

/**
 * Hard directive injected into every orchestration prompt: the model must use
 * the real identity and must never fabricate a stand-in name for the producer.
 */
export function producerIdentityDirective(): string {
  return (
    `IDENTITY LOCK (non-negotiable): the producer, writer and rights owner of this work is ` +
    `${PRODUCER_NAME}, releasing through ${PRODUCER_LABEL}. Whenever a producer, artist, ` +
    `narrator, credit line, slate, on-screen text, file name or metadata tag needs a name, ` +
    `use "${PRODUCER_NAME}" verbatim. Never substitute, shorten, stylise or invent a ` +
    `placeholder alias (such as "Vance Rider", "John Doe" or any made-up stage name). If a ` +
    `named lead character is supplied separately, keep that character's name for the ` +
    `on-screen subject only — the credited human identity stays ${PRODUCER_NAME}.`
  );
}
