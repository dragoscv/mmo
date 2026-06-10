import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: ["./src/db/schema.ts", "./src/db/schema-ai.ts", "./src/db/schema-training.ts"],
    out: "./drizzle",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "",
    },
});
