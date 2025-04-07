// index.js
// Version using "Sphere" terminology, LLM Simplicity Check, Increased Timeouts

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
const botUserId = process.env.SLACK_BOT_USER_ID;
const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
const anythingLLMApiKey = process.env.LLM_API_KEY;
const developerId = process.env.DEVELOPER_ID;
const redisUrl = process.env.REDIS_URL;

// --- Input Validation ---
if (!slackSigningSecret || !slackToken || !anythingLLMBaseUrl || !anythingLLMApiKey) { console.error("Missing critical environment variables"); process.exit(1); }
if (!botUserId) { console.error("SLACK_BOT_USER_ID environment variable is not set."); process.exit(1); }
if (!redisUrl) { console.warn("REDIS_URL not set..."); }

// --- Redis Client Setup (for Duplicate Detection) ---
let redisClient;
let isRedisReady = false;
if (redisUrl) {
    redisClient = createClient({ url: redisUrl, socket: { reconnectStrategy: retries => Math.min(retries * 100, 3000) }});
    redisClient.on('error', err => { console.error('Redis error:', err); isRedisReady = false; });
    redisClient.on('connect', () => console.log('Redis connecting...'));
    redisClient.on('ready', () => { console.log('Redis connected!'); isRedisReady = true; });
    redisClient.on('end', () => { console.log('Redis connection closed.'); isRedisReady = false; });
    redisClient.connect().catch(err => console.error("Initial Redis connection failed:", err));
} else {
    redisClient = { isReady: false, set: async () => null, on: () => {}, connect: async () => {}, isOpen: false, quit: async () => {} };
    console.warn("Running without Redis connection for duplicate detection.");
}

// --- Slack Clients Setup ---
const slackEvents = createEventAdapter(slackSigningSecret, { includeBody: true });
const slack = new WebClient(slackToken);

// --- Duplicate Event Detection (using Redis) ---
async function isDuplicateRedis(eventId) {
    if (!eventId) { console.warn("isDuplicateRedis: null eventId"); return true; }
    if (!redisUrl || !isRedisReady) { return false; }
    try {
        const result = await redisClient.set(eventId, 'processed', { EX: 60, NX: true });
        return result === null;
    } catch (err) { console.error('Redis error duplicate check:', eventId, err); return false; }
}

// --- Simple Query Detection (using LLM) ---
async function isQuerySimpleLLM(query) {
    // ... (Function remains the same as previous version) ...
    console.log(`[Simplicity Check] Asking LLM if query is simple: "${query}"`);
    if (!query) return false;
    const classificationPrompt = `Analyze the user query below. Is it a simple social interaction (like a greeting, thanks, how are you), a basic question about the bot's function/capabilities (like 'what can you do?', 'help'), or a general conversational query NOT requiring specific knowledge from a specialized knowledge base? Answer ONLY with the word 'true' if it is simple/general, or 'false' if it likely requires specific knowledge. User Query: "${query}" Is Simple/General (true or false):`;
    try {
        const startTime = Date.now();
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, { message: classificationPrompt, mode: 'chat' }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 15000 });
        const duration = Date.now() - startTime;
        const resultText = response.data?.textResponse?.trim().toLowerCase();
        const isSimple = resultText === 'true';
        console.log(`[Simplicity Check] LLM Result: '${resultText}', Simple: ${isSimple}. Duration: ${duration}ms`);
        return isSimple;
    } catch (error) {
        console.error('[Simplicity Check Error] Failed LLM classification:', error.response?.data || error.message);
        return false;
    }
}


// --- Sphere Decision Logic (Context-Aware - Formerly decideWorkspace/decideSector) ---
async function decideSphere(userQuestion, conversationHistory = "") { // Renamed function
    console.log(`[Sphere Decision] Starting for query: "${userQuestion}" with history.`); // Renamed log prefix
    let availableWorkspaces = []; // API response field name is still 'workspaces'

    // 1. Get available workspaces/spheres
    try {
        console.log(`[Sphere Decision] Fetching available knowledge spheres (workspaces)...`); // Updated log text
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
    // Updated prompt text to use "Sphere" but still ask for the "workspace slug"
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
        }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 35000 }); // Routing timeout
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
    console.log(`[Handler] Start. User: ${userId}, Chan: ${channel}, isDM: ${isDM}, Mentioned: ${wasMentioned}, Query: "${cleanedQuery}"`);

    const replyTarget = isDM ? undefined : (threadTs || originalTs);

    // Post Initial Processing Message Immediately
    let thinkingMessageTs = null;
    try {
        const initialMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: ":hourglass_flowing_sand: DeepOrbit is processing..." });
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Handler] Posted initial processing message (ts: ${thinkingMessageTs}).`);
    } catch (slackError) { console.error("[Slack Error] Failed post initial 'processing' message:", slackError.data?.error || slackError.message); }


    // Determine Target Sphere
    let sphere = null; // Renamed variable
    let conversationHistory = "";

    // LLM-Based Simple Query Check
    const isSimple = await isQuerySimpleLLM(cleanedQuery);

    if (isSimple) {
        sphere = 'public'; // Default to public sphere if simple
        console.log(`[Handler] LLM determined query is simple. Routing directly to Sphere: ${sphere}`);
    } else {
        console.log(`[Handler] Query not simple. Fetching history and deciding sphere dynamically...`);
        // Fetch Conversation History
        const HISTORY_LIMIT = 10;
        if (isDM || wasMentioned) {
             try {
                 let historyResult;
                 if (!isDM && threadTs) { historyResult = await slack.conversations.replies({ channel, ts: threadTs, limit: HISTORY_LIMIT + 1}); }
                 else { historyResult = await slack.conversations.history({ channel, latest: originalTs, limit: HISTORY_LIMIT, inclusive: false }); }
                 if (historyResult.ok && historyResult.messages) {
                     const relevantMessages = historyResult.messages.filter(msg => msg.user && msg.text && msg.user !== botUserId).reverse();
                     if (relevantMessages.length > 0) {
                         conversationHistory = "Conversation History:\n";
                         relevantMessages.forEach(msg => { conversationHistory += `User ${msg.user}: ${msg.text}\n`; });
                          console.log(`[Handler] Fetched ${relevantMessages.length} relevant history messages.`);
                     } else { console.log("[Handler] No relevant prior messages found."); }
                 } else { console.warn("[Handler] Failed fetch history:", historyResult.error || "No messages"); }
             } catch (historyError) { console.error("[Slack History Error]", historyError); }
        }

        // Decide Sphere Dynamically (using history if fetched) - Call renamed function
        sphere = await decideSphere(cleanedQuery, conversationHistory);
        console.log(`[Handler] Dynamically decided Sphere: ${sphere}`); // Updated log
    }
    // --- End Sphere Determination ---


    // Update Thinking Message with Sphere Info
    if (thinkingMessageTs) {
        try {
            await slack.chat.update({
                channel: channel,
                ts: thinkingMessageTs,
                // Updated text to use "Sphere"
                text: `:hourglass_flowing_sand: DeepOrbit is thinking... (Sphere: ${sphere})`
            });
             console.log(`[Handler] Updated thinking message (ts: ${thinkingMessageTs}) with Sphere: ${sphere}.`); // Updated log
        } catch (updateError) {
             console.warn(`[Handler] Failed update thinking message (ts: ${thinkingMessageTs}):`, updateError.data?.error || updateError.message);
        }
    }

    // Construct the Input for the Final LLM call
    let llmInputText = "";
    if (conversationHistory) { /* ... Add history ... */ }
    llmInputText += `User Query: ${cleanedQuery}`;
    console.log(`[Handler] Sending input to LLM Sphere ${sphere}...`); // Updated log


    // Query the chosen LLM Sphere (API endpoint still uses 'workspace')
    try {
        const llmStartTime = Date.now();
        // Use sphere variable for the slug in the URL
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/chat`, {
            message: llmInputText, mode: 'chat', sessionId: userId,
        }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 90000 }); // 90s final timeout
        const llmDuration = Date.now() - llmStartTime;
        console.log(`[Handler] Final LLM call duration: ${llmDuration}ms`);

        const reply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: reply });

    } catch (error) {
        console.error(`[LLM Error - Sphere: ${sphere}]`, error.response?.data || error.message); // Updated log
        try { // Attempt to notify user of error
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: '⚠️ DeepOrbit encountered an internal error.' });
        } catch (slackError) { console.error("[Slack Error] Failed post LLM error msg:", slackError.data?.error || slackError.message); }
    } finally {
        // Clean up the thinking message
        if (thinkingMessageTs) {
            try {
                await slack.chat.delete({ channel: channel, ts: thinkingMessageTs });
                console.log(`[Handler] Deleted thinking message (ts: ${thinkingMessageTs}).`);
            } catch (delErr) { console.warn("Failed delete thinking message:", delErr.data?.error || delErr.message); }
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
    // ... (Listener logic remains the same) ...
    const eventId = body?.event_id;
    if (await isDuplicateRedis(eventId)) { return; }
    const subtype = event.subtype; const messageUserId = event.user; const channelId = event.channel; const text = event.text?.trim() ?? '';
    if ( subtype === 'bot_message' || subtype === 'message_deleted' || /* ... other filters ... */ || messageUserId === botUserId ) { return; }
    const isDM = channelId.startsWith('D'); const mentionString = `<@${botUserId}>`; const wasMentioned = text.includes(mentionString);
    if (isDM || wasMentioned) {
        console.log(`[Processing Event] ID: ${eventId}, User: ${messageUserId}, Channel: ${channelId}, isDM: ${isDM}, Mentioned: ${wasMentioned}`);
        handleSlackMessageEvent(event).catch(err => { console.error("[Unhandled Handler Error] Event ID:", eventId, err); });
    } else { return; }
});

slackEvents.on('error', (error) => {
    // ... (Error logging remains the same) ...
    console.error('[SlackEvents Adapter Error]', error.name, error.code || '', error.message);
    if (error.request) { console.error('Request:', error.request.method, error.request.url); }
    if (error.code === '@slack/events-api:adapter:signatureVerificationFailure') { console.error('[FATAL] Slack signature verification failed!'); }
    else if (error.code === '@slack/events-api:adapter:requestTimeTooSkewed') { console.error('[FATAL] Slack request timestamp too skewed.'); }
});

// --- Basic Health Check Route ---
app.get('/', (req, res) => {
    // ... (Health check remains the same) ...
    const redisStatus = redisUrl ? (isRedisReady ? 'Ready' : 'Not Ready/Error') : 'Not Configured';
    res.send(`DeepOrbit is live 🛰️ Redis Status: ${redisStatus}`);
});

// --- Start Server ---
(async () => {
    // ... (Server start logic remains the same) ...
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
    // ... (Shutdown logic remains the same) ...
    console.log(`${signal} signal received: closing connections and shutting down.`);
    if (redisClient?.isOpen) {
        try { await redisClient.quit(); console.log('Redis connection closed gracefully.'); }
        catch(err) { console.error('Error closing Redis connection:', err); }
    }
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));