import { WebClient } from '@slack/web-api';
import { createEventAdapter } from '@slack/events-api';
import {
    slackToken,
    slackSigningSecret,
    botUserId,
    RESET_HISTORY_REDIS_PREFIX,
    RESET_HISTORY_TTL,
    THREAD_WORKSPACE_PREFIX,
    THREAD_WORKSPACE_TTL,
    WORKSPACE_OVERRIDE_COMMAND_PREFIX,
    MAX_SLACK_BLOCK_TEXT_LENGTH,
    RESET_CONVERSATION_COMMAND,
    databaseUrl,
    redisUrl
} from './config.js';
import { isDuplicateRedis, splitMessageIntoChunks, formatSlackMessage } from './utils.js';
import { redisClient, isRedisReady, dbPool } from './services.js';
import { decideSphere, queryLlm, getWorkspaces } from './llm.js';

// Initialize Slack clients
export const slack = new WebClient(slackToken);
export const slackEvents = createEventAdapter(slackSigningSecret, { includeBody: true });

// --- History Fetching --- (Adapted from original handler)
async function fetchConversationHistory(channel, threadTs, originalTs, isDM) {
    const HISTORY_LIMIT = 10;
    let historyResult;
    try {
        if (!isDM && threadTs) {
            console.log(`[Slack Service/History] Fetching thread replies: Channel=${channel}, ThreadTS=${threadTs}`);
            historyResult = await slack.conversations.replies({
                channel: channel,
                ts: threadTs,
                limit: HISTORY_LIMIT + 1,
            });
        } else {
            console.log(`[Slack Service/History] Fetching channel/DM history: Channel=${channel}, Latest=${originalTs}, isDM=${isDM}`);
            historyResult = await slack.conversations.history({
                channel: channel,
                latest: originalTs,
                limit: HISTORY_LIMIT,
                inclusive: false
            });
        }

        if (historyResult.ok && historyResult.messages) {
            const relevantMessages = historyResult.messages
                .filter(msg => msg.user && msg.text && msg.user !== botUserId)
                .reverse();

            if (relevantMessages.length > 0) {
                let history = "Conversation History:\n";
                relevantMessages.forEach(msg => {
                    history += `User ${msg.user}: ${msg.text}\n`;
                });
                console.log(`[Slack Service/History] Fetched ${relevantMessages.length} relevant messages.`);
                return history;
            } else {
                console.log("[Slack Service/History] No relevant prior messages found.");
            }
        } else {
            console.warn("[Slack Service/History] Failed fetch history:", historyResult.error || "No messages found");
        }
    } catch (error) {
        console.error("[Slack Service/History Error]", error);
    }
    return ""; // Return empty string if no history or error
}

// --- Feedback Storage --- (Adapted from original handler)
async function storeFeedback(feedbackData) {
    if (!databaseUrl || !dbPool) {
        console.warn("DATABASE_URL not configured, logging feedback to console only.");
        console.log("--- FEEDBACK (Console Log) ---", JSON.stringify(feedbackData, null, 2));
        return;
    }
    const insertQuery = `
        INSERT INTO feedback (feedback_value, user_id, channel_id, bot_message_ts, original_user_message_ts, action_id, sphere_slug, bot_message_text, original_user_message_text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id;`;
    const values = [
        feedbackData.feedback_value || null, feedbackData.user_id || null,
        feedbackData.channel_id || null, feedbackData.bot_message_ts || null,
        feedbackData.original_user_message_ts || null, feedbackData.action_id || null,
        feedbackData.sphere_slug || null, feedbackData.bot_message_text || null,
        feedbackData.original_user_message_text || null
    ];
    let client;
    try {
        client = await dbPool.connect();
        console.log(`[Slack Service/Feedback] Inserting: User=${values[1]}, Val=${values[0]}, Sphere=${values[6]}`);
        const result = await client.query(insertQuery, values);
        if (result.rows?.[0]?.id) {
             console.log(`[Slack Service/Feedback] Saved ID: ${result.rows[0].id}`);
        } else {
             console.warn('[Slack Service/Feedback] Insert OK, no ID.');
        }
    } catch (err) {
        console.error('[Slack Service/Feedback DB Error]', err);
    } finally {
        if (client) client.release();
    }
}

// --- Main Event Handler Logic --- (Refactored)
async function handleSlackMessageEventInternal(event) {
    const handlerStartTime = Date.now();
    const { user: userId, text: originalText = '', channel, ts: originalTs, thread_ts: threadTs, event_ts } = event;

    // 1. Initial Processing & Context Setup
    let cleanedQuery = originalText.trim();
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = originalText.includes(mentionString);
    if (wasMentioned) { cleanedQuery = cleanedQuery.replace(mentionString, '').trim(); }

    const isDM = channel.startsWith('D');
    const replyTarget = isDM ? undefined : (threadTs || originalTs);
    // Use threadTs for context key if available, otherwise originalTs (for top-level DMs/mentions)
    const contextTs = threadTs || originalTs;
    const threadWorkspaceKey = `${THREAD_WORKSPACE_PREFIX}${channel}:${contextTs}`;

    console.log(`[Slack Handler] Start. User: ${userId}, Chan: ${channel}, OrigTS: ${originalTs}, ThreadTS: ${threadTs}, ContextTS: ${contextTs}, Query: "${cleanedQuery}"`);

    // 2. Check for Reset Command
    if (originalText.toLowerCase() === RESET_CONVERSATION_COMMAND) {
        if (redisUrl && isRedisReady) {
            try {
                const resetKey = `${RESET_HISTORY_REDIS_PREFIX}${channel}`;
                await redisClient.set(resetKey, 'true', { EX: RESET_HISTORY_TTL });
                console.log(`[Slack Handler] Set reset flag ${resetKey}`);
                await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "✅ Conversation context will be ignored for your next message." });
            } catch (redisError) {
                console.error(`[Redis Error] Failed set reset flag for ${channel}:`, redisError);
                await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "⚠️ Error setting conversation reset flag." });
            }
        } else {
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "⚠️ Cannot reset conversation context (feature unavailable)." });
        }
        return;
    }

    // 3. Post Initial Processing Message
    let thinkingMessageTs = null;
    try {
        const initialMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: ":hourglass_flowing_sand: Processing..." });
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Slack Handler] Posted thinking message (ts: ${thinkingMessageTs}).`);
    } catch (slackError) {
         console.error("[Slack Error] Failed post initial thinking message:", slackError.data?.error || slackError.message);
         // If this fails, we can't update/delete later, might as well stop.
         return;
    }

    // --- Main Processing Logic (Try/Catch/Finally for cleanup) ---
    let sphere = 'all'; // Default sphere is now 'all'
    try {
        // 4. Check History Reset Flag
        let skipHistory = false;
        if (redisUrl && isRedisReady) {
            const resetKey = `${RESET_HISTORY_REDIS_PREFIX}${channel}`;
            try {
                if (await redisClient.del(resetKey) === 1) { // Try to delete the key, if it existed, set flag
                    console.log(`[Slack Handler] Reset flag found and deleted for ${channel}. Skipping history.`);
                    skipHistory = true;
                }
            } catch(redisError) { console.error(`[Redis Error] Failed check/delete reset flag ${resetKey}:`, redisError); }
        }

        // 5. Determine Target Sphere (Thread Cache -> Manual Override -> Dynamic Routing)
        let conversationHistory = "";
        let workspaceSource = 'DefaultAll'; // Updated default source name

        // 5a. Check Thread Workspace Cache
        if (threadTs && isRedisReady) { // Only cache for threads
            try {
                const cachedSphere = await redisClient.get(threadWorkspaceKey);
                if (cachedSphere) {
                    sphere = cachedSphere;
                    workspaceSource = 'ThreadCache';
                    console.log(`[Slack Handler] Using cached workspace "${sphere}" for thread ${threadTs}.`);
                    // If using cached workspace, we assume history is implicitly handled by thread context
                    skipHistory = true; // Don't fetch history again if we have thread context
                }
            } catch (err) { console.error(`[Redis Error] Failed get thread workspace cache ${threadWorkspaceKey}:`, err); }
        }

        // 5b. Check for Manual Workspace Override (if not using thread cache)
        if (workspaceSource === 'DefaultAll') {
            // Use regex to find the first occurrence of # followed by non-space characters
            const overrideRegex = /#(\S+)/;
            const match = cleanedQuery.match(overrideRegex);

            if (match && match[1]) { // If regex match is found
                const potentialWorkspace = match[1];
                console.log(`[Slack Handler] Found potential manual override: "${potentialWorkspace}"`);

                const availableWorkspaces = await getWorkspaces(); // Get list to validate against
                if (availableWorkspaces.includes(potentialWorkspace)) {
                    sphere = potentialWorkspace;
                    // Remove the matched override tag (e.g., "#gf-stripe") from the query string
                    // cleanedQuery = cleanedQuery.replace(match[0], '').trim(); // --- Keep the tag in the query
                    workspaceSource = 'ManualOverride';
                    skipHistory = true; // Manual override implies user wants specific context now
                    console.log(`[Slack Handler] Manual workspace override confirmed: "${sphere}". Query remains: "${cleanedQuery}"`); // Updated log
               } else {
                    // Log if the specified workspace doesn't exist, but continue (will likely use dynamic routing or default)
                    console.warn(`[Slack Handler] Potential override "${potentialWorkspace}" is not an available workspace. Ignoring.`);
                }
            }
        }

        // 5c. Dynamic Routing (if no cache or override)
        if (workspaceSource === 'DefaultAll') {
            console.log(`[Slack Handler] No thread cache or manual override. Proceeding with history fetch and dynamic routing...`);
            // Fetch history only if needed for routing & not explicitly skipped
            if (!skipHistory) {
                conversationHistory = await fetchConversationHistory(channel, threadTs, originalTs, isDM);
            }
            sphere = await decideSphere(cleanedQuery, conversationHistory);
            workspaceSource = 'DynamicRouting';
            console.log(`[Slack Handler] Dynamically decided Sphere: ${sphere}`);

             // Cache the decided sphere for the thread if dynamic routing was used AND it's not the default 'all'
             if (threadTs && isRedisReady && sphere !== 'all') { // Condition changed from 'public' to 'all'
                 try {
                     await redisClient.set(threadWorkspaceKey, sphere, { EX: THREAD_WORKSPACE_TTL });
                     console.log(`[Slack Handler] Cached workspace "${sphere}" for thread ${threadTs} (TTL: ${THREAD_WORKSPACE_TTL}s).`);
                 } catch (err) { console.error(`[Redis Error] Failed set thread workspace cache ${threadWorkspaceKey}:`, err); }
             }
        }
        // --- End Sphere Determination ---

        // 6. Update Thinking Message with Sphere
        try {
            await slack.chat.update({ channel, ts: thinkingMessageTs, text: `:hourglass_flowing_sand: Thinking in sphere [${sphere}]...` });
        } catch (updateError) { console.warn(`[Slack Handler] Failed update thinking message:`, updateError.data?.error || updateError.message); }

        // 7. Construct Final LLM Input
        let llmInputText = "";
        if (conversationHistory && !skipHistory && workspaceSource === 'DynamicRouting') {
            // Only include explicitly fetched history if routing decided it was necessary
            llmInputText += conversationHistory.trim() + "\n\nBased on the conversation history above...\n";
            console.log(`[Slack Handler] Including history in final prompt.`); // Simplified log
        }
        llmInputText += `User Query: ${cleanedQuery}`;

        // 8. Query LLM
        const llmStartTime = Date.now();
        const rawReply = await queryLlm(sphere, llmInputText, userId);
        console.log(`[Slack Handler] LLM call duration: ${Date.now() - llmStartTime}ms`);

        if (!rawReply) {
            throw new Error('LLM returned empty response.');
        }

        // 9. Format and Send Response
        const slackFormattedReply = formatSlackMessage(rawReply);
        const messageChunks = splitMessageIntoChunks(slackFormattedReply, MAX_SLACK_BLOCK_TEXT_LENGTH);
        console.log(`[Slack Handler] Response split into ${messageChunks.length} chunk(s).`);

        for (let i = 0; i < messageChunks.length; i++) {
            const chunk = messageChunks[i];
            const isLastChunk = i === messageChunks.length - 1;
            const currentBlocks = [{ "type": "section", "text": { "type": "mrkdwn", "text": chunk } }];

            if (isLastChunk) {
                currentBlocks.push({ "type": "divider" });
                currentBlocks.push({
                    "type": "actions", "block_id": `feedback_${originalTs}_${sphere}`,
                    "elements": [
                        { "type": "button", "text": { "type": "plain_text", "text": "👎", "emoji": true }, "style": "danger", "value": "bad", "action_id": "feedback_bad" },
                        { "type": "button", "text": { "type": "plain_text", "text": "👌", "emoji": true }, "value": "ok", "action_id": "feedback_ok" },
                        { "type": "button", "text": { "type": "plain_text", "text": "👍", "emoji": true }, "style": "primary", "value": "great", "action_id": "feedback_great" }
                    ]
                });
            }

            try {
                // Post chunks. NOTE: Non-streaming means we post all chunks after getting full LLM response.
                // All chunks are posted as new messages in the replyTarget thread.
                 await slack.chat.postMessage({
                     channel: channel,
                     thread_ts: replyTarget, // Thread all response parts to the original context
                     text: chunk, // Fallback text
                     blocks: currentBlocks
                 });
                 console.log(`[Slack Handler] Posted chunk ${i + 1}/${messageChunks.length}.`);
            } catch (postError) {
                 console.error(`[Slack Error] Failed post chunk ${i + 1}:`, postError.data?.error || postError.message);
                 await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error displaying part ${i + 1} of the response)_` }).catch(()=>{});
                 break; // Stop sending further chunks
            }
        }

    } catch (error) {
        // 10. Handle Errors
        console.error('[Slack Handler Error]', error);
        try {
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `⚠️ Oops! I encountered an error processing your request. (Sphere: ${sphere})` });
        } catch (slackError) { console.error("[Slack Error] Failed post error message:", slackError.data?.error || slackError.message); }

    } finally {
        // 11. Cleanup Thinking Message
        if (thinkingMessageTs) {
            try {
                await slack.chat.delete({ channel: channel, ts: thinkingMessageTs });
                console.log(`[Slack Handler] Deleted thinking message (ts: ${thinkingMessageTs}).`);
            } catch (delErr) { console.warn("Failed delete thinking message:", delErr.data?.error || delErr.message); }
        }
        const handlerEndTime = Date.now();
        console.log(`[Slack Handler] Finished processing event for ${userId}. Total duration: ${handlerEndTime - handlerStartTime}ms`);
    }
}

// --- Public Event Handler Wrapper --- (Handles deduplication and filtering)
export async function handleSlackEvent(event, body) {
    const eventId = body?.event_id || `no-id:${event.event_ts}`;
    if (await isDuplicateRedis(eventId)) {
         console.log(`[Slack Event Wrapper] Duplicate event skipped: ${eventId}`);
         return;
    }

    const { subtype, user: messageUserId, channel: channelId, text = '' } = event;

    // Filter out unwanted events
    if ( subtype === 'bot_message' || subtype === 'message_deleted' || subtype === 'message_changed' ||
         subtype === 'channel_join' || subtype === 'channel_leave' || subtype === 'thread_broadcast' ||
         !messageUserId || !text || messageUserId === botUserId ) {
        return; // Ignore these events
    }

    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);

    if (isDM || wasMentioned) {
        console.log(`[Slack Event Wrapper] Processing event ID: ${eventId}`);
        // Don't await here, let it run in background
        handleSlackMessageEventInternal(event).catch(err => {
            console.error("[Slack Event Wrapper] Unhandled Handler Error, Event ID:", eventId, err);
        });
    } else {
        // Ignore other channel messages
        return;
    }
}

// --- Interaction Handler --- (Refactored)
export async function handleInteraction(req, res) {
    console.warn("!!! Interaction signature verification is NOT IMPLEMENTED !!!");
    let payload;
    try {
        if (!req.body || !req.body.payload) { throw new Error("Missing payload"); }
        payload = JSON.parse(req.body.payload);
    } catch (e) { console.error("Failed parse interaction payload:", e); return res.status(400).send(); }

    res.send(); // ACK immediately

    try {
        console.log("[Interaction Handler] Received type:", payload.type);
        if (payload.type === 'block_actions' && payload.actions?.[0]) {
            const action = payload.actions[0];
            const { action_id: actionId, block_id: blockId } = action;
            const { id: userId } = payload.user;
            const { id: channelId } = payload.channel;
            const { ts: messageTs } = payload.message;

            if (actionId.startsWith('feedback_')) {
                const feedbackValue = action.value;
                let originalQuestionTs = null;
                let responseSphere = null;
                if (blockId?.startsWith('feedback_')) {
                    const parts = blockId.substring(9).split('_');
                    originalQuestionTs = parts[0];
                    if (parts.length > 1) { responseSphere = parts.slice(1).join('_'); }
                }
                console.log(`[Interaction Handler] Feedback: User ${userId}, Val ${feedbackValue}, OrigTS ${originalQuestionTs}, Sphere ${responseSphere}`);

                let originalQuestionText = null;
                 if (originalQuestionTs && channelId) {
                     try {
                         const historyResult = await slack.conversations.history({ channel: channelId, latest: originalQuestionTs, oldest: originalQuestionTs, inclusive: true, limit: 1 });
                         if (historyResult.ok && historyResult.messages?.[0]) { originalQuestionText = historyResult.messages[0].text; }
                     } catch (historyError) { console.error(`[Interaction] Error fetch original msg:`, historyError); }
                 }

                 await storeFeedback({
                     feedback_value: feedbackValue, user_id: userId, channel_id: channelId,
                     bot_message_ts: messageTs, original_user_message_ts: originalQuestionTs, action_id: actionId,
                     sphere_slug: responseSphere, bot_message_text: payload.message?.blocks?.[0]?.text?.text,
                     original_user_message_text: originalQuestionText
                 });

                 try {
                     await slack.chat.update({
                         channel: channelId, ts: messageTs,
                         text: payload.message.text + "\n\n_🙏 Thanks!_",
                         blocks: [ payload.message.blocks[0], { "type": "context", "elements": [ { "type": "mrkdwn", "text": `_🙏 Thanks! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '👌' : '👍'}_)` } ] } ]
                     });
                 } catch (updateError) { console.warn("Failed update feedback msg:", updateError.data?.error || updateError.message); }
            }
        }
    } catch (error) {
        console.error("[Interaction Handling Error]", error);
    }
}
