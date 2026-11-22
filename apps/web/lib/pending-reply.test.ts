import { expect, test } from "bun:test";
import { findReply } from "./pending-reply";

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
