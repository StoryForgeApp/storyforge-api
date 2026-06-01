import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

if (!Bun.env.TURSO_DATABASE_URL || !Bun.env.TURSO_AUTH_TOKEN) {
  throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set");
}

export const db = drizzle({
  connection: {
    url: Bun.env.TURSO_DATABASE_URL,
    authToken: Bun.env.TURSO_AUTH_TOKEN,
  },
  schema,
});
