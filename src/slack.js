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
import { redisClient, isRedisReady, dbPool, getAnythingLLMThreadMapping, storeAnythingLLMThreadMapping } from './services.js';
import { queryLlm, getWorkspaces, createNewAnythingLLMThread } from './llm.js';

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

// --- Main Event Handler Logic --- (Refactored for AnythingLLM Threads)
async function handleSlackMessageEventInternal(event) {
    const handlerStartTime = Date.now();
    const { user: userId, text: originalText = '', channel, ts: originalTs, thread_ts: threadTs } = event;

    // 1. Initial Processing & Context Setup (Clean query, determine reply target)
    let cleanedQuery = originalText.trim();
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = originalText.includes(mentionString);
    if (wasMentioned) { cleanedQuery = cleanedQuery.replace(mentionString, '').trim(); }
    const isDM = channel.startsWith('D');
    // replyTarget is the TS of the message we reply to, which defines the Slack thread context.
    const replyTarget = threadTs || originalTs; 
    // contextTs is no longer needed for history cache

    console.log(`[Slack Handler] Start. User: ${userId}, Chan: ${channel}, OrigTS: ${originalTs}, ThreadTS: ${threadTs}, ReplyTargetTS: ${replyTarget}, Query: "${cleanedQuery}"`);

    // 2. Check for Reset Command (No longer needed for history, could be repurposed or removed later)
    // if (originalText.toLowerCase() === RESET_CONVERSATION_COMMAND) { ... return; }

    // 3. Post Initial Processing Message
    let thinkingMessageTs = null;
    try {
        const initialMsg = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: ":hourglass_flowing_sand: Processing..." });
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Slack Handler] Posted thinking message (ts: ${thinkingMessageTs}).`);
    } catch (slackError) {
         console.error("[Slack Error] Failed post initial thinking message:", slackError.data?.error || slackError.message);
         return;
    }

    // --- Main Processing Logic (Try/Catch/Finally for cleanup) ---
    let anythingLLMThreadSlug = null;
    let workspaceSlugForThread = null; // Track the workspace associated with the thread
    try {
        // 4. Check History Reset Flag (REMOVED - No longer applicable)

        // 5. Determine Target Sphere & AnythingLLM Thread
        // 5a. Check for existing AnythingLLM thread mapping in DB
        const existingMapping = await getAnythingLLMThreadMapping(channel, replyTarget);
        
        if (existingMapping) {
            anythingLLMThreadSlug = existingMapping.anythingllm_thread_slug;
            workspaceSlugForThread = existingMapping.anythingllm_workspace_slug;
            console.log(`[Slack Handler] Found existing AnythingLLM thread: ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
        } else {
            console.log(`[Slack Handler] No existing AnythingLLM thread found for Slack thread ${replyTarget}. Determining initial sphere...`);
            // 5b. If no mapping, determine initial workspace (check override, default)
            let initialSphere = 'all'; // Default sphere for new threads
            const overrideRegex = /#(\S+)/;
            const match = cleanedQuery.match(overrideRegex);
            if (match && match[1]) {
                const potentialWorkspace = match[1];
                console.log(`[Slack Handler] Found potential manual override for NEW thread: "${potentialWorkspace}"`);
                const availableWorkspaces = await getWorkspaces(); // Use existing workspace fetch
                if (availableWorkspaces.includes(potentialWorkspace)) {
                    initialSphere = potentialWorkspace;
                    console.log(`[Slack Handler] Manual workspace override confirmed for NEW thread: "${initialSphere}".`);
                } else {
                    console.warn(`[Slack Handler] Potential override "${potentialWorkspace}" is not available. Defaulting new thread to 'all'.`);
                }
            }
            workspaceSlugForThread = initialSphere; // The sphere used for this thread

            // 5c. Create new AnythingLLM thread
            anythingLLMThreadSlug = await createNewAnythingLLMThread(workspaceSlugForThread);
            if (!anythingLLMThreadSlug) {
                throw new Error(`Failed to create a new AnythingLLM thread in workspace ${workspaceSlugForThread}.`);
            }

            // 5d. Store the new mapping in DB
            await storeAnythingLLMThreadMapping(channel, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug);
        }

        // --- End Sphere/Thread Determination ---

        // 6. Update Thinking Message (Reverted to simple message)
        try {
            let thinkingText = ":hourglass_flowing_sand: Thinking..."; 
            await slack.chat.update({ channel, ts: thinkingMessageTs, text: thinkingText });
            console.log(`[Slack Handler] Updated thinking message (ts: ${thinkingMessageTs})`);
        } catch (updateError) { console.warn(`[Slack Handler] Failed update thinking message:`, updateError.data?.error || updateError.message); }

        // 7. Fetch History (REMOVED - No longer needed)

        // 8. Construct Final LLM Input (REMOVED - Now just the query)
        const llmInputText = cleanedQuery; // Only the current query is needed
        console.log(`[Slack Handler] Sending query to AnythingLLM Thread ${workspaceSlugForThread}:${anythingLLMThreadSlug}...`);

        // 9. Query LLM using the thread endpoint
        const llmStartTime = Date.now();
        const rawReply = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, llmInputText);
        console.log(`[Slack Handler] LLM call duration: ${Date.now() - llmStartTime}ms`);
        if (!rawReply) throw new Error('LLM returned empty response.');
        console.log("[Slack Handler Debug] Raw LLM Reply:\n", rawReply); // Log raw reply

        // 10. Format and Send Response (Existing logic for formatting/chunking)
        const slackFormattedReply = formatSlackMessage(rawReply);
        console.log("[Slack Handler Debug] Formatted Reply (via slackifyMarkdown):\n", slackFormattedReply); // Log formatted reply
        
        // Check for Substantive Response (Keep this logic)
        let isSubstantiveResponse = true; 
        const lowerRawReply = rawReply.toLowerCase().trim();
        const nonSubstantivePatterns = [
            'sorry', 'cannot', 'unable', "don't know", "do not know", 'no information',
            'how can i help', 'conversation reset', 'context will be ignored',
            'hello', 'hi ', 'hey ', 'thanks', 'thank you',
            'encountered an error'
            // Add more patterns as needed
        ];

        for (const pattern of nonSubstantivePatterns) {
            if (lowerRawReply.includes(pattern)) {
                console.log(`[Slack Handler] Non-substantive pattern found: "${pattern}". Skipping feedback buttons.`);
                isSubstantiveResponse = false;
                break; // Found a match, no need to check further
            }
        }

        const messageChunks = splitMessageIntoChunks(slackFormattedReply, MAX_SLACK_BLOCK_TEXT_LENGTH);
        console.log(`[Slack Handler] Response split into ${messageChunks.length} chunk(s). Substantive: ${isSubstantiveResponse}`);

        for (let i = 0; i < messageChunks.length; i++) {
            const chunk = messageChunks[i];
            const isLastChunk = i === messageChunks.length - 1;
            const currentBlocks = [{ "type": "section", "text": { "type": "mrkdwn", "text": chunk } }];

            // Add feedback buttons (use workspaceSlugForThread in block_id)
            if (isLastChunk && isSubstantiveResponse) { 
                console.log("[Slack Handler] Adding feedback buttons to substantive response.");
                currentBlocks.push({ "type": "divider" });
                currentBlocks.push({
                    "type": "actions", "block_id": `feedback_${originalTs}_${workspaceSlugForThread}`,
                    "elements": [
                        { "type": "button", "text": { "type": "plain_text", "text": "👎", "emoji": true }, "style": "danger", "value": "bad", "action_id": "feedback_bad" },
                        { "type": "button", "text": { "type": "plain_text", "text": "👌", "emoji": true }, "value": "ok", "action_id": "feedback_ok" },
                        { "type": "button", "text": { "type": "plain_text", "text": "👍", "emoji": true }, "style": "primary", "value": "great", "action_id": "feedback_great" }
                    ]
                });
            }

            try {
                 await slack.chat.postMessage({
                     channel: channel,
                     thread_ts: replyTarget, // Always reply to the correct Slack thread
                     text: chunk, // Fallback text
                     blocks: currentBlocks
                 });
                 console.log(`[Slack Handler] Posted chunk ${i + 1}/${messageChunks.length}.`);
            } catch (postError) {
                 console.error(`[Slack Error] Failed post chunk ${i + 1}:`, postError.data?.error || postError.message);
                 await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error displaying part ${i + 1} of the response)_` }).catch(()=>{});
                 break; 
            }
        }

    } catch (error) {
        // 11. Handle Errors
        console.error('[Slack Handler Error]', error);
        try {
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `⚠️ Oops! I encountered an error processing your request. (Workspace: ${workspaceSlugForThread || 'unknown'})` });
        } catch (slackError) { console.error("[Slack Error] Failed post error message:", slackError.data?.error || slackError.message); }

    } finally {
        // 12. Cleanup Thinking Message (Keep this)
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
        return;
    }

    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);

    if (isDM || wasMentioned) {
        console.log(`[Slack Event Wrapper] Processing event ID: ${eventId}`);
        handleSlackMessageEventInternal(event).catch(err => {
            console.error("[Slack Event Wrapper] Unhandled Handler Error, Event ID:", eventId, err);
        });
    } else {
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

    res.send();

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
                     } catch (historyError) { console.error('[Interaction] Error fetch original msg:', historyError); }
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
                         text: payload.message.text + "\n\n🙏 Thanks!",
                         blocks: [ payload.message.blocks[0], { "type": "context", "elements": [ { "type": "mrkdwn", "text": `🙏 Thanks! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '👌' : '👍'}_)` } ] } ]
                     });
                 } catch (updateError) { console.warn("Failed update feedback msg:", updateError.data?.error || updateError.message); }
            }
        }
    } catch (error) {
        console.error("[Interaction Handling Error]", error);
    }
}