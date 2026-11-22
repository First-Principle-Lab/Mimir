import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { openSession, type OpenSessionOptions } from "./pi-runtime.js";

// A worker owns one headless session per active conversation. Idle sessions
// are evicted immediately; the next turn hydrates Postgres again, including
// entries another worker might have written in the meantime.
export class SessionHost {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly opening = new Set<string>();

  async open(
    conversationId: string,
    options: OpenSessionOptions,
  ): Promise<AgentSession> {
    if (this.sessions.has(conversationId) || this.opening.has(conversationId))
      throw new Error("Conversation already has an active session");
    this.opening.add(conversationId);
    try {
      const session = await openSession(options);
      this.sessions.set(conversationId, session);
      return session;
    } finally {
      this.opening.delete(conversationId);
    }
  }

  async abort(conversationId: string): Promise<void> {
    await this.sessions.get(conversationId)?.abort();
  }

  evict(conversationId: string): void {
    this.sessions.get(conversationId)?.dispose();
    this.sessions.delete(conversationId);
  }
}
