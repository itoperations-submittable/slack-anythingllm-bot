// index.js
// Version implementing Strategy 2 + Increased Timeouts + Simple Query Heuristic

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
    redisClient = { // Dummy client
        isReady: false, set: async () => null, on: () => {}, connect: async () => {}, isOpen: false, quit: async () => {}
    };
    console.warn("Running without Redis connection for duplicate detection.");
}

// --- Slack Clients Setup ---
const slackEvents = createEventAdapter(slackSigningSecret, { includeBody: true });
const slack = new WebClient(slackToken);

// --- Duplicate Event Detection (using Redis) ---
async function isDuplicateRedis(eventId) {
    // ... (Function remains the same as previous version) ...
    if (!eventId) { console.warn("isDuplicateRedis: null eventId"); return true; }
    if (!redisUrl) { return false; }
    if (!isRedisReady) { console.warn('Redis not ready for duplicate check:', eventId); return false; }
    try {
        const result = await redisClient.set(eventId, 'processed', { EX: 60, NX: true });
        return result === null;
    } catch (err) {
        console.error('Redis error during duplicate check:', eventId, err);
        return false;
    }
}

// --- Simple Query Detection Heuristic ---
function isSimpleQuery(query) {
    const lowerQuery = query.toLowerCase().trim();
    const simpleGreetings = ['hello', 'hi', 'hey', 'yo', 'good morning', 'good afternoon', 'good evening'];
    const simpleQuestions = [
        'how are you', 'how are you doing', "how's it going",
        'what can you do', 'how can you help', 'help', 'info',
        'what is this', 'what are you'
    ];
    const simpleThanks = ['thanks', 'thank you', 'thx', 'ty'];

    // Check for exact matches or starting phrases for greetings/thanks
    if (simpleGreetings.some(g => lowerQuery === g || lowerQuery.startsWith(g + ' ')) ||
        simpleThanks.some(t => lowerQuery === t || lowerQuery.startsWith(t + ' '))) {
        return true;
    }

    // Check for exact matches for questions
    if (simpleQuestions.includes(lowerQuery)) {
        return true;
    }

    // Add more sophisticated checks if needed (e.g., regex, query length)
    // Example: Consider queries under 4 words as potentially simple?
    // if (lowerQuery.split(' ').length <= 3 && !lowerQuery.includes('?')) { return true; }

    return false;
}


// --- Workspace Decision Logic (Context-Aware) ---
async function decideWorkspace(userQuestion, conversationHistory = "") {
    // ... (Function structure remains same, but timeout increased) ...
    console.log(`[Workspace Decision] Starting for query: "${userQuestion}" with history.`);
    let availableWorkspaces = [];
    try { // Fetch workspaces
        // ... (Fetching logic is the same) ...
        console.log(`[Workspace Decision] Fetching available workspaces...`);
        const response = await axios.get(/* ... */);
        // ... (Parsing logic is the same) ...
    } catch (error) { /* ... */ return 'public'; }

    // Format context-aware prompt
    let selectionPrompt = /* ... (Construct prompt including history and query) ... */
    console.log(`[Workspace Decision] Sending context-aware prompt to public workspace.`);

    try { // Ask the public/routing LLM
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, {
            message: selectionPrompt,
            mode: 'chat',
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            // *** INCREASED TIMEOUT for routing LLM call ***
            timeout: 25000, // Increased from 15000ms
        });

        // Extract and validate slug
        // ... (Validation logic remains the same) ...
        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[Workspace Decision] Raw routing response: "${chosenSlugRaw}"`);
        // ... (Check includes, fallback logic) ...
        return 'public'; // Fallback

    } catch (error) {
        console.error('[Workspace Decision Error] Failed query public workspace:', error.response?.data || error.message);
        return 'public';
    }
}


// --- Main Slack Event Handler (REVISED with Simple Query Check & Timeout) ---
async function handleSlackMessageEvent(event) {
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

    // *** Simple Query Heuristic Check ***
    if (isSimpleQuery(cleanedQuery)) {
        workspace = 'public';
        console.log(`[Handler] Detected simple query. Routing directly to: ${workspace}`);
    } else {
        // If not simple, proceed with context-aware dynamic routing
        console.log(`[Handler] Query not simple. Fetching history and deciding workspace dynamically...`);

        // Fetch Conversation History
        let conversationHistory = "";
        const HISTORY_LIMIT = 10;
        if (isDM || wasMentioned) { // Fetch history if relevant
             try {
                 // ... (History fetching logic remains the same using HISTORY_LIMIT) ...
                 let historyResult;
                 if (!isDM && threadTs) { // Thread history
                     historyResult = await slack.conversations.replies({ /* ... */ });
                 } else { // Channel/DM history
                     historyResult = await slack.conversations.history({ /* ... */ });
                 }
                  if (historyResult.ok && historyResult.messages) {
                     const relevantMessages = historyResult.messages.filter(/* ... */).reverse();
                     if (relevantMessages.length > 0) {
                         conversationHistory = "Conversation History:\n";
                         relevantMessages.forEach(msg => { conversationHistory += `User ${msg.user}: ${msg.text}\n`; });
                     }
                 } else { console.warn("[Handler] Failed fetch history:", historyResult.error); }
             } catch (historyError) { console.error("[Slack History Error]", historyError); }
        }

        // Decide Workspace Dynamically (using history if fetched)
        workspace = await decideWorkspace(cleanedQuery, conversationHistory);
        console.log(`[Handler] Dynamically decided workspace: ${workspace}`);
    }
    // --- End Workspace Determination ---

    // Construct the Input for the Final LLM call
    let llmInputText = "";
    // History might not have been fetched if it was a simple query routed to public,
    // but include it if it exists from the dynamic route.
    if (conversationHistory) {
        llmInputText += conversationHistory.trim() + "\n\n";
        llmInputText += `Based on the conversation history above and your knowledge, answer the following query:\n`;
    }
    llmInputText += `User Query: ${cleanedQuery}`;

    console.log(`[Handler] Sending input to LLM workspace ${workspace}...`);

    // Send "Thinking" message
    let thinkingMessageTs = null;
    const replyTarget = isDM ? undefined : (threadTs || originalTs);
    try {
        const thinkingMsg = await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `:hourglass_flowing_sand: DeepOrbit is thinking... (Workspace: ${workspace})`
        });
        thinkingMessageTs = thinkingMsg.ts;
    } catch (slackError) { console.error("[Slack Error] Failed post 'thinking':", slackError.data?.error || slackError.message); }


    // Query the chosen LLM workspace
    try {
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${workspace}/chat`, {
            message: llmInputText,
            mode: 'chat',
            sessionId: userId,
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            // *** INCREASED TIMEOUT for final LLM call ***
            timeout: 60000, // Increased from 45000ms
        });

        const reply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';

        // Send final response back to Slack
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: reply
            // Add feedback blocks here later
        });

        // Clean up "thinking" message
        if (thinkingMessageTs) { await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed delete 'thinking':", delErr.data?.error || delErr.message)); }

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
            if (thinkingMessageTs) { await slack.chat.delete({ channel: channel, ts: thinkingMessageTs }).catch(delErr => console.warn("Failed delete 'thinking' after error:", delErr.data?.error || delErr.message)); }
        } catch (slackError) { console.error("[Slack Error] Failed post LLM error msg:", slackError.data?.error || slackError.message); }
    }
}


// --- Express App Setup ---
app.use('/slack/events', slackEvents.requestListener());
app.use(express.urlencoded({ extended: true }));

// --- Slack Event Listeners ---
// slackEvents.on('message', ...) listener remains the same
// (Handles duplicates, filters subtypes/self-replies, checks for DMs/Mentions, calls handleSlackMessageEvent)
slackEvents.on('message', async (event, body) => {
    const eventId = body?.event_id;
    if (await isDuplicateRedis(eventId)) { return; }
    const subtype = event.subtype;
    const messageUserId = event.user;
    const channelId = event.channel;
    const text = event.text?.trim() ?? '';
    if ( subtype === 'bot_message' || subtype === 'message_deleted' || subtype === 'message_changed' ||
         subtype === 'channel_join' || subtype === 'channel_leave' || subtype === 'thread_broadcast' ||
         !messageUserId || !text || messageUserId === botUserId ) { return; }
    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);
    if (isDM || wasMentioned) {
        console.log(`[Processing Event] ID: ${eventId}, User: ${messageUserId}, Channel: ${channelId}, isDM: ${isDM}, Mentioned: ${wasMentioned}`);
        handleSlackMessageEvent(event).catch(err => { console.error("[Unhandled Handler Error] Event ID:", eventId, err); });
    } else { return; } // Ignore non-DM, non-mention channel messages
});


// slackEvents.on('error', ...) listener remains the same
slackEvents.on('error', (error) => { /* ... log errors ... */ });


// --- Basic Health Check Route ---
// app.get('/', ...) route remains the same
app.get('/', (req, res) => { /* ... health check response ... */ });

// --- Start Server ---
(async () => {
    try {
        app.listen(port, () => {
            // This confirms the server is listening
            console.log(`🚀 DeepOrbit running on port ${port}`);

            // Optional logs included from previous versions:
            if (developerId) {
                console.log(`🔒 Bot restricted to developer ID: ${developerId}`);
            } else {
                 console.log(`🔓 Bot is not restricted to a specific developer.`);
            }
            // Log current time on startup using a specific timezone
            console.log(`🕒 Current Time: ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' })} (Time in Cairo)`);
        });
    } catch (error) {
        // This catches immediate errors during the listen() call itself
        console.error("Failed to start server:", error);
        process.exit(1);
    }
})();

// --- Graceful Shutdown ---
// (This part should also be at the end, typically after the startup block)
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