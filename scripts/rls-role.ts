import { loadEnv } from "./_env.js";

// Creates (or refreshes) a role that row-level security applies to, for
// databases where the DATABASE_URL user is a superuser or has BYPASSRLS (local
// Docker and CI). The app switches to it per connection with
// DATABASE_RLS_ROLE. Run after migrations; safe to rerun.
//
// Run: bun scripts/rls-role.ts [role]    (default mimir_rls)

loadEnv();
const role = process.argv[2] ?? "mimir_rls";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(64);
}

// Grants need the connecting (owner) role, not the restricted one.
delete process.env.DATABASE_RLS_ROLE;
const { getPrismaClient, rlsRoleStatements } =
  await import("../packages/backend-core/src/index.js");
const prisma = getPrismaClient();
try {
  for (const sql of rlsRoleStatements(role))
    await prisma.$executeRawUnsafe(sql);
  console.log(`role ${role} ready; set DATABASE_RLS_ROLE=${role}`);
} finally {
  await prisma.$disconnect();
}
