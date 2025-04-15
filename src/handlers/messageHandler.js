// src/handlers/messageHandler.js
// This file will contain the main logic for handling incoming Slack message events.

import {
    botUserId,
    githubToken, // Needed for checks before calling GitHub functions
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
    MAX_SLACK_BLOCK_TEXT_LENGTH
} from '../config.js';
import {
    getAnythingLLMThreadMapping,
    storeAnythingLLMThreadMapping
} from '../services.js';
import {
    getWorkspaces,
    createNewAnythingLLMThread,
    queryLlm
} from '../llm.js';
import {
    getLatestRelease,
    getPrDetailsForReview,
    getGithubIssueDetails,
    callGithubApi
} from '../githubService.js';
import {
    splitMessageIntoChunks,
    markdownToRichTextBlock,
    extractTextAndCode,
    getSlackFiletype // Added this import back
} from '../formattingService.js';
import {
    handleDeleteLastMessageCommand,
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

// --- Corrected Main Event Handler Logic ---
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

	// 2. Command Handling
	// Check for delete last message command
	if ( cleanedQuery.toLowerCase().includes( '#delete_last_message' ) ) {
		try {
			// Fetch thread history to find bot's last message
			const historyResult = await slack.conversations.replies( {
				channel: channel,
				ts: threadTs || originalTs,
				limit: 20 // Fetch enough messages to find recent bot messages
			} );

			if ( historyResult.ok && historyResult.messages ) {
				// Find the last message from the bot
				const lastBotMessage = historyResult.messages
					.reverse() // Start from most recent
					.find( msg => msg.user === botUserId && ! msg.text?.includes( '✅' ) && ! msg.text?.includes( '❌' ) ); // Exclude confirmation messages

				if ( lastBotMessage ) {
					try {
						// Try to delete the message
						await slack.chat.delete( {
							channel: channel,
							ts: lastBotMessage.ts
						} );
						console.log( `[Message Handler] Successfully deleted last message (ts: ${ lastBotMessage.ts })` );

						// Send confirmation and delete it after 5 seconds
						const confirmMsg = await slack.chat.postMessage( {
							channel: channel,
							thread_ts: replyTarget,
							text: "✅ Last message deleted."
						} );

						// Delete confirmation message after 5 seconds
						setTimeout( async () => {
							try {
								await slack.chat.delete( {
									channel: channel,
									ts: confirmMsg.ts
								} );
							} catch ( deleteError ) {
								console.error( '[Message Handler] Error deleting confirmation:', deleteError );
							}
						}, 5000 );

					} catch ( deleteError ) {
						console.error( '[Message Handler] Error deleting message:', deleteError );
						await slack.chat.postMessage( {
							channel: channel,
							thread_ts: replyTarget,
							text: "❌ Sorry, I couldn't delete the message. It might be too old or I might not have permission."
						} );
					}
				} else {
					await slack.chat.postMessage( {
						channel: channel,
						thread_ts: replyTarget,
						text: "❌ I couldn't find my last message in this thread."
					} );
				}
			} else {
				throw new Error( 'Failed to fetch thread history' );
			}
		} catch ( error ) {
			console.error( '[Message Handler] Error handling delete_last_message:', error );
			await slack.chat.postMessage( {
				channel: channel,
				thread_ts: replyTarget,
				text: "❌ An error occurred while trying to delete the message."
			} );
		}
		return; // Exit after handling delete command
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

	// --- Determine AnythingLLM Thread and Workspace EARLY ---Moved from below---
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
				// If thread creation fails here, we probably can't proceed with *any* LLM call
				throw new Error( `Failed to create a new AnythingLLM thread in workspace ${ workspaceSlugForThread }.` );
			}
			await storeAnythingLLMThreadMapping( channel, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug );
		}
	} catch ( threadError ) {
		console.error( "[Message Handler] Error determining/creating AnythingLLM thread:", threadError );
		await slack.chat.postMessage( {
			channel,
			thread_ts: replyTarget,
			text: `⚠️ Oops! I had trouble connecting to the knowledge base thread.`
		} ).catch( () => {
		} );
		const ts = await thinkingMessagePromise;
		if ( ts ) {
			slack.chat.delete( { channel: channel, ts: ts } ).catch( () => {
			} );
		}
		return; // Critical error, cannot proceed
	}
	// --- End Determine Thread Early ---


	// --- GitHub API Command ---
	const githubApiHandled = await handleGithubApiCommand(cleanedQuery, replyTarget, channel, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug);
	if (githubApiHandled) {
		console.log("[Message Handler] GitHub API command handled by command handler.");
		return;
	} else {
		console.log( "[Message Handler] No command handled, proceeding to main LLM." );
	}


	// --- Main Processing Logic (Only runs if no direct answer/command was handled and returned) ---
	// Thread/workspace slugs are already determined above
	try {
		// Update Thinking Message (if thinking message promise resolved successfully)
		const messageTs = await thinkingMessagePromise;
		if ( messageTs ) {
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

		// 8. Construct LLM Input (Just the query)
		let llmInputText = cleanedQuery; // Start with the base query

		// --- Add instruction for non-GitHub queries --- START
		console.log( "[Message Handler] This is NOT a GitHub command, adding LLM instructions." );
		const instruction = '\n\nIMPORTANT: Please do not include context references (like "CONTEXT 0", "CONTEXT 1", etc.) in your response. Provide a clean, professional answer without these annotations.';
		llmInputText += instruction;
		// --- Add instruction for non-GitHub queries --- END

		console.log( `[Message Handler] Sending query to AnythingLLM Thread ${ workspaceSlugForThread }:${ anythingLLMThreadSlug }...` );

		// 9. Query LLM using thread endpoint
		const llmStartTime = Date.now();
		const rawReply = await queryLlm( workspaceSlugForThread, anythingLLMThreadSlug, llmInputText );
		console.log( `[Message Handler] LLM call duration: ${ Date.now() - llmStartTime }ms` );
		if ( ! rawReply ) throw new Error( 'LLM returned empty response.' );
		console.log( "[Message Handler Debug] Raw LLM Reply:\n", rawReply );

		// 10. Process and Send Response

		// 10a. Refined Check for Substantive Response
		let isSubstantiveResponse = true;
		const lowerRawReplyTrimmed = rawReply.toLowerCase().trim();

		// Rule 1: Check length first
		if ( lowerRawReplyTrimmed.length < MIN_SUBSTANTIVE_RESPONSE_LENGTH ) {
			console.log( `[Message Handler] Reply is short (${ lowerRawReplyTrimmed.length } < ${ MIN_SUBSTANTIVE_RESPONSE_LENGTH }). Skipping feedback buttons.` );
			isSubstantiveResponse = false;
		}

		// Rule 2: Check for exact, simple non-substantive replies (only if still substantive)
		if ( isSubstantiveResponse ) {
			const exactNonSubstantive = [
				'ok', 'done', 'hello', 'hi', 'hey', 'thanks', 'thank you'
			];
			if ( exactNonSubstantive.includes( lowerRawReplyTrimmed ) ) {
				console.log( `[Message Handler] Exact non-substantive match found: "${ lowerRawReplyTrimmed }". Skipping feedback buttons.` );
				isSubstantiveResponse = false;
			}
		}

		// Rule 3: Check if the reply STARTS WITH common refusal or filler phrases (only if still substantive)
		if ( isSubstantiveResponse ) {
			const startingNonSubstantive = [
				'sorry', 'i cannot', 'i am unable', "i don't know", "i do not know", 'i have no information',
				'how can i help', 'conversation reset', 'context will be ignored',
				'hello ', 'hi ', 'hey ', // Keep space for greetings followed by more
				'encountered an error'
			];
			for ( const pattern of startingNonSubstantive ) {
				if ( lowerRawReplyTrimmed.startsWith( pattern ) ) {
					console.log( `[Message Handler] Non-substantive starting pattern found: "${ pattern }". Skipping feedback buttons.` );
					isSubstantiveResponse = false;
					break;
				}
			}
		}

		// Rule 4: Check for specific error messages (using includes is okay here)
		if ( isSubstantiveResponse ) {
			if ( lowerRawReplyTrimmed.includes( 'encountered an error processing your request' ) ) {
				console.log( `[Message Handler] Specific error message found. Skipping feedback buttons.` );
				isSubstantiveResponse = false;
			}
		}

		// Define feedback blocks structure (avoids repetition)
		const feedbackButtonElements = [
			{
				"type": "button",
				"text": { "type": "plain_text", "text": "👎", "emoji": true },
				"style": "danger",
				"value": "bad",
				"action_id": "feedback_bad"
			},
			{
				"type": "button",
				"text": { "type": "plain_text", "text": "👌", "emoji": true },
				"value": "ok",
				"action_id": "feedback_ok"
			},
			{
				"type": "button",
				"text": { "type": "plain_text", "text": "👍", "emoji": true },
				"style": "primary",
				"value": "great",
				"action_id": "feedback_great"
			}
		];
		const feedbackBlock = [
			{ "type": "divider" },
			{
				"type": "actions",
				"block_id": `feedback_${ originalTs }_${ workspaceSlugForThread }`,
				"elements": feedbackButtonElements
			}
		];

		// 10b. Extract Segments
		const segments = extractTextAndCode( rawReply );
		console.log( `[Message Handler] Extracted ${ segments.length } segments (text/code). Substantive: ${ isSubstantiveResponse }` );

		// *** ADDED: Log substantive check result ***
		console.log( `[Message Handler DEBUG] isSubstantiveResponse = ${ isSubstantiveResponse }` );
		console.log( `[Message Handler DEBUG] Using replyTargetTS: ${ replyTarget } for posting response.` );

		// 10c. Process and Send Each Segment
		for ( let i = 0; i < segments.length; i++ ) {
			const segment = segments[ i ];
			const isLastSegment = i === segments.length - 1;
			let blocksToSend = []; // Array to hold blocks for THIS segment
			let fallbackText = ''; // Initialize fallbackText for the segment

			if ( segment.type === 'text' ) {
				// --- Handle Text Segments ---
				if ( ! segment.content || segment.content.trim().length === 0 ) continue;

				console.log( `[Message Handler DEBUG] Converting text segment to single rich_text block` );
				const richTextBlock = markdownToRichTextBlock( segment.content, `msg_${ Date.now() }_${ i }` );

				if ( richTextBlock ) {
					blocksToSend.push( richTextBlock );
					// Generate fallback text for THIS segment
					fallbackText = segment.content.replace( /\*\*|_|_|`|\[.*?\]\(.*?\)/g, '' ).substring( 0, 200 );
				} else {
					console.warn( `[Message Handler] Failed to generate rich text block for text segment ${ i }` );
					continue; // Skip if generation failed
				}

			} else if ( segment.type === 'code' ) {
				// --- Handle Code Segments ---
				const language = segment.language || 'text';
				const filetype = getSlackFiletype( language );

				if ( filetype === 'json' ) {
					// JSON handled separately, fallback generation inside its block
					// ... (existing JSON handling code) ...
					// Ensure fallbackText is defined if JSON fails
					fallbackText = `⚠️ Failed to upload JSON snippet...`; // Simplified for this scope
				} else {
					// --- Format Other Code Blocks Inline ---
					if ( ! segment.content || segment.content.trim().length === 0 ) continue;
					const inlineCodeContent = `\`\`\`${ language }\n${ segment.content }\`\`\``;
					console.log( `[Message Handler DEBUG] Converting code segment (${ language }) to single rich_text block` );
					const richTextBlock = markdownToRichTextBlock( inlineCodeContent, `code_${ Date.now() }_${ i }` );

					if ( richTextBlock ) {
						blocksToSend.push( richTextBlock );
						// Generate fallback text for THIS code segment
						fallbackText = `Code Snippet (${ language })`;
					} else {
						console.warn( `[Message Handler] Failed to generate rich text block for code segment ${ i }` );
						continue; // Skip if generation failed
					}
				}
			}

			if ( blocksToSend.length === 0 && filetype !== 'json' ) { // Skip empty non-JSON segments
				console.log( `[Message Handler] No blocks generated for segment ${ i }, skipping post.` );
				continue;
			}

			// Post the message for the current segment
			try {
				const postResult = await slack.chat.postMessage( {
					channel,
					thread_ts: replyTarget,
					text: fallbackText,
					blocks: blocksToSend
				} );
				const mainMessageTs = postResult?.ts;
				console.log( `[Message Handler] Posted segment ${ i + 1 }/${ segments.length } (ts: ${ mainMessageTs }).` );


				// Post feedback buttons separately IF it's the last segment AND we have fallback text
				if ( isLastSegment && isSubstantiveResponse && mainMessageTs && fallbackText ) {
					try {
						console.log( `[Message Handler DEBUG] Posting feedback buttons separately after final segment ${ mainMessageTs }.` );
						// Truncate fallback text heavily for block_id and URL-encode it
						const safeFallbackText = fallbackText.substring( 0, 150 ); // Limit to ~150 chars for safety
						const encodedFallback = encodeURIComponent( safeFallbackText );
						const finalFeedbackBlock = [
							{ "type": "divider" },
							// Format: feedback_originalTs_sphere_encodedText
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
					} catch ( feedbackPostError ) {
						console.error( `[Message Error] Failed to post feedback buttons separately:`, feedbackPostError.data?.error || feedbackPostError.message );
					}
				}

			} catch ( postError ) {
				console.error( `[Message Error] Failed post segment ${ i + 1 }:`, postError.data?.error || postError.message );
				await slack.chat.postMessage( {
					channel,
					thread_ts: replyTarget,
					text: `_(Error displaying part ${ i + 1 } of the response)_`
				} ).catch( () => {
				} );
			}
		}
		// -- End Segment Processing Loop --

	} catch ( error ) {
		// 11. Handle Errors
		console.error( '[Message Handler Error]', error );
		try {
			await slack.chat.postMessage( {
				channel,
				thread_ts: replyTarget,
				text: `⚠️ Oops! I encountered an error processing your request. (Workspace: ${ workspaceSlugForThread || 'unknown' })`
			} );
		} catch ( slackError ) {
			console.error( "[Message Error] Failed post error message:", slackError.data?.error || slackError.message );
		}

	} finally {
		// 12. Cleanup Thinking Message
		if ( thinkingMessageTs ) {
			try {
				await slack.chat.delete( { channel: channel, ts: thinkingMessageTs } );
				console.log( `[Message Handler] Deleted thinking message (ts: ${ thinkingMessageTs }).` );
			} catch ( delErr ) {
				console.warn( "Failed delete thinking message:", delErr.data?.error || delErr.message );
			}
		}
		const handlerEndTime = Date.now();
		console.log( `[Message Handler] Finished processing event for ${ userId }. Total duration: ${ handlerEndTime - handlerStartTime }ms` );
	}
}


export { handleSlackMessageEventInternal };
