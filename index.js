// index.js
// Version with full filter implementation, "Sphere" terminology, LLM Simplicity Check, Reset Conversation, Increased Timeouts

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
const redisUrl = process.env.REDIS_URL; // Used for duplicate detection and reset state

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
    console.warn("REDIS_URL is not set. Duplicate detection and 'reset conversation' may not work reliably.");
}

// --- Redis Client Setup ---
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
        set: async () => null, get: async() => null, del: async() => 0,
        on: () => {}, connect: async () => {}, isOpen: false, quit: async () => {}
    };
    console.warn("Running without Redis connection. 'reset conversation' command will not function.");
}

// --- Slack Clients Setup ---
const slackEvents = createEventAdapter(slackSigningSecret, { includeBody: true });
const slack = new WebClient(slackToken);

// --- Duplicate Event Detection (using Redis) ---
async function isDuplicateRedis(eventId) {
    if (!eventId) { console.warn("isDuplicateRedis: null eventId"); return true; }
    if (!redisUrl || !isRedisReady) { return false; } // Cannot check if Redis isn't ready/configured
    try {
        const result = await redisClient.set(eventId, 'processed', { EX: 60, NX: true });
        return result === null; // True if duplicate (already existed)
    } catch (err) {
        console.error('Redis error during duplicate check:', eventId, err);
        return false; // Assume not duplicate on error
    }
}

// --- Simple Query Detection (using LLM) ---
async function isQuerySimpleLLM(query) {
    console.log(`[Simplicity Check] Asking LLM if query is simple: "${query}"`);
    if (!query) return false;
    const classificationPrompt = `Analyze the user query below. Is it a simple social interaction (like a greeting, thanks, how are you), a basic question about the bot's function/capabilities (like 'what can you do?', 'help'), or a general conversational query NOT requiring specific knowledge from a specialized knowledge base? Answer ONLY with the word 'true' if it is simple/general, or 'false' if it likely requires specific knowledge. User Query: "${query}" Is Simple/General (true or false):`;
    try {
        const startTime = Date.now();
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`,
            { message: classificationPrompt, mode: 'chat' },
            { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 15000 } // 15s timeout
        );
        const duration = Date.now() - startTime;
        const resultText = response.data?.textResponse?.trim().toLowerCase();
        const isSimple = resultText === 'true';
        console.log(`[Simplicity Check] LLM Result: '${resultText}', Simple: ${isSimple}. Duration: ${duration}ms`);
        return isSimple;
    } catch (error) {
        console.error('[Simplicity Check Error] Failed LLM classification:', error.response?.data || error.message);
        return false; // Assume not simple on error
    }
}

// --- Sphere Decision Logic (Context-Aware - Formerly decideWorkspace/decideSector) ---
async function decideSphere(userQuestion, conversationHistory = "") {
    console.log(`[Sphere Decision] Starting for query: "${userQuestion}" with history.`);
    let availableWorkspaces = []; // API response field name is still 'workspaces'

    // 1. Get available workspaces/spheres
    try {
        console.log(`[Sphere Decision] Fetching available knowledge spheres (workspaces)...`);
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 10000,
        });
        if (response.data && Array.isArray(response.data.workspaces)) {
            availableWorkspaces = response.data.workspaces
                .map(ws => ws.slug) // Still extracting the 'slug'
                .filter(slug => slug && typeof slug === 'string');
            console.log(`[Sphere Decision] Found slugs: ${availableWorkspaces.join(', ')}`);
        } else { throw new Error('Could not parse workspace list.'); }
        if (availableWorkspaces.length === 0) { console.warn('[Sphere Decision] No slugs found.'); return 'public'; }
    } catch (error) { console.error('[Sphere Decision Error] Fetch failed:', error.response?.data || error.message); return 'public'; }

    // 2. Format context-aware prompt for the public/routing LLM
    let selectionPrompt = "Consider the following conversation history (if any):\n";
    selectionPrompt += conversationHistory ? conversationHistory.trim() + "\n\n" : "[No History Provided]\n\n";
    selectionPrompt += `Based on the history (if any) and the latest user query: "${userQuestion}"\n\n`;
    selectionPrompt += `Which knowledge sphere (represented by a workspace slug) from this list [${availableWorkspaces.join(', ')}] is the most relevant context to answer the query?\n`;
    selectionPrompt += `Your answer should ONLY be the workspace slug itself, exactly as it appears in the list.`;

    console.log(`[Sphere Decision] Sending context-aware prompt to public routing.`);

    // 3. Ask the public/routing LLM
    try {
        const startTime = Date.now();
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, {
            message: selectionPrompt, mode: 'chat',
        }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 35000 }); // Routing timeout (35s)
        const duration = Date.now() - startTime;
        console.log(`[Sphere Decision] Routing LLM call duration: ${duration}ms`);

        // 4. Extract and validate the chosen slug
        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[Sphere Decision] Raw routing response: "${chosenSlugRaw}"`);
        if (!chosenSlugRaw || typeof chosenSlugRaw !== 'string') { console.warn('[Sphere Decision] Bad routing response.'); return 'public';}
        const chosenSlug = chosenSlugRaw.trim();
        if (availableWorkspaces.includes(chosenSlug)) {
            console.log(`[Sphere Decision] Context-aware valid slug selected: "${chosenSlug}"`);
            return chosenSlug; // Return the slug (internal identifier)
        } else {
            const foundSlug = availableWorkspaces.find(slug => chosenSlug.includes(slug));
            if (foundSlug) { console.log(`[Sphere Decision] Found valid slug "${foundSlug}" in noisy response.`); return foundSlug; }
            console.warn(`[Sphere Decision] Invalid slug "${chosenSlug}". Falling back.`); return 'public';
        }
    } catch (error) { console.error('[Sphere Decision Error] Failed query public:', error.response?.data || error.message); return 'public'; }
}

// --- Constants ---
const RESET_CONVERSATION_COMMAND = 'reset conversation';
const RESET_HISTORY_REDIS_PREFIX = 'reset_history:channel:';
const RESET_HISTORY_TTL = 300; // 5 minutes in seconds

// --- Main Slack Event Handler ---
async function handleSlackMessageEvent(event) {
    const handlerStartTime = Date.now();
    const userId = event.user;
    const originalText = event.text?.trim() ?? '';
    const channel = event.channel;
    const originalTs = event.ts;
    const threadTs = event.thread_ts;

    let cleanedQuery = originalText;
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = originalText.includes(mentionString);
    if (wasMentioned) { cleanedQuery = originalText.replace(mentionString, '').trim(); }

    const isDM = channel.startsWith('D');
    const replyTarget = isDM ? undefined : (threadTs || originalTs);

    console.log(`[Handler] Start. User: ${userId}, Chan: ${channel}, isDM: ${isDM}, Mentioned: ${wasMentioned}, Query: "${cleanedQuery}"`);

    // Check for Reset Conversation Command
    if (originalText.toLowerCase() === RESET_CONVERSATION_COMMAND) {
        console.log(`[Handler] User ${userId} requested conversation reset in ${channel}.`);
        if (redisUrl && isRedisReady) {
            try {
                const resetKey = `${RESET_HISTORY_REDIS_PREFIX}${channel}`;
                await redisClient.set(resetKey, 'true', { EX: RESET_HISTORY_TTL });
                console.log(`[Handler] Set reset flag ${resetKey} with TTL ${RESET_HISTORY_TTL}s.`);
                await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "✅ Conversation context will be ignored for your next message." });
            } catch (redisError) {
                console.error(`[Redis Error] Failed set reset flag for ${channel}:`, redisError);
                await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "⚠️ Error setting conversation reset flag." });
            }
        } else {
            console.warn("[Handler] Cannot process reset: Redis unavailable.");
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "⚠️ Cannot reset conversation context (feature unavailable)." });
        }
        return; // Stop processing
    }

    // Post Initial Processing Message
    let thinkingMessageTs = null;
    try {
        const initialMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: ":hourglass_flowing_sand: DeepOrbit is processing..." });
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Handler] Posted initial processing message (ts: ${thinkingMessageTs}).`);
    } catch (slackError) { console.error("[Slack Error] Failed post initial 'processing':", slackError.data?.error || slackError.message); }

    // Check if History Reset Was Requested for this interaction
    let skipHistory = false;
    if (redisUrl && isRedisReady) {
        const resetKey = `${RESET_HISTORY_REDIS_PREFIX}${channel}`;
        try {
            // Use GET and DEL in a transaction or check then delete
            const resetFlag = await redisClient.get(resetKey);
            if (resetFlag === 'true') {
                console.log(`[Handler] Reset flag found for ${channel}. Skipping history.`);
                skipHistory = true;
                await redisClient.del(resetKey); // Delete flag after reading
                 console.log(`[Handler] Deleted reset flag ${resetKey}.`);
            }
        } catch(redisError) { console.error(`[Redis Error] Failed check/delete reset flag ${resetKey}:`, redisError); }
    }

    // Determine Target Sphere
    let sphere = null;
    let conversationHistory = "";

    // LLM-Based Simple Query Check
    const isSimple = await isQuerySimpleLLM(cleanedQuery);

    if (isSimple) {
        sphere = 'public';
        console.log(`[Handler] LLM determined query is simple. Routing directly to Sphere: ${sphere}`);
        skipHistory = true; // Ensure history is skipped if simple
    } else {
        console.log(`[Handler] Query not simple. Potentially fetching history and deciding sphere...`);
        // Fetch Conversation History (Only if not simple AND reset not requested)
        const HISTORY_LIMIT = 10;
        if (!skipHistory && (isDM || wasMentioned)) {
             console.log(`[Handler] Fetching history...`);
             try {
                 let historyResult;
                 if (!isDM && threadTs) { // Thread history
                     historyResult = await slack.conversations.replies({ channel, ts: threadTs, limit: HISTORY_LIMIT + 1});
                 } else { // Channel/DM history
                     historyResult = await slack.conversations.history({ channel, latest: originalTs, limit: HISTORY_LIMIT, inclusive: false });
                 }
                 if (historyResult.ok && historyResult.messages) {
                     const relevantMessages = historyResult.messages.filter(msg => msg.user && msg.text && msg.user !== botUserId).reverse();
                     if (relevantMessages.length > 0) {
                         conversationHistory = "Conversation History:\n";
                         relevantMessages.forEach(msg => { conversationHistory += `User ${msg.user}: ${msg.text}\n`; });
                          console.log(`[Handler] Fetched ${relevantMessages.length} history messages.`);
                     } else { console.log("[Handler] No relevant history messages found."); }
                 } else { console.warn("[Handler] Failed fetch history:", historyResult.error || "No messages"); }
             } catch (historyError) { console.error("[Slack History Error]", historyError); }
        } else if (skipHistory) { console.log(`[Handler] Skipping history fetch due to reset request.`); }

        // Decide Sphere Dynamically
        sphere = await decideSphere(cleanedQuery, conversationHistory);
        console.log(`[Handler] Dynamically decided Sphere: ${sphere}`);
    }

    // Update Thinking Message with Sphere Info
    if (thinkingMessageTs) {
        try {
            await slack.chat.update({
                channel: channel, ts: thinkingMessageTs,
                text: `:hourglass_flowing_sand: DeepOrbit is thinking... (Sphere: ${sphere})`
            });
             console.log(`[Handler] Updated thinking message (ts: ${thinkingMessageTs}) with Sphere: ${sphere}.`);
        } catch (updateError) { console.warn(`[Handler] Failed update thinking message:`, updateError.data?.error || updateError.message); }
    }

    // Construct the Input for the Final LLM call
    let llmInputText = "";
    if (conversationHistory && !skipHistory) { // Only add history if it exists AND wasn't skipped
        llmInputText += conversationHistory.trim() + "\n\n";
        llmInputText += `Based on the conversation history above and your knowledge, answer the following query:\n`;
    } else if (skipHistory && conversationHistory) { // Log if history existed but was skipped
         console.log("[Handler] History omitted from final LLM prompt due to reset request.");
    }
    llmInputText += `User Query: ${cleanedQuery}`;
    console.log(`[Handler] Sending input to LLM Sphere ${sphere}...`);

    // Query the chosen LLM Sphere (API endpoint still uses 'workspace')
    try {
        const llmStartTime = Date.now();
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/chat`, {
            message: llmInputText, mode: 'chat', sessionId: userId,
        }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 90000 }); // 90s final timeout
        const llmDuration = Date.now() - llmStartTime;
        console.log(`[Handler] Final LLM call duration: ${llmDuration}ms`);

        const reply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: reply });

    } catch (error) {
        console.error(`[LLM Error - Sphere: ${sphere}]`, error.response?.data || error.message);
        try { await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: '⚠️ DeepOrbit encountered an internal error.' }); }
        catch (slackError) { console.error("[Slack Error] Failed post LLM error msg:", slackError.data?.error || slackError.message); }
    } finally {
        // Clean up the thinking message
        if (thinkingMessageTs) {
            try { await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }); console.log(`[Handler] Deleted thinking message (ts: ${thinkingMessageTs}).`); }
            catch (delErr) { console.warn("Failed delete thinking message:", delErr.data?.error || delErr.message); }
        }
        const handlerEndTime = Date.now();
        console.log(`[Handler] Finished processing event for ${userId}. Total duration: ${handlerEndTime - handlerStartTime}ms`);
    }
}

// --- Express App Setup ---
app.use('/slack/events', slackEvents.requestListener());
app.use(express.urlencoded({ extended: true }));

// --- Slack Event Listeners ---
slackEvents.on('message', async (event, body) => {
    const eventId = body?.event_id;
    if (await isDuplicateRedis(eventId)) { return; }

    // --- Fully Expanded Filter ---
    const subtype = event.subtype;
    const messageUserId = event.user;
    const channelId = event.channel;
    const text = event.text?.trim() ?? '';

    if (
        subtype === 'bot_message' ||
        subtype === 'message_deleted' ||
        subtype === 'message_changed' ||
        subtype === 'channel_join' ||
        subtype === 'channel_leave' ||
        subtype === 'thread_broadcast' || // Ignore thread replies broadcast to channel
        !messageUserId || // Ignore messages without a user ID
        !text || // Ignore messages without actual text content
        messageUserId === botUserId // CRITICAL: Ignore messages sent by the bot itself
    ) {
        // console.log(`[Skipping Event] Reason: Subtype=${subtype}, User=${messageUserId}, IsBot=${messageUserId === botUserId}, NoText=${!text}`);
        return; // Stop processing this event
    }
    // --- End Expanded Filter ---

    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);

    if (isDM || wasMentioned) { // Process only DMs or channel mentions
        console.log(`[Processing Event] ID: ${eventId}, User: ${messageUserId}, Channel: ${channelId}, isDM: ${isDM}, Mentioned: ${wasMentioned}`);
        handleSlackMessageEvent(event).catch(err => { console.error("[Unhandled Handler Error] Event ID:", eventId, err); });
    } else { return; } // Ignore non-DM, non-mention channel messages
});

slackEvents.on('error', (error) => {
    console.error('[SlackEvents Adapter Error]', error.name, error.code || '', error.message);
    if (error.request) { console.error('Request:', error.request.method, error.request.url); }
    if (error.code === '@slack/events-api:adapter:signatureVerificationFailure') { console.error('[FATAL] Slack signature verification failed!'); }
    else if (error.code === '@slack/events-api:adapter:requestTimeTooSkewed') { console.error('[FATAL] Slack request timestamp too skewed.'); }
});

// --- Basic Health Check Route ---
app.get('/', (req, res) => {
    const redisStatus = redisUrl ? (isRedisReady ? 'Ready' : 'Not Ready/Error') : 'Not Configured';
    res.send(`DeepOrbit is live 🛰️ Redis Status: ${redisStatus}`);
});

// --- Start Server ---
(async () => {
    try {
        app.listen(port, () => {
            console.log(`🚀 DeepOrbit running on port ${port}`);
            if (developerId) { console.log(`🔒 Bot restricted to developer ID: ${developerId}`); }
            else { console.log(`🔓 Bot is not restricted.`); }
            console.log(`🕒 Current Time: ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' })} (Cairo Time)`);
        });
    } catch (error) { console.error("Failed to start server:", error); process.exit(1); }
})();

// --- Graceful Shutdown ---
async function shutdown(signal) {
    console.log(`${signal} signal received: closing connections and shutting down.`);
    if (redisClient?.isOpen) {
        try { await redisClient.quit(); console.log('Redis connection closed gracefully.'); }
        catch(err) { console.error('Error closing Redis connection:', err); }
    }
    setTimeout(() => process.exit(0), 500); // Allow time for logs to flush, etc.
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));