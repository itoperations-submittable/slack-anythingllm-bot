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
    MAX_SLACK_BLOCK_CODE_LENGTH,
    RESET_CONVERSATION_COMMAND,
    databaseUrl,
    redisUrl
} from './config.js';
import { isDuplicateRedis, splitMessageIntoChunks, formatSlackMessage, extractTextAndCode, getSlackFiletype } from './utils.js';
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

// --- Corrected Main Event Handler Logic ---
async function handleSlackMessageEventInternal(event) {
    const handlerStartTime = Date.now();
    const { user: userId, text: originalText = '', channel, ts: originalTs, thread_ts: threadTs } = event;

    // 1. Initial Processing & Context Setup
    let cleanedQuery = originalText.trim();
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = originalText.includes(mentionString);
    if (wasMentioned) { cleanedQuery = cleanedQuery.replace(mentionString, '').trim(); }
    const isDM = channel.startsWith('D');
    const replyTarget = threadTs || originalTs;
    console.log(`[Slack Handler] Start. User: ${userId}, Chan: ${channel}, OrigTS: ${originalTs}, ThreadTS: ${threadTs}, ReplyTargetTS: ${replyTarget}, Query: "${cleanedQuery}"`);

    // 2. Reset Command (Commented out, no longer needed for history)
    // if (originalText.toLowerCase() === RESET_CONVERSATION_COMMAND) { ... return; }

    // 3. Post Initial Processing Message (Asynchronously)
    let thinkingMessageTs = null;
    // Create a promise for the thinking message but don't await it yet
    const thinkingMessagePromise = slack.chat.postMessage({ 
        channel, 
        thread_ts: replyTarget, 
        text: ":hourglass_flowing_sand: Processing..." 
    }).then(initialMsg => {
        thinkingMessageTs = initialMsg.ts;
        console.log(`[Slack Handler] Posted initial thinking message (ts: ${thinkingMessageTs}).`);
        return thinkingMessageTs;
    }).catch(slackError => {
        console.error("[Slack Error] Failed post initial thinking message:", slackError.data?.error || slackError.message);
        return null;
    });

    // --- Main Processing Logic ---
    let anythingLLMThreadSlug = null;
    let workspaceSlugForThread = null;
    try {
        // 5. Determine Target Sphere & AnythingLLM Thread
        const existingMapping = await getAnythingLLMThreadMapping(channel, replyTarget);
        
        if (existingMapping) {
            anythingLLMThreadSlug = existingMapping.anythingllm_thread_slug;
            workspaceSlugForThread = existingMapping.anythingllm_workspace_slug;
            console.log(`[Slack Handler] Found existing AnythingLLM thread: ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
        } else {
            console.log(`[Slack Handler] No existing AnythingLLM thread found for Slack thread ${replyTarget}. Determining initial sphere...`);
            let initialSphere = 'all';
            const overrideRegex = /#(\S+)/;
            const match = cleanedQuery.match(overrideRegex);
            if (match && match[1]) {
                const potentialWorkspace = match[1];
                const availableWorkspaces = await getWorkspaces();
                if (availableWorkspaces.includes(potentialWorkspace)) {
                    initialSphere = potentialWorkspace;
                    console.log(`[Slack Handler] Manual workspace override confirmed for NEW thread: "${initialSphere}".`);
                } else {
                    console.warn(`[Slack Handler] Potential override "${potentialWorkspace}" is not available. Defaulting new thread to 'all'.`);
                }
            }
            workspaceSlugForThread = initialSphere;
            anythingLLMThreadSlug = await createNewAnythingLLMThread(workspaceSlugForThread);
            if (!anythingLLMThreadSlug) {
                throw new Error(`Failed to create a new AnythingLLM thread in workspace ${workspaceSlugForThread}.`);
            }
            await storeAnythingLLMThreadMapping(channel, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug);
        }

        // 6. Update Thinking Message (Random theme) if it's ready
        // Check if the thinking message was successfully posted before updating it
        const messageTs = await thinkingMessagePromise;
        if (messageTs) {
            thinkingMessageTs = messageTs; // Ensure the variable is set for later cleanup
            try {
                const thinkingMessages = [
                    ":rocket: Blasting off to knowledge orbit...",
                    ":alien: Consulting my alien overlords...",
                    ":milky_way: Searching the cosmic database...",
                    ":satellite: Sending signals to distant star systems...",
                    ":ringed_planet: Circling Saturn for answers...",
                    ":full_moon: Moonwalking through data...",
                    ":dizzy: Getting lost in a black hole of information...",
                    ":flying_saucer: Abducting relevant facts...",
                    ":astronaut: Spacewalking through code repositories...",
                    ":stars: Counting stars while the database loads...",
                    ":rocket: Houston, we're solving a problem...",
                    ":comet: Riding this comet to find your answer...",
                    ":telescope: Peering into the knowledge universe...",
                    ":robot_face: Engaging hyperdrive processors...",
                    ":shooting_star: Wishing upon a star for good results...",
                    ":new_moon: That's no moon, it's a data station...",
                    ":sun_with_face: Harvesting solar energy for processing power...",
                    ":space_invader: Zapping knowledge barriers...",
                    ":satellite_antenna: Receiving signals from mission control...",
                    ":meteor: Entering knowledge atmosphere at high velocity..."
                ];
                const thinkingText = thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];
                await slack.chat.update({ channel, ts: thinkingMessageTs, text: thinkingText });
                console.log(`[Slack Handler] Updated thinking message (ts: ${thinkingMessageTs}) to: "${thinkingText}"`);
            } catch (updateError) { console.warn(`[Slack Handler] Failed update thinking message:`, updateError.data?.error || updateError.message); }
        }

        // 8. Construct LLM Input (Just the query)
        const llmInputText = cleanedQuery;
        console.log(`[Slack Handler] Sending query to AnythingLLM Thread ${workspaceSlugForThread}:${anythingLLMThreadSlug}...`);

        // 9. Query LLM using thread endpoint
        const llmStartTime = Date.now();
        const rawReply = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, llmInputText);
        console.log(`[Slack Handler] LLM call duration: ${Date.now() - llmStartTime}ms`);
        if (!rawReply) throw new Error('LLM returned empty response.');
        console.log("[Slack Handler Debug] Raw LLM Reply:\n", rawReply);

        // 10. Process and Send Response

        // 10a. Check for Substantive Response
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
                break;
            }
        }

        // Define feedback blocks structure (avoids repetition)
        const feedbackButtonElements = [
            { "type": "button", "text": { "type": "plain_text", "text": "👎", "emoji": true }, "style": "danger", "value": "bad", "action_id": "feedback_bad" },
            { "type": "button", "text": { "type": "plain_text", "text": "👌", "emoji": true }, "value": "ok", "action_id": "feedback_ok" },
            { "type": "button", "text": { "type": "plain_text", "text": "👍", "emoji": true }, "style": "primary", "value": "great", "action_id": "feedback_great" }
        ];
        const feedbackBlock = [
            { "type": "divider" },
            { "type": "actions", "block_id": `feedback_${originalTs}_${workspaceSlugForThread}`, "elements": feedbackButtonElements }
        ];

        // 10b. Extract Segments
        const segments = extractTextAndCode(rawReply);
        console.log(`[Slack Handler] Extracted ${segments.length} segments (text/code). Substantive: ${isSubstantiveResponse}`);

        // *** ADDED: Log substantive check result ***
        console.log(`[Slack Handler DEBUG] isSubstantiveResponse = ${isSubstantiveResponse}`);
        console.log(`[Slack Handler DEBUG] Using replyTargetTS: ${replyTarget} for posting response.`);

        // 10c. Process and Send Each Segment
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const isLastSegment = i === segments.length - 1;

            if (segment.type === 'text') {
                // --- Handle Text Segments ---
                const formattedText = formatSlackMessage(segment.content);
                if (!formattedText || formattedText.trim().length === 0) continue;
                
                const messageChunks = splitMessageIntoChunks(formattedText, MAX_SLACK_BLOCK_TEXT_LENGTH);
                for (let j = 0; j < messageChunks.length; j++) {
                    const chunk = messageChunks[j];
                    const isLastChunkOfLastSegment = isLastSegment && (j === messageChunks.length - 1);
                    
                    // *** Apply trim directly to the final text chunk before sending ***
                    let textToSend = isLastChunkOfLastSegment ? chunk.replace(/(\\\n|\s)+$/, '') : chunk;
                    if (textToSend.length === 0 && !isLastChunkOfLastSegment) continue; // Skip potentially empty intermediate chunks
                    
                    // Remove all escaped newlines from the text before setting it in blocks
                    textToSend = textToSend.replace(/\\n/g, '');
                    
                    // Use a simpler block structure with unique block_id
                    let currentBlocks = [{ 
                        "type": "section", 
                        "text": { "type": "mrkdwn", "text": textToSend },
                        "block_id": `message_${Date.now()}_${j}`
                    }];

                    if (isLastChunkOfLastSegment && isSubstantiveResponse) {
                        // *** ADDED: Log entering feedback block ***
                        console.log("[Slack Handler DEBUG] Adding feedback buttons to text chunk.");
                        console.log("[Slack Handler] Adding feedback buttons to final text chunk.");
                        currentBlocks = currentBlocks.concat(feedbackBlock);
                    }

                    try {
                        // Use a trimmed version for the fallback text parameter
                        const fallbackText = textToSend.replace(/(\\\n|\s)+$/, '').trim();
                        
                        // Add explicit length logging to debug truncation issues
                        console.log(`[Slack Handler LENGTH DEBUG] Sending message chunk with length: ${textToSend.length} chars`);
                        const isCodeContent = textToSend.includes('```');
                        const applicableThreshold = isCodeContent ? MAX_SLACK_BLOCK_CODE_LENGTH : MAX_SLACK_BLOCK_TEXT_LENGTH;
                        if (textToSend.length > applicableThreshold) {
                            console.warn(`[Slack Handler WARNING] Message chunk exceeds ${isCodeContent ? "code" : "text"} threshold (${applicableThreshold}): ${textToSend.length} chars`);
                        }
                        
                        console.log(`[Slack Handler DEBUG] Fallback text (${fallbackText.length} chars): "${fallbackText.substring(0, 50)}..."`);
                        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: fallbackText, blocks: currentBlocks });
                        console.log(`[Slack Handler] Posted text chunk ${j + 1}/${messageChunks.length}.`);
                    } catch (postError) {
                        console.error(`[Slack Error] Failed post text chunk ${j + 1}:`, postError.data?.error || postError.message);
                        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error displaying part ${j + 1} of the response)_` }).catch(() => {});
                        break;
                    }
                }
            } else if (segment.type === 'code') {
                // --- Handle Code Segments ---
                const language = segment.language || 'text';
                const filetype = getSlackFiletype(language);

                if (filetype === 'json') {
                    // --- Upload JSON as File ---
                    const filename = `snippet.json`; 
                    const title = `JSON Snippet`;
                    console.log(`[Slack Handler] Uploading JSON snippet: Filename=${filename}`);
                    try {
                        await slack.files.uploadV2({
                            channel_id: channel,
                            thread_ts: replyTarget,
                            content: segment.content,
                            filename: filename,
                            title: title,
                            initial_comment: `\`${title}\`` 
                        });
                        console.log(`[Slack Handler] Posted JSON snippet.`);

                        // Add feedback buttons *after* the file upload if it's the last segment
                        if (isLastSegment && isSubstantiveResponse) {
                            // *** ADDED: Log entering feedback block ***
                            console.log("[Slack Handler DEBUG] Adding feedback buttons after JSON file.");
                            console.log("[Slack Handler] Adding feedback buttons after final JSON snippet.");
                            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "👍 Thanks!", blocks: feedbackBlock });
                        }
                    } catch (uploadError) {
                        console.error(`[Slack Error] Failed upload JSON snippet:`, uploadError.data?.error || uploadError.message);
                        // Fallback: Post raw code if upload fails
                        const fallbackText = `⚠️ Failed to upload JSON snippet. Raw content:\`\`\`json\n${segment.content}\`\`\``;
                        const fallbackChunks = splitMessageIntoChunks(fallbackText, MAX_SLACK_BLOCK_TEXT_LENGTH);
                        for(const fallbackChunk of fallbackChunks) {
                            // Use a trimmed version of the fallback chunk and remove all escaped newlines
                            let trimmedFallbackChunk = fallbackChunk.replace(/(\\\n|\s)+$/, '').trim();
                            trimmedFallbackChunk = trimmedFallbackChunk.replace(/\\n/g, '');
                            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: trimmedFallbackChunk });
                        } 
                        // Add feedback buttons *after* the fallback post if it was the last segment
                        if (isLastSegment && isSubstantiveResponse) {
                            // *** ADDED: Log entering feedback block ***
                            console.log("[Slack Handler DEBUG] Adding feedback buttons after JSON fallback.");
                            console.log("[Slack Handler] Adding feedback buttons after JSON upload fallback.");
                            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "👍 Thanks!", blocks: feedbackBlock });
                        }
                    }
                } else {
                    // --- Format Other Code Blocks Inline --- 
                    // Reconstruct the markdown block string
                    const inlineCodeContent = `\`\`\`${language}\n${segment.content}\`\`\``;
                    // Use the simple text formatter (it should handle code blocks okay now)
                    const formattedCode = formatSlackMessage(inlineCodeContent); 
                    if (!formattedCode || formattedCode.trim().length === 0) continue;

                    const codeChunks = splitMessageIntoChunks(formattedCode, MAX_SLACK_BLOCK_TEXT_LENGTH);
                    for (let j = 0; j < codeChunks.length; j++) {
                        const chunk = codeChunks[j];
                        const isLastChunkOfLastSegment = isLastSegment && (j === codeChunks.length - 1);
                        
                        // *** Apply trim directly to the final inline code chunk before sending ***
                        let textToSend = isLastChunkOfLastSegment ? chunk.replace(/(\\\n|\s)+$/, '') : chunk;
                        if (textToSend.length === 0 && !isLastChunkOfLastSegment) continue; // Skip potentially empty intermediate chunks
                        
                        // Remove all escaped newlines from the code before setting it in blocks
                        textToSend = textToSend.replace(/\\n/g, '');
                        
                        // Use a simpler block structure with unique block_id
                        let currentBlocks = [{ 
                            "type": "section", 
                            "text": { "type": "mrkdwn", "text": textToSend },
                            "block_id": `code_${Date.now()}_${j}`
                        }];

                        if (isLastChunkOfLastSegment && isSubstantiveResponse) {
                            // *** ADDED: Log entering feedback block ***
                            console.log("[Slack Handler DEBUG] Adding feedback buttons to inline code chunk.");
                            console.log("[Slack Handler] Adding feedback buttons to final inline code chunk.");
                            currentBlocks = currentBlocks.concat(feedbackBlock);
                        }

                        try {
                            // Use a trimmed version for the fallback text parameter
                            const fallbackText = textToSend.replace(/(\\\n|\s)+$/, '').trim();
                            
                            // Add explicit length logging to debug truncation issues
                            console.log(`[Slack Handler LENGTH DEBUG] Sending message chunk with length: ${textToSend.length} chars`);
                            const isCodeContent = textToSend.includes('```');
                            const applicableThreshold = isCodeContent ? MAX_SLACK_BLOCK_CODE_LENGTH : MAX_SLACK_BLOCK_TEXT_LENGTH;
                            if (textToSend.length > applicableThreshold) {
                                console.warn(`[Slack Handler WARNING] Message chunk exceeds ${isCodeContent ? "code" : "text"} threshold (${applicableThreshold}): ${textToSend.length} chars`);
                            }
                            
                            console.log(`[Slack Handler DEBUG] Fallback text (${fallbackText.length} chars): "${fallbackText.substring(0, 50)}..."`);
                            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: fallbackText, blocks: currentBlocks });
                            console.log(`[Slack Handler] Posted inline code chunk ${j + 1}/${codeChunks.length}.`);
                        } catch (postError) {
                            console.error(`[Slack Error] Failed post inline code chunk ${j + 1}:`, postError.data?.error || postError.message);
                            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error displaying part ${j + 1} of the response)_` }).catch(()=>{});
                            break;
                        }
                    }
                }
            }
        }
        // -- End Segment Processing Loop --

    } catch (error) {
        // 11. Handle Errors
        console.error('[Slack Handler Error]', error);
        try {
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `⚠️ Oops! I encountered an error processing your request. (Workspace: ${workspaceSlugForThread || 'unknown'})` });
        } catch (slackError) { console.error("[Slack Error] Failed post error message:", slackError.data?.error || slackError.message); }

    } finally {
        // 12. Cleanup Thinking Message
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
    // *** ADDED: Log raw event object at the very start ***
    console.log("[Slack Event Wrapper RAW EVENT RECEIVED]", JSON.stringify(event, null, 2));

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
        // console.log(\"[Slack Event Wrapper] Ignoring event subtype:\", subtype || \'missing/invalid user/text\");
        return;
    }

    const isDM = channelId.startsWith('D');
    const mentionString = `<@${botUserId}>`;
    const wasMentioned = text.includes(mentionString);

    // *** ADDED: Detailed logging before relevance check ***
    console.log(`[Slack Event Wrapper DEBUG] Event ID: ${eventId}, Type: ${event.type}, Subtype: ${subtype}, User: ${messageUserId}, Channel: ${channelId}, IsDM: ${isDM}, MentionString: "${mentionString}", WasMentioned: ${wasMentioned}, Text: "${text.substring(0, 100)}..."`);

    // Check if it's a relevant event (DM or Mention)
    if (isDM || wasMentioned) {
        console.log(`[Slack Event Wrapper] Processing relevant event ID: ${eventId}`);
        // Run the internal handler asynchronously, don\'t block the event ACK
        handleSlackMessageEventInternal(event).catch(err => {
            console.error("[Slack Event Wrapper] Unhandled Handler Error, Event ID:", eventId, err);
        });
    } else {
        return;
    }
}

// --- Interaction Handler --- (Handles button clicks etc.)
export async function handleInteraction(req, res) {
    console.warn("!!! Interaction signature verification is NOT IMPLEMENTED !!!");

    let payload;
    try {
        if (!req.body || !req.body.payload) {
            throw new Error("Missing interaction payload");
        }
        payload = JSON.parse(req.body.payload);
    } catch (e) {
        console.error("Failed to parse interaction payload:", e);
        return res.status(400).send('Invalid payload');
    }

    res.send(); // Acknowledge immediately

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
                         if (historyResult.ok && historyResult.messages?.[0]?.text) {
                            originalQuestionText = historyResult.messages[0].text;
                         } else { console.warn("[Interaction] Failed to fetch original message text or msg not found."); }
                     } catch (historyError) {
                         console.error('[Interaction] Error fetching original message text:', historyError.data?.error || historyError.message);
                     }
                 }

                 // ** IMPORTANT: Need storeFeedback function accessible here **
                 // Assuming storeFeedback is imported or defined globally/in scope
                 // await storeFeedback({ /* ... feedback data ... */ }); 
                 // Since storeFeedback was removed from app.js, it needs to be handled differently.
                 // Easiest is to import it here if it's now in services.js or utils.js
                 console.log("[Interaction Handler] storeFeedback call is currently commented out - requires import/access.");

                 // Update the original message to show feedback was received
                 try {
                     const originalBlocks = payload.message.blocks;
                     if (originalBlocks && originalBlocks.length > 0) { // Check if blocks exist
                          // Find the actions block to replace (safer than assuming index)
                          const actionBlockIndex = originalBlocks.findIndex(block => block.type === 'actions');
                          let updatedBlocks;
                          
                          if (actionBlockIndex !== -1) {
                              // Replace the actions block with a context block
                              updatedBlocks = [
                                  ...originalBlocks.slice(0, actionBlockIndex),
                                  { "type": "context", "elements": [ { "type": "mrkdwn", "text": `🙏 Thanks for the feedback! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '👌' : '👍'}_)` } ] }
                              ];
                          } else {
                              // If no actions block found (unexpected), just append context
                              console.warn("[Interaction Handler] Could not find actions block to replace in feedback message.");
                              updatedBlocks = [
                                  ...originalBlocks,
                                  { "type": "context", "elements": [ { "type": "mrkdwn", "text": `🙏 Thanks for the feedback! (_${feedbackValue === 'bad' ? '👎' : feedbackValue === 'ok' ? '👌' : '👍'}_)` } ] }
                              ];
                          }
                        
                         await slack.chat.update({
                             channel: channelId,
                             ts: messageTs,
                             text: payload.message.text + "\n\n🙏 Thanks!", 
                             blocks: updatedBlocks
                         });
                          console.log(`[Interaction Handler] Updated message ${messageTs} to reflect feedback.`);
                     } else {
                          console.warn("[Interaction Handler] Could not update feedback message - no blocks found.");
                     }
                 } catch (updateError) {
                     console.warn("Failed to update feedback message:", updateError.data?.error || updateError.message);
                 }
            }
        }
    } catch (error) {
        console.error("[Interaction Handling Error] An error occurred:", error);
    }
}