"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { useRouter } from "next/navigation";
import { Mic, ArrowUp, Plug } from "lucide-react";
import { io } from "socket.io-client";
import { SiteHeader } from "@/components/chat/site-header";
import { Spotlight } from "@/components/chat/spotlight";
import { MovingBorderButton } from "@/components/chat/moving-border-button";
import { Reveal, SignalDot } from "@/components/chat/motion";
import { ThreadBubbles } from "@/components/chat/thread-bubbles";
import { ConnectorsPanel } from "@/components/chat/connectors-panel";
import {
  GitHubIcon,
  GmailIcon,
  GoogleCalendarIcon,
  LinearIcon,
  NotionIcon,
} from "@/components/landing/brand-icons";
import type { ThreadMessage } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { maybeNotifyDesktop } from "@/lib/push";
import { findReply, preservePendingStreams } from "@/lib/pending-reply";

const API =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1";
const WS_URL = API.replace(/^http/, "ws").replace(/\/api\/v1$/, "");

// Roster icons for the connectors panel; unknown keys get a generic plug so the
// panel never renders without an icon for a new integration.
const ROSTER_ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  "google-mail": GmailIcon,
  googlecalendar: GoogleCalendarIcon,
  github: GitHubIcon,
  notion: NotionIcon,
  linear: LinearIcon,
};
const FALLBACK_ICON = Plug;

interface RosterRow {
  key: string;
  label: string;
  connected: boolean;
}

type View = "loading" | "chat";

interface EmailToolCall {
  type?: string;
  status?: string;
  draft?: { to?: string; subject?: string; body?: string };
}

interface ApiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolCalls?: EmailToolCall | null;
  clientMessageId?: string | null;
  parentMessageId?: string | null;
  replyToMessageIds?: string[];
}

interface Conversation {
  conversation: { id: string; messages: ApiMessage[] };
}

function formatAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function toThreadMessage(message: ApiMessage): ThreadMessage {
  return {
    id: message.id,
    speaker: message.role === "user" ? "you" : "mimir",
    text: message.content,
    at: message.createdAt ? formatAt(message.createdAt) : undefined,
    actionable:
      message.toolCalls?.type === "gmail.send_email" &&
      message.toolCalls.status === "pending",
    connectable:
      (message.toolCalls?.type === "gmail.connect" ||
        message.toolCalls?.type === "googlecalendar.connect") &&
      message.toolCalls.status === "pending",
  };
}

export default function ChatPage() {
  const [view, setView] = useState<View>("loading");
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterRow[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // The latest message we've already revealed. A refetch must not re-stream the
  // same last message (that's what made replies "reparse" on every refetch).
  const lastStreamedRef = useRef<string | null>(null);
  // Set right before post() awaits the reply, so only a reply that arrived in
  // THIS session gets the reveal animation. On a fresh page load the thread is
  // already rendered — re-streaming the last message there is exactly the
  // bug where a reload plays the whole reply again.
  const pendingReplyRef = useRef<string | null>(null);
  const streamedInputsRef = useRef(new Set<string>());
  const completedInputsRef = useRef(new Set<string>());
  const refreshSequenceRef = useRef(0);
  const router = useRouter();

  const isEmpty = messages.length === 0;

  // The gmail connection drives the email-draft connectable bubble; derive it
  // from the roster fetch rather than owning a separate gmail-only status call.
  const gmailConnected =
    roster.find((r) => r.key === "google-mail")?.connected ?? false;

  const refreshConnectors = useCallback(async () => {
    const res = await fetch(`${API}/integrations`, {
      credentials: "include",
    }).catch(() => null);
    if (res && res.ok) {
      const data = (await res.json()) as { integrations: RosterRow[] };
      setRoster(data.integrations);
    }
  }, []);

  const refreshThread = useCallback(async (): Promise<boolean> => {
    const sequence = ++refreshSequenceRef.current;
    const res = await fetch(`${API}/conversation`, { credentials: "include" });
    if (res.status === 401) {
      router.replace("/login");
      return false;
    }
    if (!res.ok) return false;
    const data = (await res.json()) as Conversation;
    if (sequence !== refreshSequenceRef.current) return true;
    setConversationId(data.conversation.id);
    for (const message of data.conversation.messages) {
      if (message.role === "assistant" && message.parentMessageId)
        completedInputsRef.current.add(message.parentMessageId);
      for (const id of message.replyToMessageIds ?? [])
        completedInputsRef.current.add(id);
    }
    const thread = data.conversation.messages.map(toThreadMessage);
    setMessages((previous) =>
      preservePendingStreams(thread, previous, completedInputsRef.current),
    );
    // Only a reply that just arrived from this session's send gets the reveal
    // animation; a page reload shows the history as-is.
    if (pendingReplyRef.current) {
      const reply = findReply(
        data.conversation.messages,
        pendingReplyRef.current,
      );
      if (reply) {
        if (
          reply.parentMessageId &&
          streamedInputsRef.current.has(reply.parentMessageId)
        ) {
          lastStreamedRef.current = reply.id;
        } else if (reply.id !== lastStreamedRef.current)
          setStreamingId(reply.id);
        pendingReplyRef.current = null;
        setThinking(false);
      }
    } else {
      // Reloading or reconnecting during a queued turn restores its loader.
      const last = data.conversation.messages.at(-1);
      setThinking(last?.role === "user");
    }
    setView("chat");
    return true;
  }, [router]);

  useEffect(() => {
    refreshThread();
  }, [refreshThread]);

  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return;
    fetch(`${API}/user/timezone`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeZone }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (view !== "chat") return;
    refreshConnectors();
  }, [view, refreshConnectors]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking]);

  useEffect(() => {
    if (view !== "chat") return;
    // Long-lived push channel: the browser's live socket. Auth rides the
    // httpOnly access_token cookie on the handshake.
    const socket = io(WS_URL, { withCredentials: true });
    let refreshing = false;
    socket.on("connect", () => {
      void refreshThread().catch(() => {});
    });
    socket.on("new_message", (event: { deliveryIds?: string[] } = {}) => {
      if (event.deliveryIds?.length)
        socket.emit("delivery_ack", event.deliveryIds);
      void maybeNotifyDesktop("Mimir", "New activity in your thread");
      refreshThread().catch((err) =>
        console.error("[socket] conversation refetch failed", err),
      );
    });
    socket.on(
      "message_delta",
      (event: {
        conversationId: string;
        inputMessageId: string;
        text: string;
      }) => {
        if (
          event.conversationId !== conversationId ||
          completedInputsRef.current.has(event.inputMessageId)
        )
          return;
        streamedInputsRef.current.add(event.inputMessageId);
        const id = `stream-${event.inputMessageId}`;
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== id),
          { id, speaker: "mimir", text: event.text },
        ]);
      },
    );
    socket.on("turn_settled", () => {
      void refreshThread().catch(() => {});
    });
    socket.on("connect_error", (err) => {
      // Only a rejected handshake means the access token is bad. Refresh at most one
      // at a time: /auth/refresh rotates the token, so concurrent refreshes from
      // multiple tabs sharing the cookie race.
      const isAuthError = String(err?.message)
        .toLowerCase()
        .includes("unauthorized");
      if (!isAuthError || refreshing) return;
      refreshing = true;
      fetch(`${API}/auth/refresh`, { method: "POST", credentials: "include" })
        .then((res) => {
          if (res.ok) socket.connect();
        })
        .catch(() => {})
        .finally(() => {
          refreshing = false;
        });
    });
    return () => {
      socket.disconnect();
    };
  }, [view, conversationId, refreshThread]);

  useEffect(() => {
    if (!thinking) return;
    // Heal a lost pub/sub notification without requiring a page reload.
    const timer = setInterval(() => {
      void refreshThread().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [thinking, refreshThread]);

  const autosize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, []);

  const post = useCallback(
    async (content: string) => {
      if (!content || !conversationId) return;
      setDraft("");
      setThinking(true);
      setError(null);
      const clientMessageId = crypto.randomUUID();
      pendingReplyRef.current = clientMessageId;
      setMessages((prev) => [
        ...prev,
        { id: clientMessageId, speaker: "you", text: content },
      ]);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await fetch(`${API}/message`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId, content, clientMessageId }),
          });
          if (res.status === 401) {
            router.replace("/login");
            setThinking(false);
            pendingReplyRef.current = null;
            return;
          }
          if (res.ok) {
            await refreshThread().catch(() => {});
            return;
          }
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          if (attempt === 0 && res.status >= 500) continue; // retry same idempotency key
          setError(body?.error?.message ?? "Request failed");
          setThinking(false);
          pendingReplyRef.current = null;
          return;
        }
        setThinking(false);
      } catch {
        pendingReplyRef.current = null;
        setThinking(false);
        setError("Couldn't send your message. Please try again.");
      }
    },
    [conversationId, refreshThread, router],
  );

  const send = useCallback(() => {
    const text = draft.trim() || (thinking ? "stop" : "");
    if (!text) return;
    setListening(false);
    post(text);
  }, [draft, thinking, post]);

  const connectByKey = useCallback(
    async (key: string) => {
      setError(null);
      const label = roster.find((r) => r.key === key)?.label ?? key;
      const res = await fetch(`${API}/integrations/${key}/connect`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(
          body?.error?.message ?? `Couldn't start ${label} connect — try again`,
        );
        return;
      }
      const { sessionToken, authorizationUrl, alreadyConnected } =
        (await res.json()) as {
          sessionToken?: string;
          authorizationUrl?: string;
          alreadyConnected?: boolean;
        };
      if (alreadyConnected) {
        void refreshConnectors();
        return;
      }
      // Composio hands back a redirect URL; Nango a session token for its in-page widget.
      if (authorizationUrl) {
        window.location.href = authorizationUrl;
        return;
      }
      if (!sessionToken) {
        setError(`Couldn't start ${label} connect — retry later`);
        return;
      }
      const { default: Nango } = await import("@nangohq/frontend");
      new Nango({ connectSessionToken: sessionToken }).openConnectUI({
        onEvent: (event) => {
          if (event.type === "connect") {
            void refreshConnectors();
            return;
          }
          if (event.type === "error") {
            // A user cancel (closed the window, denied consent at the provider) is
            // surfaced by Nango as an error with a raw provider payload. It's not a
            // failure — ignore it instead of flashing `{"error":"access_denied"}`.
            const cancelled =
              event.payload.errorType === "window_closed" ||
              /access_denied/i.test(event.payload.errorMessage);
            if (!cancelled)
              setError(`${label} connect didn't complete — try again`);
          }
        },
      });
    },
    [roster, refreshConnectors],
  );

  // The ConnectorsPanel hands us a display name; resolve it back to the key the
  // API expects (keys like "google-mail" are not what the UI shows).
  const connect = useCallback(
    async (name: string) => {
      const row = roster.find((r) => r.label === name);
      if (row) await connectByKey(row.key);
    },
    [roster, connectByKey],
  );

  const disconnectByKey = useCallback(
    async (key: string) => {
      setError(null);
      const label = roster.find((r) => r.key === key)?.label ?? key;
      const res = await fetch(`${API}/integrations/${key}/disconnect`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setError(`Couldn't disconnect ${label} — try again`);
        return;
      }
      void refreshConnectors();
    },
    [roster, refreshConnectors],
  );

  const disconnect = useCallback(
    async (name: string) => {
      const row = roster.find((r) => r.label === name);
      if (row) await disconnectByKey(row.key);
    },
    [roster, disconnectByKey],
  );

  const logout = useCallback(async () => {
    await fetch(`${API}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    setMessages([]);
    setConnectorsOpen(false);
    router.replace("/login");
  }, [router]);

  const connectors = roster.map((r) => {
    const Icon = ROSTER_ICONS[r.key] ?? FALLBACK_ICON;
    return { name: r.label, icon: Icon, connected: r.connected };
  });
  const watching = connectors.filter((c) => c.connected).map((c) => c.name);

  if (view === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <SignalDot />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <SiteHeader
        watching={watching}
        onOpenConnectors={() => setConnectorsOpen(true)}
        onLogout={logout}
      />

      <ConnectorsPanel
        open={connectorsOpen}
        onClose={() => setConnectorsOpen(false)}
        items={connectors}
        onConnect={(name) => void connect(name)}
        onDisconnect={(name) => void disconnect(name)}
        onLogout={logout}
      />

      <main className="relative flex-1 overflow-y-auto">
        <div
          className="pointer-events-none absolute inset-0 grid-texture opacity-40"
          aria-hidden
        />

        {isEmpty ? (
          <FirstVisit />
        ) : (
          <div className="relative mx-auto w-full max-w-2xl px-5 pb-16 pt-14">
            <h1 className="sr-only">Your thread with Mimir</h1>
            <ThreadBubbles
              messages={
                gmailConnected
                  ? messages.map((m) =>
                      m.connectable ? { ...m, connectable: false } : m,
                    )
                  : messages
              }
              streamingId={streamingId}
              onStreamDone={() => {
                if (streamingId) lastStreamedRef.current = streamingId;
                setStreamingId(null);
              }}
              onAction={(id, action) => post(action)}
              onConnect={() => void connectByKey("google-mail")}
            />

            <div className="flex items-center gap-2 pt-6">
              <SignalDot />
              <span className="text-xs text-muted-foreground">
                {thinking
                  ? "Thinking it through."
                  : streamingId
                    ? "Telling you now."
                    : "Still watching — nothing else worth telling you yet."}
              </span>
            </div>
            {error ? (
              <p className="pt-2 text-xs text-destructive">{error}</p>
            ) : null}
            <div ref={bottomRef} />
          </div>
        )}
      </main>

      <div className="z-20 shrink-0 border-t border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto w-full max-w-2xl px-5 py-4">
          <div className="flex items-end gap-2">
            <button
              type="button"
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              aria-pressed={listening}
              onClick={() => setListening((value) => !value)}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-md border border-transparent",
                "text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                "focus-visible:outline-none focus-visible:border-signal",
                listening && "text-signal",
              )}
            >
              {listening ? <Waveform /> : <Mic className="size-4" />}
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              placeholder="Tell it something once."
              onChange={(event) => {
                setDraft(event.target.value);
                autosize();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              className={cn(
                "min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2",
                "font-sans text-[0.95rem] leading-6 text-foreground placeholder:text-muted-foreground",
                "outline-none transition-colors focus:border-signal",
              )}
            />

            <MovingBorderButton
              onClick={send}
              disabled={!thinking && draft.trim().length === 0}
              aria-label={thinking && !draft.trim() ? "Stop" : "Send"}
              className="px-3 py-2"
            >
              {thinking ? <SignalDot /> : <ArrowUp className="size-4" />}
            </MovingBorderButton>
          </div>
          <p className="mt-2 pl-11 text-xs text-muted-foreground">
            {listening
              ? "Listening — speak, it keeps working in the background."
              : "Always listening. Hand it your apps, it connects the dots."}
          </p>
        </div>
      </div>
    </div>
  );
}

function Waveform() {
  return (
    <span aria-hidden className="flex h-4 items-center gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-signal"
          style={{
            height: "100%",
            animation: `waveform 1s ease-in-out ${i * 120}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function FirstVisit() {
  return (
    <div className="relative flex min-h-[60vh] items-center justify-center px-5">
      <Spotlight />
      <Reveal className="relative max-w-md text-center">
        <h1 className="font-condensed text-3xl font-semibold text-foreground sm:text-4xl">
          Say the first thing.
        </h1>
      </Reveal>
    </div>
  );
}
