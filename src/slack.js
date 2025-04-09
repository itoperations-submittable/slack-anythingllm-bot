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
import { isDuplicateRedis, splitMessageIntoChunks, formatSlackMessage, extractTextAndCode, getSlackFiletype } from './utils.js';
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

        // 5. Determine Target Sphere (Thread Cache -> Manual Override -> Default 'all')
        // History fetching is removed here as it was only for dynamic routing
        let workspaceSource = 'DefaultAll';

        // 5a. Check Thread Workspace Cache
        if (threadTs && isRedisReady) { // Only cache for threads
            try {
                const cachedSphere = await redisClient.get(threadWorkspaceKey);
                if (cachedSphere) {
                    sphere = cachedSphere;
                    workspaceSource = 'ThreadCache';
                    console.log(`[Slack Handler] Using cached workspace "${sphere}" for thread ${threadTs}.`);
                }
            } catch (err) { console.error(`[Redis Error] Failed get thread workspace cache ${threadWorkspaceKey}:`, err); }
        }

        // 5b. Check for Manual Workspace Override (if not using thread cache)
        if (workspaceSource === 'DefaultAll') {
            const overrideRegex = /#(\S+)/;
            const match = cleanedQuery.match(overrideRegex);
            if (match && match[1]) {
                const potentialWorkspace = match[1];
                console.log(`[Slack Handler] Found potential manual override: "${potentialWorkspace}"`);
                const availableWorkspaces = await getWorkspaces();
                if (availableWorkspaces.includes(potentialWorkspace)) {
                    sphere = potentialWorkspace;
                    workspaceSource = 'ManualOverride';
                    console.log(`[Slack Handler] Manual workspace override confirmed: "${sphere}". Query remains: "${cleanedQuery}"`);
               } else {
                    console.warn(`[Slack Handler] Potential override "${potentialWorkspace}" is not an available workspace. Defaulting to 'all'.`);
                    // Sphere remains 'all' if override is invalid
                }
            }
        }

        // 5c. Dynamic Routing REMOVED - Sphere remains default ('all') if not overridden
        console.log(`[Slack Handler] Final Sphere determined: ${sphere} (Source: ${workspaceSource})`);

        // --- End Sphere Determination ---

        // 6. Update Thinking Message with Sphere (if not default 'all')
        try {
            let thinkingText = ":hourglass_flowing_sand: Thinking";
            if (sphere !== 'all') {
                thinkingText += ` in sphere [${sphere}]`;
            }
            thinkingText += "...";
            await slack.chat.update({ channel, ts: thinkingMessageTs, text: thinkingText });
            console.log(`[Slack Handler] Updated thinking message (ts: ${thinkingMessageTs}) to: "${thinkingText}"`);
        } catch (updateError) { console.warn(`[Slack Handler] Failed update thinking message:`, updateError.data?.error || updateError.message); }

        // 7. Fetch History (if not skipped by reset)
        let conversationHistory = "";
        if (!skipHistory) {
            console.log("[Slack Handler] Fetching history for LLM context...");
            conversationHistory = await fetchConversationHistory(channel, threadTs, originalTs, isDM);
        }

        // 8. Construct Final LLM Input (Always include history if fetched)
        let llmInputText = "";
        if (conversationHistory) { // Check if history string is non-empty
            llmInputText += conversationHistory.trim() + "\n\nBased on the conversation history above...\n";
            console.log(`[Slack Handler] Including history in final prompt.`);
        } else {
             console.log("[Slack Handler] No history included in final prompt (either skipped by reset or none found).");
        }
        llmInputText += `User Query: ${cleanedQuery}\n\n`; // Add double newline
        // Add formatting instruction for the LLM
        llmInputText += 'IMPORTANT: Format any code examples using standard Markdown triple backticks, ideally with a language identifier (e.g., ```python ... ```).';
        llmInputText += `\n\n`;
        console.log(`[Slack Handler] Sending input to LLM Sphere ${sphere}...`);

        // 9. Query LLM (Renumbered from 8)
        const llmStartTime = Date.now();
        const rawReply = await queryLlm(sphere, llmInputText, userId);
        console.log(`[Slack Handler] LLM call duration: ${Date.now() - llmStartTime}ms`);

        if (!rawReply) {
            throw new Error('LLM returned empty response.');
        }

        // 10. **NEW**: Process and Send Response Segments (Text and Code Snippets)

        // 10a. Check for Substantive Response (Existing logic, moved slightly)
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

        // 10b. Extract Segments
        const segments = extractTextAndCode(rawReply);
        console.log(`[Slack Handler] Extracted ${segments.length} segments (text/code). Substantive: ${isSubstantiveResponse}`);

        // 10c. Process and Send Each Segment
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const isLastSegment = i === segments.length - 1;

            if (segment.type === 'text') {
                const formattedText = formatSlackMessage(segment.content);
                if (!formattedText || formattedText.length === 0) continue; // Skip empty text segments

                const messageChunks = splitMessageIntoChunks(formattedText, MAX_SLACK_BLOCK_TEXT_LENGTH);

                for (let j = 0; j < messageChunks.length; j++) {
                    const chunk = messageChunks[j];
                    const isLastChunkOfLastSegment = isLastSegment && (j === messageChunks.length - 1);

                    const currentBlocks = [{ "type": "section", "text": { "type": "mrkdwn", "text": chunk } }];

                    // Add feedback buttons ONLY to the very last text chunk of a substantive response
                    if (isLastChunkOfLastSegment && isSubstantiveResponse) {
                        console.log("[Slack Handler] Adding feedback buttons to final text chunk.");
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
                        await slack.chat.postMessage({
                            channel: channel,
                            thread_ts: replyTarget,
                            text: chunk, // Fallback text
                            blocks: currentBlocks
                        });
                        console.log(`[Slack Handler] Posted text chunk ${j + 1}/${messageChunks.length} for segment ${i + 1}/${segments.length}.`);
                    } catch (postError) {
                        console.error(`[Slack Error] Failed post text chunk ${j + 1}:`, postError.data?.error || postError.message);
                        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error displaying part of the response)_` }).catch(()=>{});
                        break; // Stop sending further chunks for this segment
                    }
                }

            } else if (segment.type === 'code') {
                const filetype = getSlackFiletype(segment.language);
                const filename = `code_snippet.${filetype === 'text' ? 'txt' : filetype}`; // Simple filename
                const title = `Code Snippet (${segment.language || 'unknown'})`;
                console.log(`[Slack Handler] Uploading code snippet: Lang=${segment.language}, Filetype=${filetype}, Filename=${filename}`);

                try {
                    await slack.files.uploadV2({
                        channel_id: channel,
                        thread_ts: replyTarget, // Upload to the thread
                        content: segment.content,
                        filename: filename, // Rely on filename extension for type detection
                        title: title,
                        initial_comment: `\`${title}\``
                    });
                    console.log(`[Slack Handler] Posted code snippet for segment ${i + 1}/${segments.length}.`);

                    // Add feedback buttons if this is the VERY LAST segment and it's substantive
                    if (isLastSegment && isSubstantiveResponse) {
                        console.log("[Slack Handler] Adding feedback buttons after final code snippet.");
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

                } catch (uploadError) {
                    console.error(`[Slack Error] Failed upload code snippet:`, uploadError.data?.error || uploadError.message);
                    await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error uploading code snippet)_` }).catch(()=>{});
                }
            }
        }

    } catch (error) {
        console.error("[Slack Handler] Error in main processing logic:", error);
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error processing response)_` }).catch(()=>{});
    }
    finally {
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
        // console.log("[Slack Event Wrapper] Ignoring event subtype:", subtype || 'missing/invalid user/text');
        return;
    }

    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);

    if (isDM || wasMentioned) {
        console.log(`[Slack Event Wrapper] Processing relevant event ID: ${eventId}`);
        // Run the internal handler asynchronously, don't block the event ACK
        handleSlackMessageEventInternal(event).catch(err => {
            console.error("[Slack Event Wrapper] Unhandled Internal Handler Error, Event ID:", eventId, err);
        });
    } else {
        // console.log("[Slack Event Wrapper] Ignoring non-mention/non-DM message, Event ID:", eventId);
        return;
    }
}

// --- Interaction Handler --- (Handles button clicks etc.)
export async function handleInteraction(req, res) {
    // IMPORTANT: Verify signature in production! (Middleware is recommended)
    // https://api.slack.com/authentication/verifying-requests-from-slack
    // For simplicity, we skip verification here, but log a warning.
    console.warn("!!! Interaction signature verification is NOT IMPLEMENTED !!!");

    let payload;
    try {
        // Slack sends payload in the body, URL-encoded
        if (!req.body || !req.body.payload) {
            throw new Error("Missing interaction payload");
        }
        payload = JSON.parse(req.body.payload);
    } catch (e) {
        console.error("Failed to parse interaction payload:", e);
        return res.status(400).send('Invalid payload');
    }

    // Acknowledge the interaction immediately (within 3 seconds)
    res.send();

    // Process the interaction asynchronously
    try {
        console.log("[Interaction Handler] Received type:", payload.type);
        if (payload.type === 'block_actions' && payload.actions?.[0]) {
            const action = payload.actions[0];
            const { action_id: actionId, block_id: blockId } = action;
            const { id: userId } = payload.user;
            const { id: channelId } = payload.channel;
            const { ts: messageTs } = payload.message; // TS of the message containing the button

            // Handle Feedback Buttons
            if (actionId.startsWith('feedback_')) {
                const feedbackValue = action.value; // 'bad', 'ok', or 'great'
                let originalQuestionTs = null;
                let responseSphere = null;

                // Extract original message TS and sphere from block_id
                if (blockId?.startsWith('feedback_')) {
                    const parts = blockId.substring(9).split('_'); // Remove 'feedback_'
                    originalQuestionTs = parts[0];
                    if (parts.length > 1) {
                        responseSphere = parts.slice(1).join('_'); // Handle spheres with underscores
                    }
                }
                console.log(`[Interaction Handler] Feedback: User ${userId}, Val ${feedbackValue}, OrigTS ${originalQuestionTs}, Sphere ${responseSphere}`);

                // Attempt to fetch original user message text for context (optional but useful)
                let originalQuestionText = null;
                 if (originalQuestionTs && channelId) {
                     try {
                         const historyResult = await slack.conversations.history({
                             channel: channelId,
                             latest: originalQuestionTs,
                             oldest: originalQuestionTs, // Fetch only the specific message
                             inclusive: true,
                             limit: 1
                         });
                         if (historyResult.ok && historyResult.messages?.[0]?.text) {
                            originalQuestionText = historyResult.messages[0].text;
                         } else { console.warn("[Interaction] Failed to fetch original message text or msg not found."); }
                     } catch (historyError) {
                         console.error('[Interaction] Error fetching original message text:', historyError.data?.error || historyError.message);
                     }
                 }

                 // Store the feedback (using the imported function)
                 await storeFeedback({
                     feedback_value: feedbackValue,
                     user_id: userId,
                     channel_id: channelId,
                     bot_message_ts: messageTs, // TS of the bot's message with buttons
                     original_user_message_ts: originalQuestionTs, // TS of the user's original query
                     action_id: actionId,
                     sphere_slug: responseSphere,
                     bot_message_text: payload.message?.blocks?.[0]?.text?.text, // Text from the first block of bot message
                     original_user_message_text: originalQuestionText
                 });

                 // Update the original message to show feedback was received
                 try {
                     // Reconstruct original blocks (assuming first block is text, second is divider, third is actions)
                     const originalBlocks = payload.message.blocks;
                     if (originalBlocks && originalBlocks.length >= 3) {
                         const updatedBlocks = [
                             originalBlocks[0], // Keep the original text block
                             originalBlocks[1], // Keep the divider
                             { "type": "context", "elements": [ { "type": "mrkdwn", "text": `🙏 Thanks for the feedback! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '��' : '👍'}_)` } ] }
                         ];
                         await slack.chat.update({
                             channel: channelId,
                             ts: messageTs,
                             text: payload.message.text + "\n\n🙏 Thanks!", // Update fallback text
                             blocks: updatedBlocks
                         });
                          console.log(`[Interaction Handler] Updated message ${messageTs} to reflect feedback.`);
                     } else {
                          console.warn("[Interaction Handler] Could not update feedback message - unexpected block structure.");
                     }
                 } catch (updateError) {
                     console.warn("Failed to update feedback message:", updateError.data?.error || updateError.message);
                 }
            }
            // Add other block action handlers here if needed...
        }
        // Add other interaction type handlers here (e.g., view_submission) if needed...
    } catch (error) {
        console.error("[Interaction Handling Error] An error occurred:", error);
    }
}
