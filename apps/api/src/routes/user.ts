import {
  budgetStatus,
  budgetView,
  getPrismaClient,
  notificationPreferences,
} from "@mimir/backend-core";
import { requireAuth } from "../auth/auth.js";
import type { Request, Response } from "express";
import { Router } from "express";

// User-level preferences. One endpoint, one field today: the browser-reported
// IANA timezone, so the worker can localize surfaced timestamps. Stored as a
// plain string; validated at use time (the worker falls back to ISO on garbage).

export const userRouter: Router = Router();

userRouter.get("/user/notifications", requireAuth, async (req, res) => {
  const user = await getPrismaClient().user.findUnique({
    where: { id: req.userId! },
    select: { notificationPreferences: true },
  });
  res.json(notificationPreferences.parse(user?.notificationPreferences ?? {}));
});
userRouter.post("/user/notifications", requireAuth, async (req, res) => {
  const parsed = notificationPreferences.strict().safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid notification preferences",
        },
      });
    return;
  }
  await getPrismaClient().user.update({
    where: { id: req.userId! },
    data: { notificationPreferences: parsed.data },
  });
  res.json(parsed.data);
});

// Today's model spend against the user's daily budget.
userRouter.get("/user/usage", requireAuth, async (req, res) => {
  const userId = (req as Request & { userId?: string }).userId as string;
  res.json({ budget: budgetView(await budgetStatus(userId)) });
});

userRouter.post(
  "/user/timezone",
  requireAuth,
  async (req: Request, res: Response) => {
    const prisma = getPrismaClient();
    const userId = (req as Request & { userId?: string }).userId as string;
    const { timeZone } = (req.body ?? {}) as { timeZone?: unknown };
    if (
      typeof timeZone !== "string" ||
      timeZone.length === 0 ||
      timeZone.length > 64
    ) {
      res
        .status(400)
        .json({
          error: { code: "VALIDATION_ERROR", message: "timeZone is required" },
        });
      return;
    }
    await prisma.user.update({
      where: { id: userId },
      data: { timezone: timeZone },
    });
    res.json({ ok: true });
  },
);
