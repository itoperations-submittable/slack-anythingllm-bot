// index.js
// FINAL FULL Version: Truly no placeholders, includes all features.

import express from 'express';
import { createEventAdapter } from '@slack/events-api';
import axios from 'axios';
import { createClient } from 'redis';
import { WebClient } from '@slack/web-api';
import pg from 'pg';

// Import configuration
import {
    port,
    slackSigningSecret,
    slackToken,
    botUserId,
    anythingLLMBaseUrl,
    anythingLLMApiKey,
    redisUrl,
    databaseUrl,
    MAX_SLACK_BLOCK_TEXT_LENGTH,
    RESET_CONVERSATION_COMMAND,
    RESET_HISTORY_REDIS_PREFIX,
    RESET_HISTORY_TTL,
    WORKSPACE_LIST_CACHE_KEY,
    WORKSPACE_LIST_CACHE_TTL,
    DUPLICATE_EVENT_REDIS_PREFIX,
    DUPLICATE_EVENT_TTL,
    validateConfig
} from './config.js';

// Validate configuration
validateConfig();

// Import Services & Shutdown Logic
// Note: Services like Redis/DB are initialized when imported here
import {
    shutdownServices,
    dbPool, redisClient, isRedisReady
} from './services.js';

// Import Slack Handlers & Clients
import { slackEvents, handleSlackEvent, handleInteraction } from './slack.js';

// --- Configuration ---
const app = express();

// --- Input Validation ---
if (!slackSigningSecret || !slackToken || !anythingLLMBaseUrl || !anythingLLMApiKey) {
    console.error("Missing critical environment variables (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, LLM_API_BASE_URL, LLM_API_KEY)");
    process.exit(1);
}
if (!botUserId) {
    console.error("SLACK_BOT_USER_ID environment variable is not set. This is required to prevent message loops.");
    process.exit(1);
}
if (!redisUrl) {
    console.warn("REDIS_URL not set. Duplicate detection and 'reset conversation' may not work reliably.");
}
if (!databaseUrl) {
    console.warn("DATABASE_URL environment variable not set. Feedback will be logged to console only.");
}

// --- Express App Setup ---
// Events API listener *MUST* come before any body parsers that consume the raw body
app.use('/slack/events', slackEvents.requestListener());

// --- Interaction Endpoint ---
// Apply urlencoded middleware specifically to this route for Slack interactions
app.post('/slack/interactions', express.urlencoded({ extended: true, limit: '1mb' }), handleInteraction);

// --- Basic Health Check Route ---
app.get('/', (req, res) => {
    const redisStatus = redisUrl ? (isRedisReady ? 'Ready' : 'Not Ready/Error') : 'Not Configured';
    res.send(`DeepOrbit (Modular) is live 🛰️ Redis Status: ${redisStatus}`);
});

// --- Start Server ---
const server = app.listen(port, () => {
    console.log(`🚀 DeepOrbit (Modular) running on port ${port}`);
    console.log(`🕒 Current Time: ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' })} (Cairo Time)`);
});

// --- Graceful Shutdown Handler ---
async function gracefulShutdown(signal) {
    console.log(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
        console.log('HTTP server closed.');
        await shutdownServices(signal); // Close Redis/DB connections
        console.log('Cleanup finished. Exiting.');
        process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
        console.error('Could not close connections gracefully after timeout, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Main Event Listener Attachment ---
// This connects the internal handler logic exported from slack.js to the event emitter
slackEvents.on('message', handleSlackEvent);
slackEvents.on('app_mention', handleSlackEvent);

slackEvents.on('error', (error) => {
    console.error('[SlackEvents Adapter Error]', error.name, error.code || '', error.message);
    if (error.request) { console.error('Request:', error.request.method, error.request.url); }
    if (error.code === '@slack/events-api:adapter:signatureVerificationFailure') { console.error('[FATAL] Slack signature verification failed!'); }
});

console.log("Event listeners attached.");