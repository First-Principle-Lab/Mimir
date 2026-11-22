interface ReplyMessage {
  id: string;
  role: string;
  clientMessageId?: string | null;
  parentMessageId?: string | null;
  replyToMessageIds?: string[];
}

// Correlate replies to the submitted input: an older assistant message must
// never clear the loader while the current turn is still queued.
export function findReply<T extends ReplyMessage>(
  messages: T[],
  clientMessageId: string,
): T | undefined {
  const input = messages.find(
    (m) => m.role === "user" && m.clientMessageId === clientMessageId,
  );
  return input
    ? messages.find(
        (m) =>
          m.role === "assistant" &&
          (m.parentMessageId === input.id ||
            m.replyToMessageIds?.includes(input.id)),
      )
    : undefined;
}

// Polling can arrive before the reply transaction commits. Keep its streamed
// text until durable history contains the matching reply, then replace it.
export function preservePendingStreams<T extends { id: string }>(
  history: T[],
  previous: T[],
  completedInputs: ReadonlySet<string>,
): T[] {
  return [
    ...history,
    ...previous.filter(
      (message) =>
        message.id.startsWith("stream-") &&
        !completedInputs.has(message.id.slice(7)),
    ),
  ];
}
