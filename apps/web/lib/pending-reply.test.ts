import { expect, test } from "bun:test";
import { findReply, preservePendingStreams } from "./pending-reply";

test("a queued turn stays pending even when earlier replies exist", () => {
  const messages = [
    { id: "old-reply", role: "assistant", parentMessageId: "old-input" },
    { id: "new-input", role: "user", clientMessageId: "client-id" },
  ];
  expect(findReply(messages, "client-id")).toBeUndefined();
  const reply = {
    id: "new-reply",
    role: "assistant",
    parentMessageId: "new-input",
  };
  expect(findReply([...messages, reply], "client-id")).toEqual(reply);
  expect(findReply([...messages, reply], "another-client-id")).toBeUndefined();
});

test("polling preserves partial text until the matching durable reply arrives", () => {
  const input = { id: "input" };
  const stream = { id: "stream-input" };
  const oldStream = { id: "stream-old-input" };
  expect(
    preservePendingStreams(
      [input],
      [input, stream, oldStream],
      new Set(["old-input"]),
    ),
  ).toEqual([input, stream]);
  const reply = { id: "reply" };
  expect(
    preservePendingStreams([input, reply], [input, stream], new Set(["input"])),
  ).toEqual([input, reply]);
});

test("one burst reply settles each covered client input", () => {
  const reply = {
    id: "reply",
    role: "assistant",
    parentMessageId: "a",
    replyToMessageIds: ["a", "b"],
  };
  const messages = [
    { id: "a", role: "user", clientMessageId: "client-a" },
    { id: "b", role: "user", clientMessageId: "client-b" },
    reply,
  ];
  expect(findReply(messages, "client-a")).toEqual(reply);
  expect(findReply(messages, "client-b")).toEqual(reply);
});
