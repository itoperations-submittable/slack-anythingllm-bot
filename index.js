// index.js

import express from 'express';
import { createEventAdapter } from '@slack/events-api';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import { WebClient } from '@slack/web-api';

// Load environment variables
dotenv.config();

// --- Configuration ---
const app = express();
const port = process.env.PORT || 3000;
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
const slackToken = process.env.SLACK_BOT_TOKEN;
const botUserId = process.env.SLACK_BOT_USER_ID; // <<<=== Load Bot User ID
const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
const anythingLLMApiKey = process.env.LLM_API_KEY;
const developerId = process.env.DEVELOPER_ID; // Optional: Restrict usage to a specific Slack User ID
const redisUrl = process.env.REDIS_URL;

// --- Input Validation ---
if (!slackSigningSecret || !slackToken || !anythingLLMBaseUrl || !anythingLLMApiKey) {
    console.error("Missing critical environment variables (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, LLM_API_BASE_URL, LLM_API_KEY)");
    process.exit(1);
}
// Add validation for the Bot User ID - CRITICAL for preventing loops
if (!botUserId) {
    console.error("SLACK_BOT_USER_ID environment variable is not set. This is required to prevent message loops. Please add it to your .env file (e.g., SLACK_BOT_USER_ID=U08MAFADD0R).");
    process.exit(1); // Exit if the bot ID isn't set
}
if (!redisUrl) {
    console.warn("REDIS_URL is not set. Workspace persistence and duplicate detection may not work reliably across restarts or multiple instances.");
}

// --- Redis Client Setup ---
let redisClient;
let isRedisReady = false;
if (redisUrl) {
    redisClient = createClient({
        url: redisUrl,
        socket: {
            reconnectStrategy: retries => Math.min(retries * 100, 3000),
        },
    });

    redisClient.on('error', err => {
        console.error('Redis error:', err);
        isRedisReady = false;
    });
    redisClient.on('connect', () => console.log('Redis connecting...'));
    redisClient.on('ready', () => {
        console.log('Redis connected!');
        isRedisReady = true;
    });
    redisClient.on('end', () => {
        console.log('Redis connection closed.');
        isRedisReady = false;
    });

    redisClient.connect().catch(err => console.error("Initial Redis connection failed:", err));
} else {
    redisClient = {
        isReady: false,
        get: async () => null,
        set: async () => null,
        del: async () => 0,
        quit: async () => {},
        isOpen: false,
        on: () => {},
        connect: async () => {}
    };
    console.warn("Running without a functional Redis connection due to missing REDIS_URL.");
}

// --- Slack Clients Setup ---
const slackEvents = createEventAdapter(slackSigningSecret, {
    includeBody: true
});
const slack = new WebClient(slackToken);

// --- Duplicate Event Detection (using Redis) ---
async function isDuplicateRedis(eventId) {
    if (!eventId) {
        console.warn("isDuplicateRedis called with null/undefined eventId");
        return true;
    }
    if (redisUrl && !isRedisReady) {
        console.warn('Redis specified but not ready, cannot check for duplicate event:', eventId);
        return false;
    }
    if (!redisUrl) {
         return false;
     }
    try {
        const result = await redisClient.set(eventId, 'processed', { EX: 60, NX: true });
        return result === null;
    } catch (err) {
        console.error('Redis error during duplicate check for event', eventId, err);
        return false;
    }
}

// --- Workspace Decision Logic ---
async function decideWorkspace(userQuestion) {
    // This function remains unchanged from the previous version
    // It fetches workspaces, asks 'public', validates, and returns a slug or 'public'
    console.log(`[Workspace Decision] Starting for question: "${userQuestion}"`);
    let availableWorkspaces = [];
    try {
        console.log(`[Workspace Decision] Fetching available workspaces from ${anythingLLMBaseUrl}/api/v1/workspaces`);
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 10000,
        });
        if (response.data && Array.isArray(response.data.workspaces)) {
            availableWorkspaces = response.data.workspaces
                .map(ws => ws.slug)
                .filter(slug => slug && typeof slug === 'string');
            console.log(`[Workspace Decision] Found slugs: ${availableWorkspaces.join(', ')}`);
        } else {
            console.error('[Workspace Decision] Unexpected response structure:', response.data);
            throw new Error('Could not parse workspace list.');
        }
        if (availableWorkspaces.length === 0) {
            console.warn('[Workspace Decision] No available workspace slugs found.');
            return 'public';
        }
    } catch (error) {
        console.error('[Workspace Decision Error] Failed to fetch workspaces:', error.response?.data || error.message);
        return 'public';
    }
    const selectionPrompt = `Given the user question: "${userQuestion}", what would be the most relevant workspace slug from this list [${availableWorkspaces.join(', ')}] to send that question to? Your answer should ONLY be the workspace slug itself, exactly as it appears in the list.`;
    console.log(`[Workspace Decision] Sending prompt to public workspace.`);
    try {
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, {
            message: selectionPrompt, mode: 'chat',
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 15000,
        });
        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[Workspace Decision] Raw response from public workspace: "${chosenSlugRaw}"`);
        if (!chosenSlugRaw || typeof chosenSlugRaw !== 'string') {
            console.warn('[Workspace Decision] Public workspace bad response.');
            return 'public';
        }
        const chosenSlug = chosenSlugRaw.trim();
        if (availableWorkspaces.includes(chosenSlug)) {
            console.log(`[Workspace Decision] Valid slug selected: "${chosenSlug}"`);
            return chosenSlug;
        } else {
            const foundSlug = availableWorkspaces.find(slug => chosenSlug.includes(slug));
            if (foundSlug) {
                console.log(`[Workspace Decision] Found valid slug "${foundSlug}" in noisy response "${chosenSlug}".`);
                return foundSlug;
            }
            console.warn(`[Workspace Decision] Invalid slug "${chosenSlug}". Falling back.`);
            return 'public';
        }
    } catch (error) {
        console.error('[Workspace Decision Error] Failed query public workspace:', error.response?.data || error.message);
        return 'public';
    }
}

// --- Constants ---
const RESET_WORKSPACE_COMMAND = 'reset workspace';
const WORKSPACE_REDIS_PREFIX = 'workspace:channel:';

// --- Main Slack Event Handler ---
async function handleSlackMessageEvent(event) {
    // This function remains unchanged from the previous version
    // It handles DM detection, reset command, Redis workspace storage/retrieval,
    // posting thinking/notification messages, calling the LLM, and posting the final response.
    const userId = event.user;
    const text = event.text?.trim() ?? '';
    const channel = event.channel;
    const originalTs = event.ts;
    const threadTs = event.thread_ts;
    const isDM = channel.startsWith('D');
    console.log(`[Handler] Received message. User: ${userId}, Channel: ${channel} (isDM: ${isDM}), Text: "${text}"`);
    const redisKey = `${WORKSPACE_REDIS_PREFIX}${channel}`;

    // Check for Reset Command (Only if Redis is configured and ready)
    if (redisUrl && text.toLowerCase() === RESET_WORKSPACE_COMMAND) {
        console.log(`[Handler] User ${userId} requested workspace reset.`);
        if (!isRedisReady) {
            console.warn("Redis not ready, cannot process reset.");
             try {
                 await slack.chat.postMessage({ channel: channel, thread_ts: isDM ? undefined : threadTs || originalTs, text: "⚠️ Cannot reset workspace (database issue)." });
             } catch (slackError) { console.error("[Slack Error] Failed post Redis error msg:", slackError.data?.error || slackError.message); }
            return;
        }
        try {
            const deletedCount = await redisClient.del(redisKey);
            const replyText = (deletedCount > 0) ? "✅ Workspace selection reset." : "ℹ️ No workspace previously set.";
            await slack.chat.postMessage({ channel: channel, thread_ts: isDM ? undefined : threadTs || originalTs, text: replyText });
        } catch (redisError) {
            console.error(`[Redis Error] Failed delete ${redisKey}:`, redisError);
            await slack.chat.postMessage({ channel: channel, thread_ts: isDM ? undefined : threadTs || originalTs, text: "⚠️ Error resetting workspace." });
        }
        return;
    }

    // Determine Workspace
    let workspace = null;
    let workspaceSource = 'newly_decided';
    if (redisUrl && isRedisReady) {
        try {
            const storedWorkspace = await redisClient.get(redisKey);
            if (storedWorkspace) {
                workspace = storedWorkspace;
                workspaceSource = 'stored';
                console.log(`[Handler] Found stored workspace "${workspace}" for ${channel}`);
            }
        } catch (redisError) {
             console.error(`[Redis Error] Failed get ${redisKey}:`, redisError);
             workspaceSource = 'redis_error_fallback';
        }
    }

    if (!workspace) {
        console.log(`[Handler] ${workspaceSource === 'redis_error_fallback' ? 'Redis failed, deciding.' : 'No stored workspace. Deciding...'}`);
        workspace = await decideWorkspace(text);
        if (!workspace) {
             console.error("[Handler] decideWorkspace failed. Fallback to public.");
             workspace = 'public';
             workspaceSource = 'error_fallback';
        } else if (redisUrl && isRedisReady) {
            console.log(`[Handler] Storing decided workspace "${workspace}" for ${channel}`);
            try {
                await redisClient.set(redisKey, workspace);
                workspaceSource = 'newly_set';
            } catch (redisError) {
                 console.error(`[Redis Error] Failed set ${redisKey}:`, redisError);
                 workspaceSource = 'redis_error_set_failed';
            }
        } else {
             workspaceSource = 'no_redis_fallback';
        }
    }
     console.log(`[Handler] Using workspace: ${workspace} (Source: ${workspaceSource})`);

    // Send "Thinking" message
    let thinkingMessageTs = null;
    let thinkingText = ':hourglass_flowing_sand: DeepOrbit is thinking...';
    if (workspaceSource === 'stored' || workspaceSource === 'newly_set') {
        thinkingText += `\n*(Workspace: ${workspace})*`;
    }
    const replyTarget = isDM ? undefined : (threadTs || originalTs);
    try {
        const thinkingMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: thinkingText });
        thinkingMessageTs = thinkingMsg.ts;
    } catch (slackError) { console.error("[Slack Error] Failed post 'thinking':", slackError.data?.error || slackError.message); }

    // Notify if workspace was newly set
    if (workspaceSource === 'newly_set') {
         try {
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `ℹ️ Workspace set to *${workspace}*.` + (redisUrl ? ` Type \`${RESET_WORKSPACE_COMMAND}\` to reset.` : '') });
         } catch (slackError) { console.warn("[Slack Error] Failed post 'ws set' notify:", slackError.data?.error || slackError.message); }
    }

    // Query LLM
    try {
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${workspace}/chat`, {
            message: text, mode: 'chat', sessionId: userId,
        }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 30000 });
        const reply = llmResponse.data.textResponse || '⚠️ Sorry, empty response.';
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: reply });
        if (thinkingMessageTs) { await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed delete 'thinking':", delErr.data?.error || delErr.message)); }
    } catch (error) {
        console.error(`[LLM Error - Workspace: ${workspace}]`, error.response?.data || error.message);
        try {
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: '⚠️ DeepOrbit internal error.' });
            if (thinkingMessageTs) { await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed delete 'thinking' after error:", delErr.data?.error || delErr.message)); }
        } catch (slackError) { console.error("[Slack Error] Failed post LLM error msg:", slackError.data?.error || slackError.message); }
    }
}

// --- Express App Setup ---
app.use('/slack/events', slackEvents.requestListener());
app.use(express.urlencoded({ extended: true }));

// --- Slack Event Listeners ---
// >>>>>>>> MODIFIED LISTENER TO PREVENT LOOP <<<<<<<<<<
slackEvents.on('message', async (event, body) => {
    const eventId = body?.event_id;
    // Minimal logging here to avoid noise
    // console.log(`[Event Received] Type: message, ID: ${eventId}, User: ${event.user}, Chan: ${event.channel}`);

    // 1. Duplicate Check (Essential)
    if (await isDuplicateRedis(eventId)) {
        console.log(`[Duplicate] Skipping event: ${eventId}`);
        return;
    }

    // 2. Ignore irrelevant messages (REVISED AND CRITICAL)
    const subtype = event.subtype;
    const messageUserId = event.user; // User ID from the incoming message event

    if (
        // Common subtypes generated by actions other than user typing
        subtype === 'bot_message' ||
        subtype === 'message_deleted' ||
        subtype === 'message_changed' ||
        subtype === 'channel_join' ||
        subtype === 'channel_leave' ||
        subtype === 'thread_broadcast' ||

        // Messages without a user ID
        !messageUserId ||

        // Messages without actual text content
        !event.text?.trim() ||

        // *** CRITICAL: Ignore messages sent by the bot itself ***
        messageUserId === botUserId  // Compare incoming message user to configured bot user ID
    ) {
        // Log skipped events for debugging if needed, but can be noisy
         console.log(`[Skipping Event] Reason: Subtype=${subtype || 'N/A'}, User=${messageUserId}, IsBot=${messageUserId === botUserId}, NoText=${!event.text?.trim()}`);
        return; // Stop processing this event
    }

    // If we passed all filters, log that we're processing it
    console.log(`[Processing Event] ID: ${eventId}, User: ${messageUserId}, Channel: ${event.channel}`);

    // 3. Handle the message asynchronously
    handleSlackMessageEvent(event).catch(err => {
        console.error("[Unhandled Handler Error] Event ID:", eventId, err);
    });
});

// Generic error handler for the adapter
slackEvents.on('error', (error) => {
    console.error('[SlackEvents Adapter Error]', error.name, error.code || '', error.message);
    if (error.request) {
         console.error('[SlackEvents Adapter Error] Request:', error.request.method, error.request.url);
    }
    if (error.code === '@slack/events-api:adapter:signatureVerificationFailure') {
        console.error('[FATAL] Slack signature verification failed! Check SLACK_SIGNING_SECRET.');
    } else if (error.code === '@slack/events-api:adapter:requestTimeTooSkewed') {
        console.error('[FATAL] Slack request timestamp too skewed. Check server time.');
    }
});

// --- Basic Health Check Route ---
app.get('/', (req, res) => {
    const redisStatus = redisUrl ? (isRedisReady ? 'Ready' : 'Not Ready/Connecting/Error') : 'Not Configured';
    res.send(`DeepOrbit is live 🎯 Redis Status: ${redisStatus}`);
});

// --- Start Server ---
(async () => {
    try {
        app.listen(port, () => {
            console.log(`🚀 DeepOrbit running on port ${port}`);
            if (developerId) {
                console.log(`🔒 Bot restricted to developer ID: ${developerId}`);
            } else {
                 console.log(`🔓 Bot is not restricted to a specific developer.`);
            }
            // Use a standard time zone name for clarity if possible
            console.log(`🕒 Current Time: ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' })} (Time in Cairo)`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
})();

// --- Graceful Shutdown ---
async function shutdown(signal) {
    console.log(`${signal} signal received: closing connections and shutting down.`);
    if (redisClient?.isOpen) {
        try {
            await redisClient.quit();
            console.log('Redis connection closed gracefully.');
        } catch(err) {
            console.error('Error closing Redis connection:', err);
        }
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));