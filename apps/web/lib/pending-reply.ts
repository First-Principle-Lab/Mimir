interface ReplyMessage {
  id: string;
  role: string;
  clientMessageId?: string | null;
  parentMessageId?: string | null;
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
        (m) => m.role === "assistant" && m.parentMessageId === input.id,
      )
    : undefined;
}
