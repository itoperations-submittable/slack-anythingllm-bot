// index.js
// Version using LLM for Simplicity Check + Increased Timeouts (Fully Implemented)

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
const botUserId = process.env.SLACK_BOT_USER_ID; // Bot's own User ID
const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
const anythingLLMApiKey = process.env.LLM_API_KEY;
const developerId = process.env.DEVELOPER_ID; // Optional: Restrict usage
const redisUrl = process.env.REDIS_URL; // Used for duplicate detection

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
    console.warn("REDIS_URL is not set. Duplicate detection may not work reliably.");
}

// --- Redis Client Setup (for Duplicate Detection) ---
let redisClient;
let isRedisReady = false;
if (redisUrl) {
    redisClient = createClient({
        url: redisUrl,
        socket: { reconnectStrategy: retries => Math.min(retries * 100, 3000) },
    });
    redisClient.on('error', err => { console.error('Redis error:', err); isRedisReady = false; });
    redisClient.on('connect', () => console.log('Redis connecting...'));
    redisClient.on('ready', () => { console.log('Redis connected!'); isRedisReady = true; });
    redisClient.on('end', () => { console.log('Redis connection closed.'); isRedisReady = false; });
    redisClient.connect().catch(err => console.error("Initial Redis connection failed:", err));
} else {
    // Dummy client if Redis isn't configured
    redisClient = {
        isReady: false,
        set: async () => null, // Only set is used by isDuplicateRedis
        on: () => {}, connect: async () => {}, isOpen: false, quit: async () => {}
    };
    console.warn("Running without Redis connection for duplicate detection.");
}

// --- Slack Clients Setup ---
const slackEvents = createEventAdapter(slackSigningSecret, { includeBody: true });
const slack = new WebClient(slackToken);

// --- Duplicate Event Detection (using Redis) ---
async function isDuplicateRedis(eventId) {
    if (!eventId) { console.warn("isDuplicateRedis: null eventId"); return true; }
    if (!redisUrl) { return false; } // No Redis configured
    if (!isRedisReady) { console.warn('Redis not ready for duplicate check:', eventId); return false; }
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
        console.error('Redis error during duplicate check:', eventId, err);
        // Assume not duplicate on error to avoid dropping messages
        return false;
    }
}

// --- Simple Query Detection (using LLM) ---
async function isQuerySimpleLLM(query) {
    console.log(`[Simplicity Check] Asking LLM if query is simple: "${query}"`);
    if (!query) return false; // Handle empty query

    const classificationPrompt = `Analyze the user query below. Is it a simple social interaction (like a greeting, thanks, how are you), a basic question about the bot's function/capabilities (like 'what can you do?', 'help'), or a general conversational query NOT requiring specific knowledge from a specialized workspace?

Answer ONLY with the word 'true' if it is simple/general, or 'false' if it likely requires specific knowledge.

User Query: "${query}"

Is Simple/General (true or false):`;

    try {
        const startTime = Date.now();
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, { // Using 'public' workspace for classification
            message: classificationPrompt,
            mode: 'chat',
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 15000, // Timeout for classification call (15s)
        });
        const duration = Date.now() - startTime;

        const resultText = response.data?.textResponse?.trim().toLowerCase();
        // Be slightly flexible with boolean parsing
        const isSimple = resultText === 'true';

        console.log(`[Simplicity Check] LLM Result: '${resultText}', Determined Simple: ${isSimple}. Duration: ${duration}ms`);
        return isSimple;

    } catch (error) {
        console.error('[Simplicity Check Error] Failed LLM classification:', error.response?.data || error.message);
        // Fail safe: Assume query is NOT simple if classification fails
        return false;
    }
}


// --- Workspace Decision Logic (Context-Aware) ---
async function decideWorkspace(userQuestion, conversationHistory = "") {
    console.log(`[Workspace Decision] Starting for query: "${userQuestion}" with history.`);
    let availableWorkspaces = [];

    // 1. Get available workspaces
    try {
        console.log(`[Workspace Decision] Fetching available workspaces...`);
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 10000, // 10s timeout for fetching workspace list
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
            return 'public'; // Fallback if list is empty
        }
    } catch (error) {
        console.error('[Workspace Decision Error] Failed fetch workspaces:', error.response?.data || error.message);
        return 'public'; // Fallback if fetch fails
    }

    // 2. Format context-aware prompt for the public/routing workspace
    let selectionPrompt = "Consider the following conversation history (if any):\n";
    selectionPrompt += conversationHistory ? conversationHistory.trim() + "\n\n" : "[No History Provided]\n\n";
    selectionPrompt += `Based on the history (if any) and the latest user query: "${userQuestion}"\n\n`;
    selectionPrompt += `Which workspace slug from this list [${availableWorkspaces.join(', ')}] is the most relevant context to answer the query?\n`;
    selectionPrompt += `Your answer should ONLY be the workspace slug itself, exactly as it appears in the list.`;

    console.log(`[Workspace Decision] Sending context-aware prompt to public workspace.`);

    // 3. Ask the public/routing LLM
    try {
        const startTime = Date.now();
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, {
            message: selectionPrompt,
            mode: 'chat',
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            // *** INCREASED TIMEOUT for routing LLM call ***
            timeout: 35000, // Increased to 35 seconds
        });
        const duration = Date.now() - startTime;
        console.log(`[Workspace Decision] Routing LLM call duration: ${duration}ms`);

        // 4. Extract and validate the chosen slug
        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[Workspace Decision] Raw routing response: "${chosenSlugRaw}"`);
        if (!chosenSlugRaw || typeof chosenSlugRaw !== 'string') {
            console.warn('[Workspace Decision] Public workspace bad routing response.');
            return 'public';
        }
        const chosenSlug = chosenSlugRaw.trim();
        // Check if the response exactly matches one of the slugs
        if (availableWorkspaces.includes(chosenSlug)) {
            console.log(`[Workspace Decision] Context-aware valid slug selected: "${chosenSlug}"`);
            return chosenSlug;
        } else {
            // Fallback check: Try finding a known slug within the response
            const foundSlug = availableWorkspaces.find(slug => chosenSlug.includes(slug));
            if (foundSlug) {
                console.log(`[Workspace Decision] Found valid slug "${foundSlug}" in noisy response "${chosenSlug}".`);
                return foundSlug;
            }
            console.warn(`[Workspace Decision] LLM response "${chosenSlug}" is not a valid slug. Falling back.`);
            return 'public'; // Fallback if validation fails
        }
    } catch (error) {
        console.error('[Workspace Decision Error] Failed query public workspace:', error.response?.data || error.message);
        return 'public'; // Fallback on error
    }
}


// --- Main Slack Event Handler (REVISED with LLM Simplicity Check & Timeout) ---
async function handleSlackMessageEvent(event) {
    const handlerStartTime = Date.now(); // Measure overall handler time
    const userId = event.user;
    const originalText = event.text?.trim() ?? '';
    const channel = event.channel;
    const originalTs = event.ts;
    const threadTs = event.thread_ts;

    // Clean the mention itself from the immediate query text
    let cleanedQuery = originalText;
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = originalText.includes(mentionString);
    if (wasMentioned) {
        cleanedQuery = originalText.replace(mentionString, '').trim();
    }

    const isDM = channel.startsWith('D');
    console.log(`[Handler] Start. User: ${userId}, Chan: ${channel}, isDM: ${isDM}, Mentioned: ${wasMentioned}, Query: "${cleanedQuery}"`);

    // --- Determine Workspace ---
    let workspace = null;
    let conversationHistory = ""; // Initialize history

    // *** LLM-Based Simple Query Check ***
    const isSimple = await isQuerySimpleLLM(cleanedQuery);

    if (isSimple) {
        workspace = 'public';
        console.log(`[Handler] LLM determined query is simple. Routing directly to: ${workspace}`);
        // Skip history fetching and dynamic workspace decision
    } else {
        // Query is NOT simple, proceed with context-aware dynamic routing
        console.log(`[Handler] LLM determined query not simple. Fetching history and deciding workspace dynamically...`);

        // Fetch Conversation History
        const HISTORY_LIMIT = 10; // How many messages to fetch
        if (isDM || wasMentioned) { // Fetch history if relevant for context/routing
            console.log(`[Handler] Fetching history...`);
            try {
                let historyResult;
                if (!isDM && threadTs) { // Mentioned in a channel thread
                    console.log(`[Handler] Fetching thread replies: Channel=${channel}, ThreadTS=${threadTs}`);
                    historyResult = await slack.conversations.replies({
                        channel: channel,
                        ts: threadTs,
                        limit: HISTORY_LIMIT + 1, // Fetch a bit more, filter later
                        // inclusive: false // Consider if you want the thread start message
                    });
                } else { // DM or Mentioned in channel (not thread)
                    console.log(`[Handler] Fetching history: Channel=${channel}, Latest=${originalTs}, isDM=${isDM}`);
                    historyResult = await slack.conversations.history({
                        channel: channel,
                        latest: originalTs, // Fetch messages strictly BEFORE this one
                        limit: HISTORY_LIMIT,
                        inclusive: false
                    });
                }

                if (historyResult.ok && historyResult.messages) {
                    const relevantMessages = historyResult.messages
                        // Filter out messages without user/text, and messages from the bot itself
                        .filter(msg => msg.user && msg.text && msg.user !== botUserId)
                        .reverse(); // Arrange oldest to newest for prompt context

                    if (relevantMessages.length > 0) {
                        conversationHistory = "Conversation History:\n"; // Assign to the existing variable
                        relevantMessages.forEach(msg => {
                            // Basic formatting, could fetch user names if needed (adds latency)
                            conversationHistory += `User ${msg.user}: ${msg.text}\n`;
                        });
                         console.log(`[Handler] Fetched ${relevantMessages.length} relevant history messages.`);
                    } else { console.log("[Handler] No relevant prior messages found in history."); }
                } else { console.warn("[Handler] Failed fetch history:", historyResult.error || "No messages found"); }
            } catch (historyError) {
                console.error("[Slack History Error]", historyError.message);
                // Keep conversationHistory = "" if error occurs
            }
        }

        // Decide Workspace Dynamically (using history if fetched)
        workspace = await decideWorkspace(cleanedQuery, conversationHistory);
        console.log(`[Handler] Dynamically decided workspace: ${workspace}`);
    }
    // --- End Workspace Determination ---

    // Construct the Input for the Final LLM call
    let llmInputText = "";
    if (conversationHistory) { // Check if history was successfully fetched and formatted
        llmInputText += conversationHistory.trim() + "\n\n";
        llmInputText += `Based on the conversation history above and your knowledge, answer the following query:\n`;
    }
    llmInputText += `User Query: ${cleanedQuery}`; // Append the user's actual query

    console.log(`[Handler] Sending input to LLM workspace ${workspace}...`); // Avoid logging full input

    // Send "Thinking" message
    let thinkingMessageTs = null;
    const replyTarget = isDM ? undefined : (threadTs || originalTs); // Reply in thread if appropriate
    try {
        const thinkingMsg = await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `:hourglass_flowing_sand: DeepOrbit is thinking... (Workspace: ${workspace})` // Show dynamically chosen workspace
        });
        thinkingMessageTs = thinkingMsg.ts;
    } catch (slackError) {
         console.error("[Slack Error] Failed post 'thinking':", slackError.data?.error || slackError.message);
    }

    // Query the chosen LLM workspace
    try {
        const llmStartTime = Date.now();
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${workspace}/chat`, {
            message: llmInputText, // Use the combined history + query input
            mode: 'chat',
            sessionId: userId, // Keep for LLM's potential internal state tracking
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            // *** INCREASED TIMEOUT for final LLM call ***
            timeout: 90000, // 90 seconds
        });
        const llmDuration = Date.now() - llmStartTime;
        console.log(`[Handler] Final LLM call duration: ${llmDuration}ms`);

        const reply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';

        // Send final response back to Slack
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: reply
            // Add feedback blocks here later
        });

        // Clean up "thinking" message
        if (thinkingMessageTs) {
            await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed delete 'thinking':", delErr.data?.error || delErr.message));
        }

    } catch (error) {
        console.error(`[LLM Error - Workspace: ${workspace}]`, error.response?.data || error.message);
        try {
            // Send error message to Slack
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: '⚠️ DeepOrbit encountered an internal error processing your request.'
            });
            // Clean up thinking message even on error
            if (thinkingMessageTs) {
                await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed delete 'thinking' after error:", delErr.data?.error || delErr.message));
            }
        } catch (slackError) {
             console.error("[Slack Error] Failed post LLM error msg:", slackError.data?.error || slackError.message);
        }
    } finally {
        const handlerEndTime = Date.now();
        console.log(`[Handler] Finished processing event for ${userId}. Total duration: ${handlerEndTime - handlerStartTime}ms`); // Log total time
    }
}

// --- Express App Setup ---
app.use('/slack/events', slackEvents.requestListener());
app.use(express.urlencoded({ extended: true }));

// --- Slack Event Listeners ---
slackEvents.on('message', async (event, body) => {
    const eventId = body?.event_id;

    // 1. Duplicate Check
    if (await isDuplicateRedis(eventId)) { return; }

    // 2. Filter irrelevant messages (including self-replies)
    const subtype = event.subtype;
    const messageUserId = event.user;
    const channelId = event.channel;
    const text = event.text?.trim() ?? '';

    if (
        subtype === 'bot_message' || subtype === 'message_deleted' || subtype === 'message_changed' ||
        subtype === 'channel_join' || subtype === 'channel_leave' || subtype === 'thread_broadcast' ||
        !messageUserId || !text || messageUserId === botUserId
    ) { return; }

    // 3. Mention Check & Processing Logic
    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);

    if (isDM || wasMentioned) { // Process only DMs or channel mentions
        console.log(`[Processing Event] ID: ${eventId}, User: ${messageUserId}, Channel: ${channelId}, isDM: ${isDM}, Mentioned: ${wasMentioned}`);
        // Call handler asynchronously, don't await here
        handleSlackMessageEvent(event).catch(err => {
            console.error("[Unhandled Handler Error] Event ID:", eventId, err);
        });
    } else { return; } // Ignore non-DM, non-mention channel messages
});

// Generic error handler for the adapter
slackEvents.on('error', (error) => {
    console.error('[SlackEvents Adapter Error]', error.name, error.code || '', error.message);
    if (error.request) { console.error('[SlackEvents Adapter Error] Request:', error.request.method, error.request.url); }
    if (error.code === '@slack/events-api:adapter:signatureVerificationFailure') { console.error('[FATAL] Slack signature verification failed!'); }
    else if (error.code === '@slack/events-api:adapter:requestTimeTooSkewed') { console.error('[FATAL] Slack request timestamp too skewed.'); }
});

// --- Basic Health Check Route ---
app.get('/', (req, res) => {
    const redisStatus = redisUrl ? (isRedisReady ? 'Ready' : 'Not Ready/Connecting/Error') : 'Not Configured';
    res.send(`DeepOrbit is live 🎯 Redis Status (for Duplicates): ${redisStatus}`);
});

// --- Start Server ---
(async () => {
    try {
        app.listen(port, () => {
            console.log(`🚀 DeepOrbit running on port ${port}`);
            if (developerId) { console.log(`🔒 Bot restricted to developer ID: ${developerId}`); }
            else { console.log(`🔓 Bot is not restricted to a specific developer.`); }
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
    if (redisClient?.isOpen) { // Check if client exists and is connected/open
        try {
            await redisClient.quit();
            console.log('Redis connection closed gracefully.');
        } catch(err) {
            console.error('Error closing Redis connection:', err);
        }
    }
    // Allow time for cleanup before exiting
    setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));