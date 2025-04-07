// index.js
// FINAL Version: Includes truncation for long messages.

import express from 'express';
import { createEventAdapter } from '@slack/events-api';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import { WebClient } from '@slack/web-api';
// crypto needed if implementing manual verification later
// import crypto from 'crypto';

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
const MAX_SLACK_BLOCK_TEXT_LENGTH = 2900; // Max chars for section block text (Slack limit is ~3000)

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
    if (!query) return false; // Handle empty query
    const classificationPrompt = `Analyze the user query below. Is it a simple social interaction (like a greeting, thanks, how are you), a basic question about the bot's function/capabilities (like 'what can you do?', 'help'), or a general conversational query NOT requiring specific knowledge from a specialized knowledge base? Answer ONLY with the word 'true' if it is simple/general, or 'false' if it likely requires specific knowledge. User Query: "${query}" Is Simple/General (true or false):`;
    try {
        const startTime = Date.now();
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, // Using 'public' workspace for classification
            { message: classificationPrompt, mode: 'chat' },
            { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 15000 } // 15s timeout for classification call
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


// --- Sphere Decision Logic (Context-Aware) ---
async function decideSphere(userQuestion, conversationHistory = "") {
    console.log(`[Sphere Decision] Starting for query: "${userQuestion}" with history.`);
    let availableWorkspaces = []; // API response field name is still 'workspaces'
    try { // Fetch workspaces/spheres
        console.log(`[Sphere Decision] Fetching available knowledge spheres (workspaces)...`);
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, { headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 10000 });
        if (response.data && Array.isArray(response.data.workspaces)) {
            availableWorkspaces = response.data.workspaces.map(ws => ws.slug).filter(slug => slug && typeof slug === 'string');
            console.log(`[Sphere Decision] Found slugs: ${availableWorkspaces.join(', ')}`);
        } else { throw new Error('Could not parse workspace list.'); }
        if (availableWorkspaces.length === 0) { console.warn('[Sphere Decision] No slugs found.'); return 'public'; }
    } catch (error) { console.error('[Sphere Decision Error] Fetch failed:', error.response?.data || error.message); return 'public'; }

    // Format context-aware prompt for routing LLM
    let selectionPrompt = "Consider the following conversation history (if any):\n"; /* ... rest of prompt ... */
    console.log(`[Sphere Decision] Sending context-aware prompt to public routing.`);

    // Ask the public/routing LLM
    try {
        const startTime = Date.now();
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, { message: selectionPrompt, mode: 'chat' }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 35000 });
        const duration = Date.now() - startTime;
        console.log(`[Sphere Decision] Routing LLM call duration: ${duration}ms`);

        // Extract and validate the chosen slug
        const chosenSlugRaw = selectionResponse.data?.textResponse; /* ... validation ... */
        return 'public'; // Fallback
    } catch (error) { console.error('[Sphere Decision Error] Failed query public:', error.response?.data || error.message); return 'public'; }
}

// --- Constants ---
const RESET_CONVERSATION_COMMAND = 'reset conversation';
const RESET_HISTORY_REDIS_PREFIX = 'reset_history:channel:';
const RESET_HISTORY_TTL = 300;

// --- Function to Store Feedback (Placeholder: Logging) ---
async function storeFeedback(feedbackData) {
   console.log("--- FEEDBACK RECEIVED ---");
   console.log(JSON.stringify(feedbackData, null, 2));
   console.log("-------------------------");
}

// --- Main Slack Event Handler ---
async function handleSlackMessageEvent(event) {
    const handlerStartTime = Date.now();
    const userId = event.user;
    const originalText = event.text?.trim() ?? '';
    const channel = event.channel;
    const originalTs = event.ts; // Timestamp of the trigger message
    const threadTs = event.thread_ts;

    let cleanedQuery = originalText;
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = originalText.includes(mentionString);
    if (wasMentioned) { cleanedQuery = originalText.replace(mentionString, '').trim(); }

    const isDM = channel.startsWith('D');
    const replyTarget = isDM ? undefined : (threadTs || originalTs); // Determine reply target early

    console.log(`[Handler] Start. User: ${userId}, Chan: ${channel}, isDM: ${isDM}, Mentioned: ${wasMentioned}, Query: "${cleanedQuery}"`);

    // Check for Reset Conversation Command
    if (originalText.toLowerCase() === RESET_CONVERSATION_COMMAND) {
        // ... (Reset logic remains the same) ...
        return;
    }

    // Post Initial Processing Message Immediately
    let thinkingMessageTs = null;
    try {
        const initialMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: ":hourglass_flowing_sand: DeepOrbit is processing..." });
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Handler] Posted initial processing message (ts: ${thinkingMessageTs}).`);
    } catch (slackError) { console.error("[Slack Error] Failed post initial 'processing':", slackError.data?.error || slackError.message); }

    // Check if History Reset Was Requested for this interaction
    let skipHistory = false;
    if (redisUrl && isRedisReady) {
        // ... (Check and delete reset flag logic remains the same) ...
    }

    // Determine Target Sphere
    let sphere = null;
    let conversationHistory = ""; // Initialize history

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
                 // ... (History fetching logic remains the same) ...
             } catch (historyError) { console.error("[Slack History Error]", historyError); }
        } else if (skipHistory) { console.log(`[Handler] Skipping history fetch.`); }

        // Decide Sphere Dynamically
        sphere = await decideSphere(cleanedQuery, conversationHistory);
        console.log(`[Handler] Dynamically decided Sphere: ${sphere}`);
    }

    // Update Thinking Message with Sphere Info
    if (thinkingMessageTs) {
        try {
            await slack.chat.update({ channel, ts: thinkingMessageTs, text: `:hourglass_flowing_sand: DeepOrbit is thinking... (Sphere: ${sphere})`});
            console.log(`[Handler] Updated thinking message (ts: ${thinkingMessageTs}) with Sphere: ${sphere}.`);
        } catch (updateError) { console.warn(`[Handler] Failed update thinking message:`, updateError.data?.error || updateError.message); }
    }

    // Construct the Input for the Final LLM call
    let llmInputText = "";
    // ... (Construct llmInputText including history if applicable) ...
    console.log(`[Handler] Sending input to LLM Sphere ${sphere}...`);

    // Query the chosen LLM Sphere
    try {
        const llmStartTime = Date.now();
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/chat`, {
            message: llmInputText, mode: 'chat', sessionId: userId,
        }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 90000 });
        const llmDuration = Date.now() - llmStartTime;
        console.log(`[Handler] Final LLM call duration: ${llmDuration}ms`);

        const reply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';

        // --- Truncate reply if needed for Slack Block Kit limits ---
        let truncatedReply = reply;
        let isTruncated = false;
        if (reply.length > MAX_SLACK_BLOCK_TEXT_LENGTH) {
            truncatedReply = reply.substring(0, MAX_SLACK_BLOCK_TEXT_LENGTH) + "... \n\n_(message truncated due to length)_";
            isTruncated = true;
            console.log(`[Handler] Response truncated from ${reply.length} to ${MAX_SLACK_BLOCK_TEXT_LENGTH} chars.`);
        }
        // --- End Truncation ---

        // --- Send final response using Block Kit (with SMALLER buttons) ---
        try {
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: replyTarget,
                text: truncatedReply, // Use potentially truncated reply as fallback text
                blocks: [
                    { // Response text block
                        "type": "section",
                        "text": { "type": "mrkdwn", "text": truncatedReply } // Use truncated reply here
                    },
                    { // Divider
                        "type": "divider"
                    },
                    { // Feedback buttons block
                        "type": "actions",
                        "block_id": `feedback_${originalTs}`, // Use original message TS for context
                        "elements": [
                            { // Bad button
                                "type": "button",
                                "text": { "type": "plain_text", "text": "👎", "emoji": true },
                                "style": "danger", "value": "bad", "action_id": "feedback_bad"
                            },
                            { // OK button
                                "type": "button",
                                "text": { "type": "plain_text", "text": "👌", "emoji": true },
                                "value": "ok", "action_id": "feedback_ok"
                            },
                            { // Great button
                                "type": "button",
                                "text": { "type": "plain_text", "text": "👍", "emoji": true },
                                "style": "primary", "value": "great", "action_id": "feedback_great"
                            }
                        ]
                    }
                ]
            });
             console.log(`[Handler] Posted final response (truncated: ${isTruncated}) with feedback buttons to ${channel} (re: ${originalTs})`);
        } catch(postError) {
             console.error("[Slack Error] Failed post final response message with blocks:", postError.data?.error || postError.message);
             // Fallback to simple text (already truncated) if blocks fail
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: truncatedReply + "\n\n_(Error displaying feedback buttons)_"}).catch(()=>{});
        }

    } catch (error) { // Catch LLM call error
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
// Events API listener *MUST* come before any body parsers that consume the raw body
app.use('/slack/events', slackEvents.requestListener());
// Apply urlencoded middleware *only* for interaction payloads if needed elsewhere,
// but it's added directly to the interaction endpoint below for clarity.
// Avoid global `app.use(express.json());` before the event listener too.


// --- Interaction Endpoint ---
// Apply urlencoded middleware specifically to this route for Slack interactions
app.post('/slack/interactions', express.urlencoded({ extended: true, limit: '1mb' }), async (req, res) => {
    // --- !!! CRITICAL: VERIFY SLACK SIGNATURE HERE !!! ---
    console.warn("!!! Interaction signature verification is NOT IMPLEMENTED !!!"); // Placeholder

    let payload;
    try { /* ... parse req.body.payload ... */ }
    catch (e) { /* ... handle parsing error ... */ return res.status(400).send(); }

    // Acknowledge Slack immediately
    res.send();

    // Process interaction asynchronously
    try {
        console.log("[Interaction] Received payload type:", payload.type);
        // Handle button clicks (block_actions)
        if (payload.type === 'block_actions' && payload.actions?.[0]) {
            // ... (Interaction handling logic - same as previous version) ...
            // Extract action details, call storeFeedback, optionally update message
            const action = payload.actions[0]; const actionId = action.action_id; const feedbackValue = action.value;
            const userId = payload.user.id; const channelId = payload.channel.id; const messageTs = payload.message.ts;
            const blockId = action.block_id; const originalQuestionTs = blockId?.startsWith('feedback_') ? blockId.substring(9) : null;
            console.log(`[Interaction] User ${userId} clicked '${actionId}' (Value: ${feedbackValue})...`);
            await storeFeedback({ /* ... feedback data ... */ });
            try { /* ... Optional: Update message to acknowledge feedback ... */ } catch (updateError) { /* ... */ }
        } else { console.log("[Interaction] Received unhandled interaction type:", payload.type); }
    } catch (error) { console.error("[Interaction Handling Error]", error); }
});


// --- Slack Event Listeners ---
slackEvents.on('message', async (event, body) => {
    const eventId = body?.event_id;
    if (await isDuplicateRedis(eventId)) { return; }
    // --- Fully Expanded Filter ---
    const subtype = event.subtype; const messageUserId = event.user; const channelId = event.channel; const text = event.text?.trim() ?? '';
    if ( subtype === 'bot_message' || subtype === 'message_deleted' || subtype === 'message_changed' || subtype === 'channel_join' || subtype === 'channel_leave' || subtype === 'thread_broadcast' || !messageUserId || !text || messageUserId === botUserId ) { return; }
    // --- End Expanded Filter ---
    const isDM = channelId.startsWith('D'); const mentionString = `<@${botUserId}>`; const wasMentioned = text.includes(mentionString);
    if (isDM || wasMentioned) { // Process only DMs or channel mentions
        console.log(`[Processing Event] ID: ${eventId}, User: ${messageUserId}, Channel: ${channelId}, isDM: ${isDM}, Mentioned: ${wasMentioned}`);
        handleSlackMessageEvent(event).catch(err => { console.error("[Unhandled Handler Error] Event ID:", eventId, err); });
    } else { return; } // Ignore other channel messages
});

slackEvents.on('error', (error) => { /* ... Error logging ... */ });

// --- Basic Health Check Route ---
app.get('/', (req, res) => { /* ... health check response ... */ });

// --- Start Server & Graceful Shutdown ---
(async () => { /* ... start server ... */ })();
async function shutdown(signal) { /* ... close redis, exit ... */ }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));