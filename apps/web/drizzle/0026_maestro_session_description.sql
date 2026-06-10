-- Maestro: per-session description (1-paragraph summary the agent keeps
-- in sync with the running conversation; surfaces in the History pane).
ALTER TABLE "ai_agent_sessions" ADD COLUMN IF NOT EXISTS "description" text;
