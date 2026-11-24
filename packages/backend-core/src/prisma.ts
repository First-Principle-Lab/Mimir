import { PrismaPg } from "@prisma/adapter-pg";
import { getConfig } from "./config/config.js";
import { ScopedPool, unbatchedUniqueWhere } from "./db-scope.js";
import { PrismaClient } from "./generated/prisma/client.js";

// Re-export the Prisma namespace (input types like Prisma.InputJsonValue) for
// consumers that write Json columns without importing the generated client.
export * as Prisma from "./generated/prisma/client.js";
export type { InputJsonValue } from "./generated/prisma/internal/prismaNamespace.js";

let client: PrismaClient | null = null;

type Delegate = Record<string, (args: unknown) => Promise<unknown>>;

// Prisma passes the request's internals to query extensions; a transaction
// (interactive or batch) must keep the original operation on its connection.
// Without those internals, assume a transaction: losing unbatching is safer
// than moving a read out of its transaction (db-scope.test.ts covers both).
function inTransaction(params: object): boolean {
  const internal = (params as { __internalParams?: { transaction?: unknown } })
    .__internalParams;
  return !internal || internal.transaction !== undefined;
}

export function getPrismaClient(): PrismaClient {
  if (!client) {
    const cfg = getConfig();
    client = createPrismaClient(
      cfg.DATABASE_URL,
      cfg.DATABASE_RLS_ROLE,
      cfg.NODE_ENV === "production",
    );
  }
  return client;
}

// The application client: RLS-scoped connections (db-scope.ts) and unique
// lookups that never batch across scopes. Exported for tests that need a
// client with a specific role.
export function createPrismaClient(
  url: string,
  role?: string,
  requireRls = false,
): PrismaClient {
  const pool = new ScopedPool({ connectionString: url }, role, requireRls);
  const base = new PrismaClient({ adapter: new PrismaPg(pool) });
  // See unbatchedUniqueWhere: keep each unique lookup in its caller's scope.
  const delegate = (model: string) =>
    (base as unknown as Record<string, Delegate>)[
      model[0]!.toLowerCase() + model.slice(1)
    ]!;
  return base.$extends({
    query: {
      $allModels: {
        findUnique({ model, args, query, ...rest }) {
          // Inside a transaction every query already shares one connection.
          if (inTransaction(rest)) return query(args);
          return delegate(model).findFirst!({
            ...args,
            where: unbatchedUniqueWhere(args.where),
          });
        },
        findUniqueOrThrow({ model, args, query, ...rest }) {
          if (inTransaction(rest)) return query(args);
          return delegate(model).findFirstOrThrow!({
            ...args,
            where: unbatchedUniqueWhere(args.where),
          });
        },
      },
    },
  }) as unknown as PrismaClient;
}
