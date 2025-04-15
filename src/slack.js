import { WebClient } from '@slack/web-api';
import { createEventAdapter } from '@slack/events-api';
import { exportConversationToMarkdown } from './conversation-export.js';
import { Octokit } from '@octokit/rest';
import {
    signingSecret,
    botToken,
    appToken,
    botUserId,
    developerId,
    workspaceMapping,
    fallbackWorkspace,
    enableUserWorkspaces,
    userWorkspaceMapping,
    redisUrl,
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
    MAX_SLACK_BLOCK_TEXT_LENGTH,
	githubToken
} from './config.js';
import { isDuplicateRedis } from './utils.js';
import { splitMessageIntoChunks, extractTextAndCode, getSlackFiletype, markdownToRichTextBlock } from './formattingService.js';
import { redisClient, isRedisReady, dbPool, getAnythingLLMThreadMapping, storeAnythingLLMThreadMapping } from './services.js';
import { queryLlm, getWorkspaces, createNewAnythingLLMThread } from './llm.js';
import { getLatestRelease, getPrDetailsForReview, getGithubIssueDetails, callGithubApi } from './githubService.js';
import { handleSlackMessageEventInternal } from './handlers/messageHandler.js';

// Initialize Slack clients
export const slack = new WebClient(botToken);
const slackEvents = createEventAdapter(signingSecret, { includeBody: true });

// --- Initialize Octokit ONCE ---
let appOctokitInstance = null;
if (githubToken) {
    try {
        appOctokitInstance = new Octokit({ auth: githubToken });
        console.log("[App] Octokit initialized successfully.");
    } catch (error) {
        console.error("[App] Failed to initialize Octokit:", error);
        // Decide how to handle this - maybe exit, maybe run with reduced functionality
    }
} else {
    console.warn("[App] GITHUB_TOKEN not set. GitHub dependent features may fail.");
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

// --- Public Event Handler Wrapper --- (Handles deduplication and filtering)
async function handleSlackEvent(event, body) {

    const eventId = body?.event_id || `no-id:${event.event_ts}`;
    if (await isDuplicateRedis(eventId)) {
        console.log(`[Slack Event Wrapper] Duplicate event skipped: ${eventId}`);
        return;
    }

    // Check for #saveToConversations hashtag
    if (event.type === 'message' && event.text?.includes('#saveToConversations')) {
        console.log('[Slack Event] #saveToConversations detected in thread');
        await handleExportCommand(event.channel, event.thread_ts || event.ts, event.user);
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
            // Run the IMPORTED internal handler asynchronously, PASSING slack and appOctokitInstance
            handleSlackMessageEventInternal(event, slack, appOctokitInstance).catch(err => {
                console.error("[Slack Event Wrapper] Unhandled Handler Error, Event ID:", eventId, err);
            });
        } else {
             console.log(`[Slack Event Wrapper] Ignoring event ID: ${eventId} (Not DM or Mention)`); // Added log for ignored events
            return;
        }
    }

// --- Export Command Handler ---
async function handleExportCommand(channel, thread_ts, user) {
    try {
        // Send initial status message
        const statusMsg = await slack.chat.postMessage({
            channel: channel,
            thread_ts: thread_ts,
            text: ':hourglass: Exporting conversation...',
        });

        // Export the conversation and upload to AnythingLLM
        const { content, metadata, llmResponse, llmError } = await exportConversationToMarkdown(channel, thread_ts, true);

        // Upload as a file in Slack using uploadV2
        await slack.files.uploadV2({
            channel_id: channel,
            thread_ts: thread_ts,
            content: content,
            filename: `conversation-${metadata.channelName}-${thread_ts}.md`,
            title: `Conversation Export - #${metadata.channelName}`,
            initial_comment: 'Here\'s your conversation export! :file_folder:'
        });

        // Prepare status message based on AnythingLLM upload result
        let statusText = ':white_check_mark: Conversation exported successfully!';
        if (llmResponse?.success) {
            statusText += '\n:brain: Added to AnythingLLM conversations workspace!';
        } else if (llmError) {
            statusText += `\n:warning: Note: Could not add to AnythingLLM (${llmError})`;
        }

        // Update status message
        await slack.chat.update({
            channel: channel,
            ts: statusMsg.ts,
            text: statusText
        });

    } catch (error) {
        console.error('Error handling export command:', error);
        await slack.chat.postMessage({
            channel: channel,
            thread_ts: thread_ts,
            text: ':x: Sorry, there was an error exporting the conversation. Please try again.'
        });
        }
    }

// --- Interaction Handler --- (Handles button clicks etc.)
async function handleInteraction(req, res) {
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
                let encodedFallbackText = null; // <-- New variable

                if (blockId?.startsWith('feedback_')) {
                    const parts = blockId.substring(9).split('_'); // Format: origTS_sphere_encodedText
                    originalQuestionTs = parts[0];
                    if (parts.length > 1) { responseSphere = parts[1]; }
                    // The rest is the encoded text (might contain underscores)
                    if (parts.length > 2) { encodedFallbackText = parts.slice(2).join('_'); }
                }
                console.log(`[Interaction Handler] Feedback: User ${userId}, Val ${feedbackValue}, OrigTS ${originalQuestionTs}, Sphere ${responseSphere}, EncodedText? ${!!encodedFallbackText}`);

                // Fetch original *user* question text
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

				// --- Start NEW logic: Decode text from block_id ---
				let actualBotMessageText = null;
				if (encodedFallbackText) {
					try {
						actualBotMessageText = decodeURIComponent(encodedFallbackText);
						console.log(`[Interaction Handler] Decoded bot message text from block_id: "${actualBotMessageText.substring(0, 50)}..."`);
					} catch (decodeError) {
						console.error("[Interaction Handler] Error decoding fallback text from block_id:", decodeError);
					}
				}

				// Fallback if decoding failed or text wasn't in block_id
				if (!actualBotMessageText) {
					console.warn("[Interaction Handler] Could not get bot message text from block_id. Falling back.");
					actualBotMessageText = payload.message.text; // Fallback to "Feedback:"
				}
				// --- End NEW logic ---

				// Store feedback data
				try {
					await storeFeedback({
						feedback_value: feedbackValue,
						user_id: userId,
						channel_id: channelId,
						bot_message_ts: messageTs, // Use button message TS again
						original_user_message_ts: originalQuestionTs || null,
						action_id: actionId,
						sphere_slug: responseSphere || null,
						bot_message_text: actualBotMessageText || null, // Use the decoded/fallback text
						original_user_message_text: originalQuestionText || null
					});
					console.log(`[Interaction Handler] Feedback stored: ${feedbackValue} from ${userId}`);
				} catch (storeFeedbackError) {
					console.error(`[Interaction Handler] Error storing feedback:`, storeFeedbackError);
				}

				// Update UI (No change)
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

export { slackEvents, handleSlackEvent, handleInteraction };
