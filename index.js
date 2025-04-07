// index.js
// Version with Smaller Feedback Buttons and Interaction Endpoint Stub

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
const botUserId = process.env.SLACK_BOT_USER_ID;
const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
const anythingLLMApiKey = process.env.LLM_API_KEY;
const developerId = process.env.DEVELOPER_ID;
const redisUrl = process.env.REDIS_URL;

// --- Input Validation ---
if (!slackSigningSecret || !slackToken || !anythingLLMBaseUrl || !anythingLLMApiKey) { console.error("Missing critical environment variables"); process.exit(1); }
if (!botUserId) { console.error("SLACK_BOT_USER_ID environment variable is not set."); process.exit(1); }
if (!redisUrl) { console.warn("REDIS_URL not set..."); }

// --- Redis Client Setup ---
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
    redisClient = { isReady: false, set: async () => null, get: async() => null, del: async() => 0, on: () => {}, connect: async () => {}, isOpen: false, quit: async () => {} };
    console.warn("Running without Redis connection. 'reset conversation' command will not function.");
}

// --- Slack Clients Setup ---
const slackEvents = createEventAdapter(slackSigningSecret, { includeBody: true });
const slack = new WebClient(slackToken);

// --- Duplicate Event Detection ---
async function isDuplicateRedis(eventId) { /* ... function remains the same ... */ }

// --- Simple Query Detection (using LLM) ---
async function isQuerySimpleLLM(query) { /* ... function remains the same ... */ }

// --- Sphere Decision Logic (Context-Aware) ---
async function decideSphere(userQuestion, conversationHistory = "") { /* ... function remains the same ... */ }

// --- Constants ---
const RESET_CONVERSATION_COMMAND = 'reset conversation';
const RESET_HISTORY_REDIS_PREFIX = 'reset_history:channel:';
const RESET_HISTORY_TTL = 300;

// --- Function to Store Feedback (Example: Logging) ---
// Replace this later with actual database/storage logic
async function storeFeedback(feedbackData) {
   console.log("--- FEEDBACK RECEIVED ---");
   console.log(JSON.stringify(feedbackData, null, 2));
   console.log("-------------------------");
   // Example: await database.collection('feedback').insertOne(feedbackData);
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
    const replyTarget = isDM ? undefined : (threadTs || originalTs);

    console.log(`[Handler] Start. User: ${userId}, Chan: ${channel}, isDM: ${isDM}, Mentioned: ${wasMentioned}, Query: "${cleanedQuery}"`);

    // Check for Reset Conversation Command
    if (originalText.toLowerCase() === RESET_CONVERSATION_COMMAND) { /* ... reset logic ... */ return; }

    // Post Initial Processing Message
    let thinkingMessageTs = null;
    try { /* ... post initial message ... */ }
    catch (slackError) { /* ... */ }

    // Check if History Reset Was Requested
    let skipHistory = false;
    if (redisUrl && isRedisReady) { /* ... check and delete reset flag ... */ }

    // Determine Target Sphere
    let sphere = null;
    let conversationHistory = "";
    const isSimple = await isQuerySimpleLLM(cleanedQuery);
    if (isSimple) { /* ... set sphere to public, skip history ... */ }
    else { /* ... fetch history if needed, call decideSphere ... */ }

    // Update Thinking Message with Sphere Info
    if (thinkingMessageTs) { /* ... update thinking message ... */ }

    // Construct the Input for the Final LLM call
    let llmInputText = "";
    /* ... construct llmInputText including history if applicable ... */
    console.log(`[Handler] Sending input to LLM Sphere ${sphere}...`);

    // Query the chosen LLM Sphere
    try {
        const llmStartTime = Date.now();
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/chat`, { /* ... */ }, { headers: { /* ... */ }, timeout: 90000 });
        const llmDuration = Date.now() - llmStartTime;
        console.log(`[Handler] Final LLM call duration: ${llmDuration}ms`);
        const reply = llmResponse.data.textResponse || '⚠️ Sorry, empty response.';

        // --- Send final response using Block Kit (with SMALLER buttons) ---
        try {
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: replyTarget,
                text: reply, // Fallback text
                blocks: [
                    { // Response text block
                        "type": "section",
                        "text": { "type": "mrkdwn", "text": reply }
                    },
                    { // Divider
                        "type": "divider"
                    },
                    { // Feedback buttons block
                        "type": "actions",
                        "block_id": `feedback_${originalTs}`, // Include original message TS
                        "elements": [
                            { // Bad button
                                "type": "button",
                                "text": { "type": "plain_text", "text": "👎", "emoji": true }, // Just emoji
                                "style": "danger", "value": "bad", "action_id": "feedback_bad"
                            },
                            { // OK button
                                "type": "button",
                                "text": { "type": "plain_text", "text": "👌", "emoji": true }, // Just emoji
                                "value": "ok", "action_id": "feedback_ok"
                            },
                            { // Great button
                                "type": "button",
                                "text": { "type": "plain_text", "text": "👍", "emoji": true }, // Just emoji
                                "style": "primary", "value": "great", "action_id": "feedback_great"
                            }
                        ]
                    }
                ]
            });
             console.log(`[Handler] Posted final response with feedback buttons to ${channel} (re: ${originalTs})`);
        } catch(postError) {
             console.error("[Slack Error] Failed post final response message:", postError.data?.error || postError.message);
             // Fallback to simple text
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: reply + "\n\n_(Error displaying feedback buttons)_"}).catch(()=>{});
        }

    } catch (error) { // Catch LLM call error
        console.error(`[LLM Error - Sphere: ${sphere}]`, error.response?.data || error.message);
        try { await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: '⚠️ DeepOrbit encountered an internal error.' }); }
        catch (slackError) { console.error("[Slack Error] Failed post LLM error msg:", slackError.data?.error || slackError.message); }
    } finally {
        // Clean up the thinking message
        if (thinkingMessageTs) { /* ... delete thinking message ... */ }
        const handlerEndTime = Date.now();
        console.log(`[Handler] Finished processing event for ${userId}. Total duration: ${handlerEndTime - handlerStartTime}ms`);
    }
}

// --- Express App Setup ---
// Middleware for parsing application/x-www-form-urlencoded (needed for interactions)
app.use(express.urlencoded({ extended: true }));
// Events API listener (needs to be before any general JSON parser if added later)
app.use('/slack/events', slackEvents.requestListener());


// --- NEW: Interaction Endpoint ---
app.post('/slack/interactions', async (req, res) => {
    // --- !!! CRITICAL: VERIFY SLACK SIGNATURE HERE !!! ---
    // You MUST verify the incoming request signature using slackSigningSecret
    // before processing the payload. Skipping this is a security risk.
    // Implementation is complex and requires access to the raw request body
    // before `express.urlencoded` parses it.
    // Example Placeholder:
    // const isValid = manuallyVerifySignature(req.headers, req.rawBody, slackSigningSecret);
    // if (!isValid) {
    //   console.error("Interaction signature verification failed!");
    //   return res.status(403).send('Forbidden');
    // }
    console.warn("!!! Interaction signature verification is NOT IMPLEMENTED !!!"); // Remove this line once verification is added

    let payload;
    try {
        // Interaction payload is nested within the form data
        payload = JSON.parse(req.body.payload);
    } catch (e) {
        console.error("Failed to parse interaction payload:", e);
        return res.status(400).send(); // Bad Request
    }

    // Acknowledge Slack immediately (within 3 seconds)
    res.send(); // Empty 200 OK is sufficient

    // Process interaction asynchronously
    try {
        console.log("[Interaction] Received payload type:", payload.type);

        // Handle button clicks (block_actions)
        if (payload.type === 'block_actions' && payload.actions?.[0]) {
            const action = payload.actions[0];
            const actionId = action.action_id;
            const feedbackValue = action.value; // e.g., "bad", "ok", "great"
            const userId = payload.user.id;
            const channelId = payload.channel.id;
            const messageTs = payload.message.ts; // Timestamp of the message with buttons
            const blockId = action.block_id; // e.g., "feedback_1712521194.012345"
            const originalQuestionTs = blockId?.startsWith('feedback_') ? blockId.substring(9) : null; // Extract original TS

            console.log(`[Interaction] User ${userId} clicked '${actionId}' (Value: ${feedbackValue}) on msg ${messageTs} in channel ${channelId}. Original question ts: ${originalQuestionTs}`);

            // Store the feedback (replace console log with actual storage)
            await storeFeedback({
                feedback_ts: new Date().toISOString(),
                feedback_value: feedbackValue,
                user_id: userId,
                channel_id: channelId,
                bot_message_ts: messageTs,
                original_user_message_ts: originalQuestionTs,
                action_id: actionId,
                // You might want to fetch the original bot message text too if needed for context
                // bot_message_text: payload.message?.blocks?.[0]?.text?.text
            });

            // Optional: Update the original message to remove buttons / show thanks
            // Be mindful of rate limits if users click quickly
            try {
                await slack.chat.update({
                    channel: channelId,
                    ts: messageTs,
                    text: payload.message.text + "\n\n_🙏 Thanks for the feedback!_", // Append thanks to fallback text
                    blocks: [ // Keep original text block, replace actions block
                         payload.message.blocks[0], // Assumes first block is the text section
                         {
                             "type": "context",
                             "elements": [ { "type": "mrkdwn", "text": `_🙏 Thanks for the feedback! (_${feedbackValue}_)` } ]
                         }
                    ]
                });
                 console.log(`[Interaction] Updated original message ${messageTs} to acknowledge feedback.`);
            } catch (updateError) {
                 console.warn("Failed to update message after feedback:", updateError.data?.error || updateError.message);
            }

        } else if (payload.type === 'view_submission') {
            // Handle modal submissions if you add them later
            console.log("[Interaction] Received view submission");
        } else {
            console.log("[Interaction] Received unhandled interaction type:", payload.type);
        }
    } catch (error) {
        console.error("[Interaction Handling Error]", error);
    }
});


// --- Slack Event Listeners ---
// slackEvents.on('message', ...) listener remains the same
slackEvents.on('message', async (event, body) => { /* ... filters, DM/mention check, calls handleSlackMessageEvent ... */ });
slackEvents.on('error', (error) => { /* ... Error logging ... */ });

// --- Basic Health Check Route ---
// app.get('/', ...) route remains the same
app.get('/', (req, res) => { /* ... health check response ... */ });

// --- Start Server & Graceful Shutdown ---
// Startup and shutdown logic remains the same
(async () => { /* ... start server ... */ })();
async function shutdown(signal) { /* ... close redis, exit ... */ }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));