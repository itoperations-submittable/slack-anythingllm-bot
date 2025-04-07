```javascript
// index.js

import express from 'express';
import { createEventAdapter } from '@slack/events-api';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import { WebClient } from '@slack/web-api';
// body-parser is not strictly needed if using the Event Adapter or express.json
// import bodyParser from 'body-parser';
// crypto is handled by the Event Adapter
// import crypto from 'crypto';

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
    console.warn("REDIS_URL is not set. Duplicate detection will not work across restarts or multiple instances.");
    // Potentially exit or implement an in-memory fallback if Redis is critical
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
    // Create a dummy client if no URL is provided to avoid errors, or handle differently
    redisClient = {
        isReady: false,
        set: async () => null, // Mock methods used
        on: () => {},
        connect: async () => {}
    };
    console.warn("Running without Redis connection.");
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
        return true; // Treat as duplicate to prevent processing potentially bad data
    }
    if (!isRedisReady) { // Check our tracked ready state
        console.warn('Redis not ready, cannot check for duplicate event:', eventId);
        // Fail-safe: Treat as NOT duplicate if Redis is down, but log it.
        // Alternatively, you could implement a temporary in-memory Set here as a fallback.
        return false;
    }
    try {
        // Try to set the key with an expiration of 60 seconds (adjust as needed)
        // NX ensures it only sets if the key doesn't exist
        const result = await redisClient.set(eventId, 'processed', {
            EX: 60, // Expires after 60 seconds
            NX: true // Only set if key does not exist
        });

        // If result is null, the key already existed (it's a duplicate)
        return result === null;
    } catch (err) {
        console.error('Redis error during duplicate check for event', eventId, err);
        // If Redis fails, assume it's NOT a duplicate to avoid dropping messages, but log error.
        return false;
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

        // Parse slugs based on confirmed structure
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
            return 'public'; // Fallback if no workspaces listed
        }

    } catch (error) {
        console.error('[Workspace Decision Error] Failed to fetch workspaces:', error.response?.data || error.message);
        return 'public'; // Fallback if fetching fails
    }

    // 2. Format prompt for the public workspace
    const selectionPrompt = `Given the user question: "${userQuestion}", what would be the most relevant workspace slug from this list [${availableWorkspaces.join(', ')}] to send that question to? Your answer should ONLY be the workspace slug itself, exactly as it appears in the list.`;
    console.log(`[Workspace Decision] Sending prompt to public workspace.`); // Avoid logging potentially long prompt

    // 3. Ask the public workspace for the best slug
    try {
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, {
            message: selectionPrompt,
            mode: 'chat',
            // sessionId: `decision-${Date.now()}` // Optional: Separate session ID for meta-queries
        }, {
            headers: {
                Authorization: `Bearer ${anythingLLMApiKey}`,
            },
            timeout: 15000, // 15 second timeout for LLM decision
        });

        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[Workspace Decision] Raw response from public workspace: "${chosenSlugRaw}"`);

        if (!chosenSlugRaw || typeof chosenSlugRaw !== 'string') {
            console.warn('[Workspace Decision] Public workspace did not return a valid text response for selection.');
            return 'public'; // Fallback
        }

        // 4. Extract and validate the chosen slug
        const chosenSlug = chosenSlugRaw.trim();

        if (availableWorkspaces.includes(chosenSlug)) {
            console.log(`[Workspace Decision] Valid slug selected: "${chosenSlug}"`);
            return chosenSlug;
        } else {
             // Fallback check: try finding slug within response string
            const foundSlug = availableWorkspaces.find(slug => chosenSlug.includes(slug));
            if (foundSlug) {
                console.log(`[Workspace Decision] Found valid slug "${foundSlug}" within potentially noisy response "${chosenSlug}". Using it.`);
                return foundSlug;
            }
            console.warn(`[Workspace Decision] LLM response "${chosenSlug}" is not a valid slug from the list: [${availableWorkspaces.join(', ')}]. Falling back to public.`);
            return 'public'; // Fallback if validation fails
        }

    } catch (error) {
        console.error('[Workspace Decision Error] Failed to get selection from public workspace:', error.response?.data || error.message);
        return 'public'; // Fallback if selection fails
    }
}


// --- Main Slack Event Handler ---
async function handleSlackMessageEvent(event) {
    const userId = event.user;
    const text = event.text;
    const threadTs = event.thread_ts || event.ts; // Use thread_ts if available, otherwise original ts
    const channel = event.channel;

    // 1. Authorization Check (Early)
    if (developerId && userId !== developerId) {
        console.log(`[Auth] User ${userId} is not the authorized developer (${developerId}). Ignoring message.`);
        // Optionally send a message back, but often better to just ignore silently
        // await slack.chat.postMessage({ channel, thread_ts: threadTs, text: "Sorry, I can only respond to my developer right now." });
        return;
    }

    // 2. Send "Thinking" message (only if authorized)
    let thinkingMessageTs = null; // Store the timestamp if we want to update/delete later
    try {
        const thinkingMsg = await slack.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: ':hourglass_flowing_sand: DeepOrbit is thinking...'
        });
        thinkingMessageTs = thinkingMsg.ts; // Save timestamp
    } catch (slackError) {
        console.error("[Slack Error] Failed to post 'thinking' message:", slackError);
        // Proceed anyway, but log the error
    }


    // 3. Decide on the workspace
    const workspace = await decideWorkspace(text);
    console.log(`[Handler] Using workspace: ${workspace} for user ${userId}`);

    // 4. Query the chosen LLM workspace
    try {
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${workspace}/chat`, {
            message: text, // Send the original user question
            mode: 'chat',
            sessionId: userId, // Use user ID as session ID for conversation history (if LLM supports it)
        }, {
            headers: {
                Authorization: `Bearer ${anythingLLMApiKey}`,
            },
            timeout: 30000, // 30 second timeout for the main LLM response
        });

        const reply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';

        // 5. Send final response back to Slack
        await slack.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: reply
        });

        // Optional: Delete the "thinking" message now that we have a reply
        if (thinkingMessageTs) {
             await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed to delete 'thinking' message:", delErr.data?.error || delErr.message));
        }

    } catch (error) {
        console.error(`[LLM Error - Workspace: ${workspace}]`, error.response?.data || error.message);
        // Send error message back to Slack
        try {
            await slack.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: '⚠️ DeepOrbit encountered an internal error trying to process your request. Please try again later or contact the administrator.'
            });
             // Optional: Delete the "thinking" message on error too
            if (thinkingMessageTs) {
                await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed to delete 'thinking' message after error:", delErr.data?.error || delErr.message));
            }
        } catch (slackError) {
             console.error("[Slack Error] Failed to post error message to Slack:", slackError);
        }
    }
}


// --- Express App Setup ---

// Mount the event adapter middleware BEFORE any general body parsers if you add them
// The adapter handles its own parsing and verification for the /slack/events route
app.use('/slack/events', slackEvents.requestListener());

// Optional: Add express.json() if you have other JSON endpoints
// app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Useful for some Slack interactions


// --- Slack Event Listeners ---
slackEvents.on('message', async (event, body) => {
    // body.event_id is needed for duplicate check
    const eventId = body?.event_id;
    console.log(`[Event Received] Type: message, Event ID: ${eventId}, User: ${event.user}, Channel: ${event.channel}`);

    // 1. Duplicate Check
    if (await isDuplicateRedis(eventId)) {
        console.log(`[Duplicate] Skipping event: ${eventId}`);
        return; // Adapter handles ACK, just return
    }

    // 2. Ignore irrelevant messages (bots, channel joins, etc.)
    // Check for common subtypes to ignore. Add more as needed.
    const subtype = event.subtype;
    if (subtype === 'bot_message' || subtype === 'message_deleted' || subtype === 'message_changed' || subtype === 'channel_join' || subtype === 'channel_leave' || !event.user) {
        console.log(`[Skipping Event] Subtype: ${subtype || 'no user'}`);
        return;
    }

    // 3. Handle the message asynchronously
    // No need to await here; let it run in the background after ACK
    handleSlackMessageEvent(event).catch(err => {
        // Catch unexpected errors from the handler itself
        console.error("[Unhandled Handler Error]", err);
    });
});

// Generic error handler for the adapter
slackEvents.on('error', (error) => {
    console.error('[SlackEvents Adapter Error]', error.name, error.code || '', error.message);
    if (error.request) { // Log details if it's a request-related error
         console.error('[SlackEvents Adapter Error] Request:', error.request.method, error.request.url);
    }
    // Log specific errors like signature verification failure
    if (error.code === '@slack/events-api:adapter:signatureVerificationFailure') {
        console.error('[FATAL] Slack signature verification failed! Check SLACK_SIGNING_SECRET.');
    } else if (error.code === '@slack/events-api:adapter:requestTimeTooSkewed') {
        console.error('[FATAL] Slack request timestamp too skewed. Check server time.');
    }
});


// --- Basic Health Check Route ---
app.get('/', (req, res) => {
    res.send(`DeepOrbit is live 🎯 Redis Ready: ${isRedisReady}`);
});


// --- Start Server ---
(async () => {
    try {
        // Optional: Wait for Redis connection if it's absolutely critical before starting
        // if (redisUrl) {
        //     console.log("Waiting for Redis connection before starting server...");
        //     // Note: redisClient.connect() might have already been called.
        //     // This is a simple ready check loop; consider a more robust approach if needed.
        //     while (!isRedisReady) {
        //         await new Promise(resolve => setTimeout(resolve, 500));
        //     }
        //     console.log("Redis connected. Starting server.");
        // }

        app.listen(port, () => {
            console.log(`🚀 DeepOrbit running on port ${port}`);
            if (developerId) {
                console.log(`🔒 Bot restricted to developer ID: ${developerId}`);
            } else {
                 console.log(`🔓 Bot is not restricted to a specific developer.`);
            }
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing Redis connection and shutting down HTTP server.');
    if (redisClient?.isOpen) { // Check if client exists and is open
        await redisClient.quit();
        console.log('Redis connection closed.');
    }
    // Express server shutdown handled automatically by Node process exit
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing Redis connection and shutting down HTTP server.');
     if (redisClient?.isOpen) {
        await redisClient.quit();
        console.log('Redis connection closed.');
    }
    process.exit(0);
});
```