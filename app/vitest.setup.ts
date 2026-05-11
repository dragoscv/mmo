// Vitest setup — extends `expect` with @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, …) so tsx component tests can
// assert against the rendered DOM with the standard idioms.
import "@testing-library/jest-dom/vitest";

// Default env vars for unit tests so modules that read process.env at
// import time (db connection string, AUTH_SECRET-derived crypto keys)
// load without crashing. Tests never connect to a real DB.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test_unused";
process.env.AUTH_SECRET ??= "test-secret-must-be-at-least-32-bytes-long-aaaaaa";
