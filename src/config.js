import dotenv from 'dotenv';

dotenv.config();

// --- Slack Configuration ---
export const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
export const slackToken = process.env.SLACK_BOT_TOKEN;
export const botUserId = process.env.SLACK_BOT_USER_ID; // Bot's own User ID
export const developerId = process.env.DEVELOPER_ID; // Optional: Restrict usage

// --- AnythingLLM Configuration ---
export const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
export const anythingLLMApiKey = process.env.LLM_API_KEY;

// --- Infrastructure Configuration ---
export const port = process.env.PORT || 3000;
export const redisUrl = process.env.REDIS_URL || null;
export const databaseUrl = process.env.DATABASE_URL || null;
export const githubToken = process.env.GITHUB_TOKEN || null; // Optional: Used for GitHub features (release check)

// --- Bot Behavior Configuration ---
export const MAX_SLACK_BLOCK_TEXT_LENGTH = 2950; // Slightly less than 3000 limit for safety
export const MAX_SLACK_BLOCK_CODE_LENGTH = 2900; // Slightly less for code due to formatting overhead
export const RESET_CONVERSATION_COMMAND = 'reset conversation';
export const WORKSPACE_OVERRIDE_COMMAND_PREFIX = '#'; // Prefix to trigger manual workspace selection

// --- Cache Configuration ---
export const DUPLICATE_EVENT_TTL = 600; // 10 minutes
export const RESET_HISTORY_TTL = 300; // 5 minutes
export const WORKSPACE_LIST_CACHE_TTL = 3600; // 1 hour
export const THREAD_WORKSPACE_TTL = 3600; // Seconds to cache the chosen workspace for a thread

// --- Redis Prefixes ---
export const DUPLICATE_EVENT_REDIS_PREFIX = 'slack_event_id:';
export const RESET_HISTORY_REDIS_PREFIX = 'slack_reset_hist:';
export const WORKSPACE_LIST_CACHE_KEY = 'anythingllm_workspaces';
export const THREAD_WORKSPACE_PREFIX = 'thread_workspace:'; // Key: thread_workspace:channel_id:thread_ts

// --- Validation ---
export function validateConfig() {
    console.log("[Config] Validating configuration...");
    if (!slackSigningSecret) console.error("❌ SLACK_SIGNING_SECRET is not set!");
    if (!slackToken) console.error("❌ SLACK_BOT_TOKEN is not set!");
    if (!botUserId) console.error("❌ SLACK_BOT_USER_ID is not set!");
    if (!anythingLLMBaseUrl) console.error("❌ LLM_API_BASE_URL is not set!");
    if (!anythingLLMApiKey) console.error("❌ LLM_API_KEY is not set!");

    if (!redisUrl) console.warn("⚠️ REDIS_URL not set. Duplicate detection and history reset features disabled.");
    if (!databaseUrl) console.warn("⚠️ DATABASE_URL not set. Feedback storage disabled (will log to console).");
    if (!githubToken) console.warn("⚠️ GITHUB_TOKEN not set. GitHub features (release check) disabled.");

    console.log("[Config] Basic validation complete.");
}
