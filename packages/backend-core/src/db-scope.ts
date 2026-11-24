import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

// Row-level security scope. Code running for one user (an authenticated
// request, a user-bound job) runs inside withUserScope; everything else is
// system work. The pool below copies the scope onto each connection it hands
// out as the mimir.user_id setting that the RLS policies read.
const scope = new AsyncLocalStorage<{ userId: string | null }>();

export function withUserScope<T>(userId: string, fn: () => T): T {
  return scope.run({ userId }, () => {
    const out = fn();
    // Prisma promises are lazy: they query when first awaited, which would
    // be after this scope has exited. Start any thenable here instead.
    if (out && typeof (out as { then?: unknown }).then === "function") {
      const thenable = out as unknown as PromiseLike<unknown>;
      return new Promise((resolve, reject) =>
        thenable.then(resolve, reject),
      ) as T;
    }
    return out;
  });
}

export function currentDbUser(): string | null {
  return scope.getStore()?.userId ?? null;
}

const APPLIED = Symbol("mimir.user_id");
type ScopedClient = pg.PoolClient & { [APPLIED]?: string };
type ConnectCallback = (
  err: Error | undefined,
  client?: pg.PoolClient,
  release?: (err?: Error | boolean) => void,
) => void;

// Sets mimir.user_id at session level on every checkout ('' = system). The
// setting is skipped when the pooled connection already carries it, so system
// work and repeat requests cost no extra round trip. Superusers and roles with
// BYPASSRLS ignore policies; `role` switches each new connection to a role that
// does not (DATABASE_RLS_ROLE).
export class ScopedPool extends pg.Pool {
  private readonly initialized = new WeakSet<pg.PoolClient>();

  constructor(
    config: pg.PoolConfig,
    private readonly role?: string,
    private readonly requireRls = false,
  ) {
    super(config);
    if (role) {
      if (!/^[a-z_][a-z0-9_]*$/.test(role))
        throw new Error("DATABASE_RLS_ROLE must be a plain role name");
    }
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const userId = currentDbUser() ?? "";
    const scoped = super.connect().then(async (client: ScopedClient) => {
      try {
        if (!this.initialized.has(client)) {
          if (this.role) await client.query(`SET ROLE ${this.role}`);
          if (this.role || this.requireRls) {
            const result = await client.query(
              "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
            );
            if (result.rows[0]?.rolsuper || result.rows[0]?.rolbypassrls)
              throw new Error(
                "Application database role bypasses RLS; configure DATABASE_RLS_ROLE",
              );
          }
          this.initialized.add(client);
        }
        if (client[APPLIED] !== userId) {
          await client.query("SELECT set_config('mimir.user_id', $1, false)", [
            userId,
          ]);
          client[APPLIED] = userId;
        }
      } catch (error) {
        client.release(error as Error);
        throw error;
      }
      return client;
    });
    if (!callback) return scoped;
    scoped.then(
      (client) => callback(undefined, client, client.release.bind(client)),
      (error: Error) => callback(error),
    );
  }
}

// Prisma batches findUnique calls made in the same tick into one SQL query,
// which would run under whichever scope dispatched the batch. findFirst is
// never batched, so unique lookups are issued as findFirst with compound keys
// flattened ({a_b: {a, b}} -> {a, b}).
export function unbatchedUniqueWhere(
  where: Record<string, unknown>,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (
      key.includes("_") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      [...key.split("_")].sort().join() ===
        Object.keys(value as object)
          .sort()
          .join()
    )
      Object.assign(flat, value);
    else flat[key] = value;
  }
  return flat;
}

// Creates or refreshes a role that row-level security applies to (see
// scripts/rls-role.ts). Statements run as the owner; safe to repeat.
export function rlsRoleStatements(role: string): string[] {
  if (!/^[a-z_][a-z0-9_]*$/.test(role))
    throw new Error("role must be a plain lowercase name");
  return [
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`,
    `ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS`,
    // Lets a non-superuser owner SET ROLE to it.
    `GRANT ${role} TO CURRENT_USER`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
  ];
}
