// index.js
// FINAL FULL Version: No placeholders, includes all features.

import express from 'express';
import { createEventAdapter } from '@slack/events-api';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import { WebClient } from '@slack/web-api';
import slackifyMarkdown from 'slackify-markdown';
import pg from 'pg';

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
const databaseUrl = process.env.DATABASE_URL; // For feedback DB

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

// --- Database Setup (PostgreSQL Example) ---
let pool;
if (databaseUrl) {
    pool = new pg.Pool({
        connectionString: databaseUrl,
        // ssl: { rejectUnauthorized: false } // Uncomment/adjust if needed for cloud DBs
    });
    pool.on('error', (err, client) => {
         console.error('Unexpected DB pool error', err);
         // Consider exiting or implementing more robust error handling
    });
    console.log("PostgreSQL Pool configured.");
} else {
    // Dummy pool if no DB URL
    pool = {
        query: async (...args) => {
             console.warn("DB query attempted but DATABASE_URL not set. Args:", args);
             // Simulate expected structure for RETURNING id
             return { rows: [{ id: null }], rowCount: 0, command: 'INSERT' };
        },
        connect: async () => ({
            query: async (...args) => {
                console.warn("DB query attempted on dummy client but DATABASE_URL not set. Args:", args);
                return { rows: [{ id: null }], rowCount: 0, command: 'INSERT' };
            },
            release: () => {}
        })
    };
    console.warn("Running without Database connection for feedback.");
}


// --- Slack Clients Setup ---
const slackEvents = createEventAdapter(slackSigningSecret, { includeBody: true });
const slack = new WebClient(slackToken);

// --- Duplicate Event Detection (using Redis) ---
async function isDuplicateRedis(eventId) {
    if (!eventId) { console.warn("isDuplicateRedis: null eventId"); return true; }
    if (!redisUrl || !isRedisReady) {
        // console.log("[Duplicate Check] Skipping check: Redis unavailable."); // Optional log
        return false; // Cannot check if Redis isn't ready/configured
    }
    try {
        const result = await redisClient.set(eventId, 'processed', { EX: 60, NX: true });
        // result will be null if the key already existed (duplicate)
        return result === null;
    } catch (err) {
        console.error('Redis error during duplicate check:', eventId, err);
        return false; // Assume not duplicate on error to avoid dropping messages
    }
}

// --- Sphere Decision Logic (Context-Aware) ---
async function decideSphere(userQuestion, conversationHistory = "") {
    console.log(`[Sphere Decision] Starting for query: "${userQuestion}" with history.`);
    let availableWorkspaces = []; // API response field name is still 'workspaces'

    // 1. Get available workspaces/spheres
    try {
        console.log(`[Sphere Decision] Fetching available knowledge spheres (workspaces)...`);
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 10000, // 10s timeout for fetching workspace list
        });
        if (response.data && Array.isArray(response.data.workspaces)) {
            availableWorkspaces = response.data.workspaces
                .map(ws => ws.slug) // Still extracting the 'slug'
                .filter(slug => slug && typeof slug === 'string');
            console.log(`[Sphere Decision] Found slugs: ${availableWorkspaces.join(', ')}`);
        } else {
            console.error('[Sphere Decision] Unexpected workspace list structure:', response.data);
            throw new Error('Could not parse workspace list.');
        }
        if (availableWorkspaces.length === 0) {
            console.warn('[Sphere Decision] No available slugs found.');
            return 'public'; // Fallback if list is empty
        }
    } catch (error) {
        console.error('[Sphere Decision Error] Fetch failed:', error.response?.data || error.message);
        return 'public'; // Fallback if fetch fails
    }

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
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 35000 // Routing timeout (35s)
        });
        const duration = Date.now() - startTime;
        console.log(`[Sphere Decision] Routing LLM call duration: ${duration}ms`);

        // 4. Extract and validate the chosen slug
        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[Sphere Decision] Raw routing response: "${chosenSlugRaw}"`);
        if (!chosenSlugRaw || typeof chosenSlugRaw !== 'string') {
            console.warn('[Sphere Decision] Bad routing response.');
            return 'public';
        }
        const chosenSlug = chosenSlugRaw.trim();
        if (availableWorkspaces.includes(chosenSlug)) {
            console.log(`[Sphere Decision] Context-aware valid slug selected: "${chosenSlug}"`);
            return chosenSlug;
        } else {
            const foundSlug = availableWorkspaces.find(slug => chosenSlug.includes(slug));
            if (foundSlug) {
                console.log(`[Sphere Decision] Found valid slug "${foundSlug}" in noisy response "${chosenSlug}".`);
                return foundSlug;
            }
            console.warn(`[Sphere Decision] Invalid slug response "${chosenSlug}". Falling back.`);
            return 'public';
        }
    } catch (error) {
        console.error('[Sphere Decision Error] Failed query public workspace:', error.response?.data || error.message);
        return 'public'; // Fallback on error
    }
}

// --- Constants ---
const RESET_CONVERSATION_COMMAND = 'reset conversation';
const RESET_HISTORY_REDIS_PREFIX = 'reset_history:channel:';
const RESET_HISTORY_TTL = 300; // 5 minutes in seconds

// --- Function to Store Feedback (Database Implementation - UPDATED) ---
async function storeFeedback(feedbackData) {
    if (!databaseUrl || !pool) { // Check if DB is configured
        console.warn("DATABASE_URL not configured, logging feedback to console instead.");
        console.log("--- FEEDBACK (Console Log) ---");
        console.log(JSON.stringify(feedbackData, null, 2));
        console.log("-----------------------------");
        return;
    }
    // UPDATED query to include original_user_message_text
    const insertQuery = `
        INSERT INTO feedback (
            feedback_value, user_id, channel_id, bot_message_ts,
            original_user_message_ts, action_id, sphere_slug, bot_message_text,
            original_user_message_text
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id;
    `;
    // Ensure all values exist, provide defaults or null if necessary
    const values = [
        feedbackData.feedback_value || null,
        feedbackData.user_id || null,
        feedbackData.channel_id || null,
        feedbackData.bot_message_ts || null,
        feedbackData.original_user_message_ts || null, // Might be null
        feedbackData.action_id || null,
        feedbackData.sphere_slug || null, // Pass this from interaction handler!
        feedbackData.bot_message_text || null, // Optional field
        feedbackData.original_user_message_text || null // Added user question text
    ];

    let client; // Declare client outside try
    try {
        client = await pool.connect(); // Get client from pool
        console.log(`[DB Feedback] Inserting feedback: User=${values[1]}, Value=${values[0]}, Sphere=${values[6]}`);
        const result = await client.query(insertQuery, values);
        // Check if insertion was successful and ID was returned
        if (result.rows && result.rows.length > 0 && result.rows[0].id) {
             console.log(`[DB Feedback] Feedback saved with ID: ${result.rows[0].id}`);
        } else {
             console.warn('[DB Feedback] Feedback insertion seemed successful, but no ID returned.');
        }
    } catch (err) {
        console.error('[DB Feedback Error] Failed to insert feedback:', err);
        // Optional: Implement retry logic or log to a fallback mechanism
    } finally {
        // VERY IMPORTANT: Release the client back to the pool
        if (client) {
            client.release();
            // console.log("[DB Feedback] Released client connection."); // Can be noisy
        }
    }
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
        console.log(`[Handler] User ${userId} requested conversation reset in ${channel}.`);
        if (redisUrl && isRedisReady) {
            try {
                const resetKey = `${RESET_HISTORY_REDIS_PREFIX}${channel}`;
                await redisClient.set(resetKey, 'true', { EX: RESET_HISTORY_TTL }); // Set flag with TTL
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
        return; // Stop processing the command itself
    }

    // Post Initial Processing Message Immediately
    let thinkingMessageTs = null;
    try {
        const initialMsg = await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: ":hourglass_flowing_sand: DeepOrbit is processing..." // Generic initial message
        });
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Handler] Posted initial processing message (ts: ${thinkingMessageTs}).`);
    } catch (slackError) {
         console.error("[Slack Error] Failed post initial 'processing' message:", slackError.data?.error || slackError.message);
         // Continue even if this fails, but we won't be able to update/delete it
    }

    // Check if History Reset Was Requested for this interaction
    let skipHistory = false;
    if (redisUrl && isRedisReady) {
        const resetKey = `${RESET_HISTORY_REDIS_PREFIX}${channel}`;
        try {
            const resetFlag = await redisClient.get(resetKey);
            if (resetFlag === 'true') {
                console.log(`[Handler] Reset flag found for ${channel}. Skipping history fetch.`);
                skipHistory = true;
                await redisClient.del(resetKey); // Delete flag after reading it
                 console.log(`[Handler] Deleted reset flag ${resetKey}.`);
            }
        } catch(redisError) {
             console.error(`[Redis Error] Failed check/delete reset flag ${resetKey}:`, redisError);
             // Proceed without skipping history if Redis check fails
        }
    }

    // Determine Target Sphere
    let sphere = null;
    let conversationHistory = ""; // Initialize history

    // NOTE: LLM Simplicity Check was removed as requested. Dynamic routing always occurs now.
    console.log(`[Handler] Fetching history (if applicable) and deciding sphere dynamically...`);

    // Fetch Conversation History (Only if not reset)
    const HISTORY_LIMIT = 10; // How many messages to fetch
    if (!skipHistory && (isDM || wasMentioned)) { // Check skipHistory flag
         console.log(`[Handler] Fetching history...`);
         try {
             let historyResult;
             if (!isDM && threadTs) { // Mentioned in a channel thread
                 console.log(`[Handler] Fetching thread replies: Channel=${channel}, ThreadTS=${threadTs}`);
                 historyResult = await slack.conversations.replies({
                     channel: channel,
                     ts: threadTs,
                     limit: HISTORY_LIMIT + 1, // Fetch a bit more, filter later
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
             console.error("[Slack History Error]", historyError);
             // Keep conversationHistory = "" if error occurs
         }
    } else if (skipHistory) {
        console.log(`[Handler] Skipping history fetch due to reset request.`);
    }

    // Decide Sphere Dynamically (using history if fetched & not skipped)
    sphere = await decideSphere(cleanedQuery, conversationHistory); // Pass potentially empty history
    console.log(`[Handler] Dynamically decided Sphere: ${sphere}`);
    // --- End Sphere Determination ---


    // Update Thinking Message with Sphere Info
    if (thinkingMessageTs) { // Only update if the initial post was successful
        try {
            await slack.chat.update({
                channel: channel,
                ts: thinkingMessageTs,
                // Updated text to use "Sphere"
                text: `:hourglass_flowing_sand: DeepOrbit is thinking... (Sphere: ${sphere})`
            });
             console.log(`[Handler] Updated thinking message (ts: ${thinkingMessageTs}) with Sphere: ${sphere}.`);
        } catch (updateError) {
             console.warn(`[Handler] Failed to update thinking message (ts: ${thinkingMessageTs}):`, updateError.data?.error || updateError.message);
             // Proceed anyway, user just sees the initial "processing..." message
        }
    }

    // Construct the Input for the Final LLM call
    let llmInputText = "";
    // Use history in prompt ONLY if it wasn't skipped and was successfully fetched
    if (conversationHistory && !skipHistory) {
        llmInputText += conversationHistory.trim() + "\n\n";
        llmInputText += `Based on the conversation history above and your knowledge, answer the following query:\n`;
    } else if (skipHistory && conversationHistory) { // Log if history existed but was skipped
         console.log("[Handler] History omitted from final LLM prompt due to reset request.");
    }
    llmInputText += `User Query: ${cleanedQuery}`; // Append the user's actual query
    console.log(`[Handler] Sending input to LLM Sphere ${sphere}...`); // Avoid logging full input


    // Query the chosen LLM Sphere (API endpoint still uses 'workspace')
    try {
        const llmStartTime = Date.now();
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/chat`, { // Use sphere slug here
            message: llmInputText, // Use the combined history + query input
            mode: 'chat',
            sessionId: userId, // Keep for LLM's potential internal state tracking
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 90000, // 90s final timeout
        });
        const llmDuration = Date.now() - llmStartTime;
        console.log(`[Handler] Final LLM call duration: ${llmDuration}ms`);

        const rawReply = llmResponse.data.textResponse || '⚠️ Sorry, I received an empty response.';

        // Convert LLM response to Slack mrkdwn
        let slackFormattedReply = rawReply;
        try {
            slackFormattedReply = slackifyMarkdown(rawReply);
            // console.log("[Handler] Successfully converted response using slackify-markdown."); // Optional log
        } catch (conversionError) {
            console.error("[Handler] Error converting response with slackify-markdown, using raw reply:", conversionError);
            // Keep slackFormattedReply = rawReply in case of error
        }

        // --- Truncation logic is REMOVED ---

        // --- Send final response using Block Kit ---
        try {
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: replyTarget,
                text: slackFormattedReply, // Use full formatted reply as fallback text
                blocks: [
                    { // Response text block
                        "type": "section",
                        // Use the full formatted reply here
                        "text": { "type": "mrkdwn", "text": slackFormattedReply }
                    },
                    { // Divider
                        "type": "divider"
                    },
                    { // Feedback buttons block
                        "type": "actions",
                        "block_id": `feedback_${originalTs}_${sphere}`, // Include sphere in block_id
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
             console.log(`[Handler] Posted final response with feedback buttons to ${channel} (re: ${originalTs}, sphere: ${sphere})`);
        } catch(postError) {
             console.error("[Slack Error] Failed post final response message with blocks (maybe due to length?):", postError.data?.error || postError.message);
             // Fallback to simple text (formatted but not truncated) if blocks fail
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: slackFormattedReply + "\n\n_(Error displaying feedback buttons)_"}).catch(()=>{});
        }

    } catch (error) { // Catch LLM call error
        console.error(`[LLM Error - Sphere: ${sphere}]`, error.response?.data || error.message);
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
// Events API listener *MUST* come before any body parsers that consume the raw body
app.use('/slack/events', slackEvents.requestListener());

// --- Interaction Endpoint ---
// Apply urlencoded middleware specifically to this route for Slack interactions
app.post('/slack/interactions', express.urlencoded({ extended: true, limit: '1mb' }), async (req, res) => {
    // --- !!! CRITICAL: VERIFY SLACK SIGNATURE HERE !!! ---
    console.warn("!!! Interaction signature verification is NOT IMPLEMENTED !!!"); // Placeholder

    let payload;
    try { // Parse payload
        if (!req.body || !req.body.payload) { throw new Error("Missing payload"); }
        payload = JSON.parse(req.body.payload);
    } catch (e) { console.error("Failed parse interaction payload:", e); return res.status(400).send(); }

    // Acknowledge Slack immediately
    res.send();

    // Process interaction asynchronously
    try {
        console.log("[Interaction] Received payload type:", payload.type);
        // Handle button clicks (block_actions)
        if (payload.type === 'block_actions' && payload.actions?.[0]) {
            const action = payload.actions[0];
            const actionId = action.action_id;
            const feedbackValue = action.value;
            const userId = payload.user.id;
            const channelId = payload.channel.id;
            const messageTs = payload.message.ts; // Bot message TS
            const blockId = action.block_id;

            let originalQuestionTs = null;
            let responseSphere = null;
            if (blockId?.startsWith('feedback_')) { // Extract data from block_id
                const parts = blockId.substring(9).split('_');
                originalQuestionTs = parts[0];
                if (parts.length > 1) { responseSphere = parts.slice(1).join('_'); }
            }

            console.log(`[Interaction] User ${userId} clicked '${actionId}' (Value: ${feedbackValue}) on msg ${messageTs}. Original TS: ${originalQuestionTs}, Response Sphere: ${responseSphere}`);

            // Fetch Original User Message Text
            let originalQuestionText = null;
            if (originalQuestionTs && channelId) {
                try {
                    console.log(`[Interaction] Fetching original message text for ts: ${originalQuestionTs}`);
                    const historyResult = await slack.conversations.history({
                        channel: channelId,
                        latest: originalQuestionTs,
                        oldest: originalQuestionTs, // Fetch just this one message
                        inclusive: true,
                        limit: 1
                    });
                    if (historyResult.ok && historyResult.messages && historyResult.messages.length > 0) {
                        originalQuestionText = historyResult.messages[0].text;
                        console.log(`[Interaction] Found original message text.`);
                    } else { console.warn(`[Interaction] Could not find original message for ts ${originalQuestionTs}. Error: ${historyResult.error}`); }
                } catch (historyError) { console.error(`[Interaction] Error fetching original message text:`, historyError); }
            } else { console.warn(`[Interaction] Missing context to fetch original question text.`); }

            // Store the feedback
            await storeFeedback({
                feedback_ts: new Date().toISOString(), feedback_value: feedbackValue,
                user_id: userId, channel_id: channelId, bot_message_ts: messageTs,
                original_user_message_ts: originalQuestionTs, action_id: actionId,
                sphere_slug: responseSphere, // Include sphere slug
                bot_message_text: payload.message?.blocks?.[0]?.text?.text, // Include bot response text
                original_user_message_text: originalQuestionText // Include user question text
            });

            // Optional: Update the original message to show feedback was received
            try {
                await slack.chat.update({
                    channel: channelId, ts: messageTs,
                    text: payload.message.text + "\n\n_🙏 Thanks for the feedback!_", // Update fallback
                    blocks: [
                         payload.message.blocks[0], // Original text block
                         { "type": "context", "elements": [ { "type": "mrkdwn", "text": `_🙏 Thanks for the feedback! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '👌' : '👍'}_)` } ] }
                    ]
                });
                 console.log(`[Interaction] Updated original message ${messageTs}.`);
            } catch (updateError) { console.warn("Failed update message after feedback:", updateError.data?.error || updateError.message); }

        } else if (payload.type === 'view_submission') { console.log("[Interaction] Received view submission"); }
        else { console.log("[Interaction] Received unhandled interaction type:", payload.type); }
    } catch (error) { console.error("[Interaction Handling Error]", error); }
});


// --- Slack Event Listeners ---
slackEvents.on('message', async (event, body) => {
    const eventId = body?.event_id;
    if (await isDuplicateRedis(eventId)) { return; }

    // Filter irrelevant messages
    const subtype = event.subtype;
    const messageUserId = event.user;
    const channelId = event.channel;
    const text = event.text?.trim() ?? '';
    if ( subtype === 'bot_message' || subtype === 'message_deleted' || subtype === 'message_changed' || subtype === 'channel_join' || subtype === 'channel_leave' || subtype === 'thread_broadcast' || !messageUserId || !text || messageUserId === botUserId ) { return; }

    // Check for DM or mention
    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);
    if (isDM || wasMentioned) {
        console.log(`[Processing Event] ID: ${eventId}, User: ${messageUserId}, Channel: ${channelId}, isDM: ${isDM}, Mentioned: ${wasMentioned}`);
        handleSlackMessageEvent(event).catch(err => { console.error("[Unhandled Handler Error] Event ID:", eventId, err); });
    } else { return; }
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
    // Allow time for logs to flush, connections to close etc.
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));