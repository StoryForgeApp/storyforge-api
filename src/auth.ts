import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import {
  twoFactor,
  lastLoginMethod,
  openAPI,
  organization,
  admin,
  username,
  bearer,
} from "better-auth/plugins";
import { socialProviders } from "./auth/socialProviders";
import { configuredProviders } from "./auth/providers";
import { modpacks } from "./auth/modpacks";
import * as schema from "./db/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: [
    "sf:/",
    "storyforge:/",
    "http://localhost:1420",
    "http://localhost:3050",
    "tauri://localhost",
  ],
  socialProviders: configuredProviders,
  plugins: [
    twoFactor(),
    lastLoginMethod(),
    openAPI(),
    organization(),
    admin(),
    socialProviders(),
    username(),
    bearer(),
    modpacks,
  ],
});
