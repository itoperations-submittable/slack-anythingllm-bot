```javascript
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
const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
const anythingLLMApiKey = process.env.LLM_API_KEY;
const developerId = process.env.DEVELOPER_ID; // Optional: Restrict usage to a specific Slack User ID
const redisUrl = process.env.REDIS_URL;

// --- Input Validation ---
if (!slackSigningSecret || !slackToken || !anythingLLMBaseUrl || !anythingLLMApiKey) {
    console.error("Missing critical environment variables (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, LLM_API_BASE_URL, LLM_API_KEY)");
    process.exit(1);
}
if (!redisUrl) {
    console.warn("REDIS_URL is not set. Workspace persistence and duplicate detection may not work reliably across restarts or multiple instances.");
    // Decide if Redis is absolutely critical
    // process.exit(1);
}

// --- Redis Client Setup ---
let redisClient;
let isRedisReady = false;
if (redisUrl) {
    redisClient = createClient({
        url: redisUrl,
        socket: {
            reconnectStrategy: retries => Math.min(retries * 100, 3000), // Reconnect with backoff
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

    // Start connection asynchronously
    redisClient.connect().catch(err => console.error("Initial Redis connection failed:", err));
} else {
    // Create a dummy client if no URL is provided
    redisClient = {
        isReady: false,
        // Mock methods used to avoid errors if redisClient is accessed when URL is missing
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
// Use the Event Adapter for receiving events (handles verification)
const slackEvents = createEventAdapter(slackSigningSecret, {
    includeBody: true // Make the full request body available in listeners
});

// Use WebClient for sending messages
const slack = new WebClient(slackToken);


// --- Duplicate Event Detection (using Redis) ---
async function isDuplicateRedis(eventId) {
    if (!eventId) {
        console.warn("isDuplicateRedis called with null/undefined eventId");
        return true; // Treat as duplicate
    }
    // Only proceed if redisUrl was provided and client is ready
    if (redisUrl && !isRedisReady) {
        console.warn('Redis specified but not ready, cannot check for duplicate event:', eventId);
        return false; // Fail-safe: Assume not duplicate if Redis is down
    }
    // If no redisUrl was provided, the dummy client `isReady` is false, so this check won't run
     if (!redisUrl) {
         return false; // No Redis, cannot check duplicates reliably
     }

    try {
        const result = await redisClient.set(eventId, 'processed', {
            EX: 60, // Expires after 60 seconds
            NX: true // Only set if key does not exist
        });
        return result === null; // Duplicate if null (key already existed)
    } catch (err) {
        console.error('Redis error during duplicate check for event', eventId, err);
        return false; // Assume not duplicate on error
    }
}


// --- Workspace Decision Logic ---
async function decideWorkspace(userQuestion) {
    console.log(`[Workspace Decision] Starting for question: "${userQuestion}"`);
    let availableWorkspaces = [];

    // 1. Get available workspaces
    try {
        console.log(`[Workspace Decision] Fetching available workspaces from ${anythingLLMBaseUrl}/api/v1/workspaces`);
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: {
                'Accept': 'application/json',
                Authorization: `Bearer ${anythingLLMApiKey}`,
            },
            timeout: 10000, // 10 second timeout
        });

        if (response.data && Array.isArray(response.data.workspaces)) {
            availableWorkspaces = response.data.workspaces
                .map(ws => ws.slug)
                .filter(slug => slug && typeof slug === 'string');
            console.log(`[Workspace Decision] Found slugs: ${availableWorkspaces.join(', ')}`);
        } else {
            console.error('[Workspace Decision] Unexpected response structure when fetching workspaces:', response.data);
            throw new Error('Could not parse workspace list.');
        }

        if (availableWorkspaces.length === 0) {
            console.warn('[Workspace Decision] No available workspace slugs found from API.');
            return 'public';
        }

    } catch (error) {
        console.error('[Workspace Decision Error] Failed to fetch workspaces:', error.response?.data || error.message);
        return 'public';
    }

    // 2. Format prompt for the public workspace
    const selectionPrompt = `Given the user question: "${userQuestion}", what would be the most relevant workspace slug from this list [${availableWorkspaces.join(', ')}] to send that question to? Your answer should ONLY be the workspace slug itself, exactly as it appears in the list.`;
    console.log(`[Workspace Decision] Sending prompt to public workspace.`);

    // 3. Ask the public workspace for the best slug
    try {
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, {
            message: selectionPrompt,
            mode: 'chat',
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 15000,
        });

        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[Workspace Decision] Raw response from public workspace: "${chosenSlugRaw}"`);

        if (!chosenSlugRaw || typeof chosenSlugRaw !== 'string') {
            console.warn('[Workspace Decision] Public workspace did not return a valid text response for selection.');
            return 'public';
        }

        // 4. Extract and validate the chosen slug
        const chosenSlug = chosenSlugRaw.trim();

        if (availableWorkspaces.includes(chosenSlug)) {
            console.log(`[Workspace Decision] Valid slug selected: "${chosenSlug}"`);
            return chosenSlug;
        } else {
            const foundSlug = availableWorkspaces.find(slug => chosenSlug.includes(slug));
            if (foundSlug) {
                console.log(`[Workspace Decision] Found valid slug "${foundSlug}" within potentially noisy response "${chosenSlug}". Using it.`);
                return foundSlug;
            }
            console.warn(`[Workspace Decision] LLM response "${chosenSlug}" is not a valid slug from the list: [${availableWorkspaces.join(', ')}]. Falling back to public.`);
            return 'public';
        }

    } catch (error) {
        console.error('[Workspace Decision Error] Failed to get selection from public workspace:', error.response?.data || error.message);
        return 'public';
    }
}


// --- Constants ---
const RESET_WORKSPACE_COMMAND = 'reset workspace';
const WORKSPACE_REDIS_PREFIX = 'workspace:channel:';

// --- Main Slack Event Handler (REVISED) ---
async function handleSlackMessageEvent(event) {
    const userId = event.user;
    const text = event.text?.trim() ?? ''; // Ensure text is a string and trim whitespace
    const channel = event.channel;
    const originalTs = event.ts; // Timestamp of the original message
    const threadTs = event.thread_ts; // Timestamp of the thread (if message is in a thread)

    // 1. Determine if it's a DM channel
    const isDM = channel.startsWith('D');
    console.log(`[Handler] Received message. User: ${userId}, Channel: ${channel} (isDM: ${isDM}), Text: "${text}"`);

    // 2. Define Redis key for storing workspace preference
    const redisKey = `${WORKSPACE_REDIS_PREFIX}${channel}`;

    // 3. Check for Reset Command FIRST (Only if Redis is available)
    if (redisUrl && text.toLowerCase() === RESET_WORKSPACE_COMMAND) {
        console.log(`[Handler] User ${userId} in channel ${channel} requested workspace reset.`);
        if (!isRedisReady) {
            console.warn("Redis not ready, cannot process workspace reset command.");
             try { // Attempt to notify user even if Redis is down
                 await slack.chat.postMessage({
                     channel: channel,
                     thread_ts: isDM ? undefined : threadTs || originalTs,
                     text: "⚠️ Cannot reset workspace right now (database connection issue). Please try again later."
                 });
             } catch (slackError) {
                  console.error("[Slack Error] Failed to post Redis error message to Slack:", slackError.data?.error || slackError.message);
             }
            return; // Stop processing if Redis is needed but down
        }
        try {
            const deletedCount = await redisClient.del(redisKey);
            const replyText = (deletedCount > 0)
                ? "✅ Workspace selection reset for this conversation. I'll determine the best workspace for your next message."
                : "ℹ️ No workspace was previously set for this conversation.";

            await slack.chat.postMessage({
                channel: channel,
                thread_ts: isDM ? undefined : threadTs || originalTs,
                text: replyText
            });
        } catch (redisError) {
            console.error(`[Redis Error] Failed to delete key ${redisKey} during reset:`, redisError);
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: isDM ? undefined : threadTs || originalTs,
                text: "⚠️ There was an error trying to reset the workspace selection."
            });
        }
        return; // Stop processing after handling the reset command
    }

    // 4. Determine the Workspace (Check Redis first, if available)
    let workspace = null;
    let workspaceSource = 'newly_decided';

    if (redisUrl && isRedisReady) { // Only use Redis persistence if it's configured and ready
        try {
            const storedWorkspace = await redisClient.get(redisKey);
            if (storedWorkspace) {
                workspace = storedWorkspace;
                workspaceSource = 'stored';
                console.log(`[Handler] Found stored workspace "${workspace}" for channel ${channel}`);
            }
        } catch (redisError) {
             console.error(`[Redis Error] Failed to get workspace for key ${redisKey}:`, redisError);
             workspaceSource = 'redis_error_fallback'; // Mark that we failed to read, will decide below
        }
    }

    // Decide workspace if not found in Redis or if Redis failed/unavailable
    if (!workspace) {
        console.log(`[Handler] ${workspaceSource === 'redis_error_fallback' ? 'Redis failed, deciding workspace.' : 'No stored workspace found. Deciding...'}`);
        workspace = await decideWorkspace(text);

        if (!workspace) { // Handle case where decideWorkspace might fail unexpectedly
             console.error("[Handler] decideWorkspace returned an unexpected null/undefined value. Falling back to public.");
             workspace = 'public';
             workspaceSource = 'error_fallback';
        } else if (redisUrl && isRedisReady) { // Store it back only if Redis is working and we didn't get 'public' just as a fallback
            console.log(`[Handler] Storing decided workspace "${workspace}" for channel ${channel}`);
            try {
                // Store without TTL, requires manual reset. Add EX for expiration.
                await redisClient.set(redisKey, workspace /*, { EX: 86400 } */); // e.g., EX: 86400 for 24h expiry
                workspaceSource = 'newly_set'; // Mark that we just set it
            } catch (redisError) {
                 console.error(`[Redis Error] Failed to set workspace for key ${redisKey}:`, redisError);
                 workspaceSource = 'redis_error_set_failed'; // Mark that storing failed
            }
        } else {
            // If Redis isn't available/working, mark source accordingly
             workspaceSource = 'no_redis_fallback';
        }
    }

     console.log(`[Handler] Using workspace: ${workspace} (Source: ${workspaceSource})`);

    // 5. Send "Thinking" message
    let thinkingMessageTs = null;
    let thinkingText = ':hourglass_flowing_sand: DeepOrbit is thinking...';
    if (workspaceSource === 'stored' || workspaceSource === 'newly_set') { // Notify if using stored OR newly set workspace
        thinkingText += `\n*(Workspace: ${workspace})*`;
    }
    const replyTarget = isDM ? undefined : (threadTs || originalTs);

    try {
        const thinkingMsg = await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: thinkingText
        });
        thinkingMessageTs = thinkingMsg.ts;
    } catch (slackError) {
        console.error("[Slack Error] Failed to post 'thinking' message:", slackError.data?.error || slackError.message);
    }

    // Add message indicating workspace was newly set (only if Redis worked)
    if (workspaceSource === 'newly_set') {
         try {
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `ℹ️ Workspace set to *${workspace}* for this conversation.` + (redisUrl ? ` Type \`${RESET_WORKSPACE_COMMAND}\` to reset.` : '')
            });
         } catch (slackError) {
            console.warn("[Slack Error] Failed to post 'workspace set' notification:", slackError.data?.error || slackError.message);
         }
    }

    // 6. Query the chosen LLM workspace
    try {
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${workspace}/chat`, {
            message: text,
            mode: 'chat',
            sessionId: userId,
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 30000,
        });

        const reply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';

        // 7. Send final response back to Slack
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: reply
        });

        // 8. Clean up "thinking" message
        if (thinkingMessageTs) {
            await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed to delete 'thinking' message:", delErr.data?.error || delErr.message));
        }

    } catch (error) {
        console.error(`[LLM Error - Workspace: ${workspace}]`, error.response?.data || error.message);
        try {
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: '⚠️ DeepOrbit encountered an internal error trying to process your request. Please try again later or contact the administrator.'
            });
            if (thinkingMessageTs) {
                await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed to delete 'thinking' message after error:", delErr.data?.error || delErr.message));
            }
        } catch (slackError) {
             console.error("[Slack Error] Failed to post LLM error message to Slack:", slackError.data?.error || slackError.message);
        }
    }
}


// --- Express App Setup ---
app.use('/slack/events', slackEvents.requestListener());
app.use(express.urlencoded({ extended: true })); // Useful for some Slack interactions


// --- Slack Event Listeners ---
slackEvents.on('message', async (event, body) => {
    const eventId = body?.event_id;
    console.log(`[Event Received] Type: message, Event ID: ${eventId}, User: ${event.user}, Channel: ${event.channel}`);

    // 1. Duplicate Check (Only works reliably if Redis is configured and connected)
    if (await isDuplicateRedis(eventId)) {
        console.log(`[Duplicate] Skipping event: ${eventId}`);
        return;
    }

    // 2. Ignore irrelevant messages
    const subtype = event.subtype;
    if (subtype === 'bot_message' || subtype === 'message_deleted' || subtype === 'message_changed' || subtype === 'channel_join' || subtype === 'channel_leave' || !event.user || !event.text?.trim()) { // Ignore messages without text
        console.log(`[Skipping Event] Subtype: ${subtype || 'no user/text'}`);
        return;
    }

    // 3. Handle the message asynchronously
    handleSlackMessageEvent(event).catch(err => {
        console.error("[Unhandled Handler Error]", err);
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
    // Report Redis status based on the tracked flag (requires redisUrl to be set)
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
             console.log(`🕒 Current Time: ${new Date().toLocaleString('en-EG', { timeZone: 'Africa/Cairo' })} (EET/Egypt Time)`); // Added time log
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
})();

// --- Graceful Shutdown ---
async function shutdown(signal) {
    console.log(`${signal} signal received: closing connections and shutting down.`);
    if (redisClient?.isOpen) { // Check if client exists and is connected/open
        try {
            await redisClient.quit();
            console.log('Redis connection closed gracefully.');
        } catch(err) {
            console.error('Error closing Redis connection:', err);
        }
    }
    // Exit process after attempting cleanup
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

```