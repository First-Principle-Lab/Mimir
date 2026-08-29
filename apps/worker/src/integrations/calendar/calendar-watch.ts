import { ProviderError } from "@mimir/connection-provider";
import { rpc, type RequestFn } from "../http-rpc.js";

// Calendar push channel registration (mirror of registerGmailWatch). watch()
// points Google's push at the shared /webhooks/calendar endpoint; the channel
// `token` is echoed back as X-Goog-Channel-Token on every push, which is how
// /webhooks/calendar verifies a delivery came from OUR channel before any DB
// write (Calendar push has no signature). Channels expire (~7 days); the
// renewal sweep re-registers them, carrying the SAME token so an in-flight
// delivery from the old channel still verifies.

export interface CalendarWatchChannel {
  id: string;
  resourceId?: string;
  expiration?: number;
}

// @param address — the public /webhooks/calendar URL (must match PUBLIC_API_URL).
export async function registerCalendarWatch(
  request: RequestFn,
  opts: { address: string; channelId: string; token: string; calendarId?: string },
): Promise<CalendarWatchChannel> {
  const calendarId = opts.calendarId?.trim() || "primary";
  const channel = await rpc<CalendarWatchChannel>(request, `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: "POST",
    body: { id: opts.channelId, type: "web_hook", address: opts.address, token: opts.token },
  });
  if (!channel.id) throw new ProviderError("malformed_response", "calendar watch missing channel id");
  return channel;
}