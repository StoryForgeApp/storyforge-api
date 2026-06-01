import { createAuthEndpoint } from "better-auth/api";

export const socialProviders = () => ({
  endpoints: {
    getSocialProviders: createAuthEndpoint(
      "/social-providers",
      {
        metadata: {
          openapi: {
            description: "Returns the list of available social providers",
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      description: "List of available social providers",
                      items: {
                        type: "string",
                      },
                      type: "array",
                    },
                  },
                },
                description: "Success",
              },
            },
          },
        },
        method: "GET",
      },
      async (ctx) => ctx.json(ctx.context.socialProviders.map((p) => p.name.toLowerCase())),
    ),
  },
  id: "social-providers-plugin",
});
