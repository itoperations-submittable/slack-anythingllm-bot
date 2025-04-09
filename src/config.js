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
export const redisUrl = process.env.REDIS_URL;
export const databaseUrl = process.env.DATABASE_URL;

// --- Bot Behavior Configuration ---
export const MAX_SLACK_BLOCK_TEXT_LENGTH = 500; // Further reduced to definitely stay below Slack's "See more" threshold
export const RESET_CONVERSATION_COMMAND = 'reset conversation';
export const WORKSPACE_OVERRIDE_COMMAND_PREFIX = '#'; // Prefix to trigger manual workspace selection

// --- Cache Configuration ---
export const DUPLICATE_EVENT_TTL = 60; // Seconds to track event IDs for deduplication
export const RESET_HISTORY_TTL = 300; // Seconds to keep the reset flag active
export const WORKSPACE_LIST_CACHE_TTL = 600; // Seconds to cache the list of available workspaces
export const THREAD_WORKSPACE_TTL = 3600; // Seconds to cache the chosen workspace for a thread

// --- Redis Prefixes ---
export const DUPLICATE_EVENT_REDIS_PREFIX = 'duplicate_event:';
export const RESET_HISTORY_REDIS_PREFIX = 'reset_history:channel:';
export const WORKSPACE_LIST_CACHE_KEY = 'anythingllm:workspaces_list';
export const THREAD_WORKSPACE_PREFIX = 'thread_workspace:'; // Key: thread_workspace:channel_id:thread_ts

// --- Validation ---
export function validateConfig() {
    if (!slackSigningSecret || !slackToken || !anythingLLMBaseUrl || !anythingLLMApiKey) {
        console.error("Missing critical environment variables (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, LLM_API_BASE_URL, LLM_API_KEY)");
        process.exit(1);
    }
    if (!botUserId) {
        console.error("SLACK_BOT_USER_ID environment variable is not set. This is required to prevent message loops.");
        process.exit(1);
    }
    if (!redisUrl) {
        console.warn("REDIS_URL not set. Required features like duplicate detection, reset, and thread context might not work reliably.");
        // Consider exiting if Redis is mandatory: process.exit(1);
    }
    if (!databaseUrl) {
        console.warn("DATABASE_URL environment variable not set. Feedback will be logged to console only.");
    }
     console.log("Configuration validated successfully.");
}
