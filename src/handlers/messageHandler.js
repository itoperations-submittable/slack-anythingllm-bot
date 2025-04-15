// src/handlers/messageHandler.js
// This file will contain the main logic for handling incoming Slack message events.

import {
    botUserId,
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
} from '../config.js';
import {
    getAnythingLLMThreadMapping,
    storeAnythingLLMThreadMapping
} from '../services.js'; // Corrected path if services.js is in src/ root
import {
    getWorkspaces,
    createNewAnythingLLMThread,
    queryLlm
} from '../llm.js'; // Corrected path if llm.js is in src/ root
import {
    markdownToRichTextBlock,
    extractTextAndCode,
} from '../formattingService.js'; // Corrected path if formattingService.js is in src/ root
// Import ALL command handlers
import {
    handleDeleteLastMessageCommand, // Now correctly used
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand
} from './commandHandler.js';

/**
 * Handles the core logic for processing an incoming Slack message event.
 * Determines context, handles commands, interacts with LLMs and GitHub, and sends responses.
 *
 * @param {object} event - The Slack message event object.
 * @param {import('@slack/web-api').WebClient} slack - The initialized Slack WebClient.
 * @param {object} appOctokitInstance - The initialized Octokit instance (or null).
 */
async function handleSlackMessageEventInternal(event, slack, appOctokitInstance) {
	const handlerStartTime = Date.now();
	const {
		user: userId,
		text: originalText = '',
		channel,
		ts: originalTs,
		thread_ts: threadTs
	} = event;

	// 1. Initial Processing & Context Setup
	let cleanedQuery = originalText.trim();
	const mentionString = `<@${ botUserId }>`;
	const wasMentioned = originalText.includes( mentionString );
	if ( wasMentioned ) {
		cleanedQuery = cleanedQuery.replace( mentionString, '' ).trim();
	}
	const isDM = channel.startsWith( 'D' );
	const replyTarget = threadTs || originalTs;
	console.log( `[Message Handler] Start. User: ${ userId }, Chan: ${ channel }, OrigTS: ${ originalTs }, ThreadTS: ${ threadTs }, ReplyTargetTS: ${ replyTarget }, Query: "${ cleanedQuery }"` );

	// 2. Handle #delete_last_message command USING the imported handler
	if ( cleanedQuery.toLowerCase().startsWith( '#delete_last_message' ) ) {
		console.log("[Message Handler] Delete command detected, calling command handler...");
		// Call the imported handler function
		const deleteHandled = await handleDeleteLastMessageCommand(channel, replyTarget, botUserId, slack);
		if (deleteHandled) {
		    console.log("[Message Handler] Delete command handled by commandHandler.");
		    return; // Exit after handling delete command
		} else {
		    // Should not happen if the handler always returns true, but good practice
		    console.warn("[Message Handler] handleDeleteLastMessageCommand returned false unexpectedly.");
		    // Fall through might be desired in some error cases within the handler,
		    // but based on commandHandler.js, it returns true even on error.
		    return;
		}
	}

	// 3. Post Initial Processing Message (Asynchronously)
	let thinkingMessageTs = null;
	const thinkingMessagePromise = slack.chat.postMessage( {
		channel,
		thread_ts: replyTarget,
		text: ":hourglass_flowing_sand: Processing..."
	} ).then( initialMsg => {
		thinkingMessageTs = initialMsg.ts;
		console.log( `[Message Handler] Posted initial thinking message (ts: ${ thinkingMessageTs }).` );
		return thinkingMessageTs;
	} ).catch( slackError => {
		console.error( "[Message Error] Failed post initial thinking message:", slackError.data?.error || slackError.message );
		return null;
	} );

	// --- Determine AnythingLLM Thread and Workspace EARLY ---
	let anythingLLMThreadSlug = null;
	let workspaceSlugForThread = null;
	try {
		const existingMapping = await getAnythingLLMThreadMapping( channel, replyTarget );
		if ( existingMapping ) {
			anythingLLMThreadSlug = existingMapping.anythingllm_thread_slug;
			workspaceSlugForThread = existingMapping.anythingllm_workspace_slug;
			console.log( `[Message Handler] Found existing AnythingLLM thread: ${ workspaceSlugForThread }:${ anythingLLMThreadSlug }` );
		} else {
			console.log( `[Message Handler] No existing AnythingLLM thread found for Slack thread ${ replyTarget }. Determining initial sphere...` );
			let initialSphere = 'all'; // Default sphere
			const overrideRegex = /#(\S+)/;
			const match = cleanedQuery.match( overrideRegex );
			if ( match && match[ 1 ] ) {
				const potentialWorkspace = match[ 1 ];
				const availableWorkspaces = await getWorkspaces(); // Fetch available slugs
				if ( availableWorkspaces.includes( potentialWorkspace ) ) {
					initialSphere = potentialWorkspace;
					console.log( `[Message Handler] Manual workspace override confirmed for NEW thread: "${ initialSphere }".` );
				} else {
					console.warn( `[Message Handler] Potential override "${ potentialWorkspace }" is not available. Defaulting new thread to 'all'.` );
				}
			}
			workspaceSlugForThread = initialSphere;
			anythingLLMThreadSlug = await createNewAnythingLLMThread( workspaceSlugForThread );
			if ( ! anythingLLMThreadSlug ) {
				throw new Error( `Failed to create a new AnythingLLM thread in workspace ${ workspaceSlugForThread }.` );
			}
			await storeAnythingLLMThreadMapping( channel, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug );
			console.log(`[Message Handler] Created and stored new mapping: Slack ${channel}:${replyTarget} -> AnythingLLM ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
		}
	} catch ( threadError ) {
		console.error( "[Message Handler] Error determining/creating AnythingLLM thread:", threadError );
		await slack.chat.postMessage( {
			channel,
			thread_ts: replyTarget,
			text: `⚠️ Oops! I had trouble connecting to the knowledge base thread.`
		} ).catch( () => {} );
		const ts = await thinkingMessagePromise;
		if ( ts ) {
			slack.chat.delete( { channel: channel, ts: ts } ).catch( () => {} );
		}
		return; // Critical error, cannot proceed
	}
	// --- End Determine Thread Early ---


	// 4. --- Call Specific Command Handlers Sequentially ---

	// Check 4a: "latest release" command
	let handled = await handleReleaseInfoCommand(cleanedQuery, replyTarget, slack, appOctokitInstance, thinkingMessagePromise, channel);
	if (handled) {
		 console.log("[Message Handler] 'Latest Release' command handled by commandHandler.");
		 return; // Command was handled, exit
	}

	// Check 4b: "review pr" command
	handled = await handlePrReviewCommand(cleanedQuery, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise);
	if (handled) {
		console.log("[Message Handler] 'Review PR' command handled by commandHandler.");
		return; // Command was handled, exit
	}

	// Check 4c: "analyze issue" command
	handled = await handleIssueAnalysisCommand(cleanedQuery, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise, workspaceSlugForThread, anythingLLMThreadSlug);
	if (handled) {
		console.log("[Message Handler] 'Analyze Issue' command handled by commandHandler.");
		return; // Command was handled, exit
	}

	// Check 4d: Generic "github" API command
	const githubApiHandled = await handleGithubApiCommand(cleanedQuery, replyTarget, channel, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug);
	if (githubApiHandled) {
		console.log("[Message Handler] Generic GitHub API command handled by commandHandler.");
		return; // Command was handled, exit
	} else {
		console.log( "[Message Handler] No specific command handled by command handlers, proceeding to main LLM." );
	}


	// 5. --- Main Processing Logic (Fallback if no command handled) ---

	if ( wasMentioned && threadTs) {
		const threadHistory = await fetchConversationHistory(channel, threadTs, originalTs, isDM );
		console.log('[Slack Handler] Thread history fetched:', threadHistory ? 'Yes' : 'No');
		if (threadHistory) {
			cleanedQuery = `${threadHistory}\n\nLatest question: ${cleanedQuery}`;
		}
	}

	try {
		// Update Thinking Message
		const messageTs = await thinkingMessagePromise;
		if ( messageTs ) {
			thinkingMessageTs = messageTs;
			try {
				const thinkingMessages = [ /* ... thinking messages ... */ ];
				const thinkingText = thinkingMessages[ Math.floor( Math.random() * thinkingMessages.length ) ];
				await slack.chat.update( {
					channel,
					ts: thinkingMessageTs,
					text: thinkingText
				} );
				console.log( `[Message Handler] Updated thinking message (ts: ${ thinkingMessageTs }) to: "${ thinkingText }"` );
			} catch ( updateError ) {
				console.warn( `[Message Handler] Failed update thinking message:`, updateError.data?.error || updateError.message );
			}
		}

		// Construct LLM Input
		let llmInputText = cleanedQuery;
		const instruction = '\n\nIMPORTANT: Please do not include context references (like "CONTEXT 0", "CONTEXT 1", etc.) in your response. Provide a clean, professional answer without these annotations, Please do not confirm that you understand my request, just understand it.' +
			'';
		llmInputText += instruction;

		console.log( `[Message Handler] Sending query to AnythingLLM Thread ${ workspaceSlugForThread }:${ anythingLLMThreadSlug }...` );

		// Query LLM using thread endpoint
		const llmStartTime = Date.now();
		const rawReply = await queryLlm( workspaceSlugForThread, anythingLLMThreadSlug, llmInputText );
		console.log( `[Message Handler] LLM call duration: ${ Date.now() - llmStartTime }ms` );
		if ( ! rawReply ) throw new Error( 'LLM returned empty response.' );
		console.log( "[Message Handler Debug] Raw LLM Reply:\n", rawReply );

		// Process and Send Response

		// Check for Substantive Response
		let isSubstantiveResponse = true;
        // ... [Substantive check logic] ...
		const lowerRawReplyTrimmed = rawReply.toLowerCase().trim();
		if ( lowerRawReplyTrimmed.length < MIN_SUBSTANTIVE_RESPONSE_LENGTH ) {
			isSubstantiveResponse = false;
		} // Add other checks as before...

		// Define feedback blocks structure (elements only)
		const feedbackButtonElements = [
            // ... feedback button definitions ...
			{ "type": "button", "text": { "type": "plain_text", "text": "👎", "emoji": true }, "style": "danger", "value": "bad", "action_id": "feedback_bad" },
			{ "type": "button", "text": { "type": "plain_text", "text": "👌", "emoji": true }, "value": "ok", "action_id": "feedback_ok" },
			{ "type": "button", "text": { "type": "plain_text", "text": "👍", "emoji": true }, "style": "primary", "value": "great", "action_id": "feedback_great" }
		];

		// Extract Segments
		const segments = extractTextAndCode( rawReply );
		console.log( `[Message Handler] Extracted ${ segments.length } segments (text/code). Substantive: ${ isSubstantiveResponse }` );
		console.log( `[Message Handler DEBUG] Using replyTargetTS: ${ replyTarget } for posting response.` );

		// Process and Send Each Segment
		for ( let i = 0; i < segments.length; i++ ) {
            // ... [Segment processing logic as before] ...
			const segment = segments[ i ];
			const isLastSegment = i === segments.length - 1;
			let blocksToSend = [];
			let fallbackText = '';

			// ... [Text and Code segment handling creating blocksToSend and fallbackText] ...
			if ( segment.type === 'text' ) {
                // ... [Handle text] ...
				if ( ! segment.content || segment.content.trim().length === 0 ) continue;
				const richTextBlock = markdownToRichTextBlock( segment.content, `msg_${ Date.now() }_${ i }` );
				if ( richTextBlock ) {
					blocksToSend.push( richTextBlock );
					fallbackText = segment.content.replace( /\*\*|_|_|`|\[.*?\]\(.*?\)/g, '' ).substring( 0, 200 );
				} else { continue; }
			} else if ( segment.type === 'code' ) {
                // ... [Handle code] ...
                const language = segment.language || 'text';
                if ( ! segment.content || segment.content.trim().length === 0 ) continue;
                const inlineCodeContent = `\`\`\`${ language }\n${ segment.content }\`\`\``;
                const richTextBlock = markdownToRichTextBlock( inlineCodeContent, `code_${ Date.now() }_${ i }` );
                if ( richTextBlock ) {
                    blocksToSend.push( richTextBlock );
                    fallbackText = `Code Snippet (${ language })`;
                } else { continue; }
			}

			if ( blocksToSend.length === 0 ) continue;

			// Post the message for the current segment
			try {
				const postResult = await slack.chat.postMessage( { /* ... post segment ... */
					channel,
					thread_ts: replyTarget,
					text: fallbackText,
					blocks: blocksToSend
                } );
				const mainMessageTs = postResult?.ts;
				console.log( `[Message Handler] Posted segment ${ i + 1 }/${ segments.length } (ts: ${ mainMessageTs }).` );

				// Post feedback buttons separately
				if ( isLastSegment && isSubstantiveResponse && mainMessageTs && fallbackText ) {
					try {
                        // ... [Feedback button posting logic as before] ...
						console.log( `[Message Handler DEBUG] Posting feedback buttons separately after final segment ${ mainMessageTs }.` );
						const safeFallbackText = fallbackText.substring( 0, 150 );
						const encodedFallback = encodeURIComponent( safeFallbackText );
						const finalFeedbackBlock = [
							{ "type": "divider" },
							{
								"type": "actions",
								"block_id": `feedback_${ originalTs }_${ workspaceSlugForThread }_${ encodedFallback }`,
								"elements": feedbackButtonElements
							}
						];
						const feedbackPostResult = await slack.chat.postMessage( {
							channel,
							thread_ts: replyTarget,
							text: "Feedback:",
							blocks: finalFeedbackBlock
						} );
						console.log( `[Message Handler] Posted feedback buttons separately (ts: ${ feedbackPostResult?.ts }).` );
					} catch ( feedbackPostError ) { /* ... handle error ... */ }
				}

			} catch ( postError ) { /* ... handle post error ... */ }
		}

	} catch ( error ) {
		// Handle Errors
        // ... [Error handling as before] ...
		console.error( '[Message Handler Error]', error );
		try {
			await slack.chat.postMessage( {
				channel,
				thread_ts: replyTarget,
				text: `⚠️ Oops! I encountered an error processing your request. (Workspace: ${ workspaceSlugForThread || 'unknown' })`
			} );
		} catch ( slackError ) { /* ... handle error posting error ... */ }

	} finally {
		// Cleanup Thinking Message
        // ... [Cleanup as before] ...
		if ( thinkingMessageTs ) {
			try {
				await slack.chat.delete( { channel: channel, ts: thinkingMessageTs } );
				console.log( `[Message Handler] Deleted thinking message (ts: ${ thinkingMessageTs }).` );
			} catch ( delErr ) { console.warn( "Failed delete thinking message:", delErr.data?.error || delErr.message ); }
		}
		const handlerEndTime = Date.now();
		console.log( `[Message Handler] Finished processing event for ${ userId }. Total duration: ${ handlerEndTime - handlerStartTime }ms` );
	}
}

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
export { handleSlackMessageEventInternal };
