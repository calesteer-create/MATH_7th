import { eq } from "drizzle-orm";
import { loadEnv } from "./load-env";
import { migrate } from "./migrate";
import { getDb, getSqlite, schema } from "../src/db";
import { hashPassword } from "../src/lib/password";

loadEnv();

const username = (process.env.ADMIN_USERNAME ?? "owner").trim();
const password = process.env.ADMIN_PASSWORD ?? "";

if (!password) {
  console.error("✗ ADMIN_PASSWORD is not set. Add it to .env and run this again.");
  console.error("  The password is never printed or stored in the repository.");
  process.exit(1);
}
if (password.length < 10) {
  console.error("✗ ADMIN_PASSWORD must be at least 10 characters — this account guards all content.");
  process.exit(1);
}

migrate(getSqlite());

const db = getDb();
const existing = db.select().from(schema.adminUsers).where(eq(schema.adminUsers.username, username)).get();

if (existing) {
  db.update(schema.adminUsers)
    .set({ passwordHash: hashPassword(password) })
    .where(eq(schema.adminUsers.username, username))
    .run();
  console.log(`✓ password updated for admin "${username}"`);
} else {
  db.insert(schema.adminUsers)
    .values({ username, passwordHash: hashPassword(password), createdAt: new Date().toISOString() })
    .run();
  console.log(`✓ admin "${username}" created`);
}
