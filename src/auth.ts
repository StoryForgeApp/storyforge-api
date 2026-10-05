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
  advanced: {
    // The website (getstoryforge.app) is a cross-site client of this API,
    // so session cookies must be SameSite=None to be sent along.
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
    },
  },
  trustedOrigins: [
    "sf:/",
    "storyforge:/",
    "http://localhost:1420",
    "http://localhost:3050",
    "http://localhost:5173",
    "tauri://localhost",
    "https://getstoryforge.app",
    "https://www.getstoryforge.app",
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
