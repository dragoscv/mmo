import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: [
        "../../packages/db/src/schema.ts",
        "../../packages/db/src/schema-ai.ts",
        "../../packages/db/src/schema-training.ts",
    ],
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "",
    },
});
