import { WebClient } from '@slack/web-api';
import { createEventAdapter } from '@slack/events-api';
import { exportConversationToMarkdown } from './conversation-export.js';
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
    githubToken,
    githubWorkspaceSlug,
    formatterWorkspaceSlug,
    MIN_SUBSTANTIVE_RESPONSE_LENGTH,
    MAX_SLACK_BLOCK_TEXT_LENGTH
} from './config.js';
import { isDuplicateRedis, splitMessageIntoChunks, formatSlackMessage, extractTextAndCode, getSlackFiletype, markdownToRichTextBlock, getGithubIssueDetails, callGithubApi } from './utils.js';
import { redisClient, isRedisReady, dbPool, getAnythingLLMThreadMapping, storeAnythingLLMThreadMapping } from './services.js';
import { queryLlm, getWorkspaces, createNewAnythingLLMThread } from './llm.js';
import { Octokit } from '@octokit/rest';

// Initialize Slack clients
export const slack = new WebClient(botToken);
export const slackEvents = createEventAdapter(signingSecret, { includeBody: true });

// +++ Start GitHub Integration +++
let octokit;
if (githubToken) {
    octokit = new Octokit({ auth: githubToken });
    console.log("[GitHub Service] Octokit initialized.");
} else {
    console.warn("[GitHub Service] GITHUB_TOKEN not set. GitHub features (release check) will be disabled.");
}

/**
 * Fetches the latest release for a given repository.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<object | null>} Object with tagName, publishedAt, url, or null.
 */
async function getLatestRelease(owner, repo) {
    if (!octokit) {
        console.warn("[GitHub Service] getLatestRelease called but Octokit not initialized.");
        return null;
    }
    if (!owner || !repo) {
        console.error("[GitHub Service] getLatestRelease requires owner and repo.");
        return null;
    }
    try {
        console.log(`[GitHub Service] Fetching latest release for ${owner}/${repo}`);
        const response = await octokit.repos.getLatestRelease({ owner, repo });
        if (response.status === 200 && response.data) {
            console.log(`[GitHub Service] Found latest release: ${response.data.tag_name}`);
            return {
                tagName: response.data.tag_name,
                publishedAt: response.data.published_at,
                url: response.data.html_url
            };
        } else {
            console.warn(`[GitHub Service] Unexpected response status for latest release ${owner}/${repo}: ${response.status}`);
            return null;
        }
    } catch (error) {
        // Handle 404 Not Found specifically - repo exists but has no releases
        if (error.status === 404) {
            console.log(`[GitHub Service] No releases found for ${owner}/${repo} (404).`);
        } else {
            console.error(`[GitHub Service] Error fetching latest release for ${owner}/${repo}:`, error.status, error.message);
        }
        return null;
    }
}
// +++ End GitHub Integration +++

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

    // --- Determine AnythingLLM Thread and Workspace EARLY ---Moved from below---
    let anythingLLMThreadSlug = null;
    let workspaceSlugForThread = null;
    try {
        const existingMapping = await getAnythingLLMThreadMapping(channel, replyTarget);
        if (existingMapping) {
            anythingLLMThreadSlug = existingMapping.anythingllm_thread_slug;
            workspaceSlugForThread = existingMapping.anythingllm_workspace_slug;
            console.log(`[Slack Handler] Found existing AnythingLLM thread: ${workspaceSlugForThread}:${anythingLLMThreadSlug}`);
        } else {
            console.log(`[Slack Handler] No existing AnythingLLM thread found for Slack thread ${replyTarget}. Determining initial sphere...`);
            let initialSphere = 'all'; // Default sphere
            const overrideRegex = /#(\S+)/;
            const match = cleanedQuery.match(overrideRegex);
            if (match && match[1]) {
                const potentialWorkspace = match[1];
                const availableWorkspaces = await getWorkspaces(); // Fetch available slugs
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
                // If thread creation fails here, we probably can't proceed with *any* LLM call
                throw new Error(`Failed to create a new AnythingLLM thread in workspace ${workspaceSlugForThread}.`);
            }
            await storeAnythingLLMThreadMapping(channel, replyTarget, workspaceSlugForThread, anythingLLMThreadSlug);
        }
    } catch (threadError) {
        console.error("[Slack Handler] Error determining/creating AnythingLLM thread:", threadError);
        await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `⚠️ Oops! I had trouble connecting to the knowledge base thread.` }).catch(() => {});
        const ts = await thinkingMessagePromise; if (ts) { slack.chat.delete({ channel: channel, ts: ts }).catch(()=>{}); }
        return; // Critical error, cannot proceed
    }
    // --- End Determine Thread Early ---

    // --- Direct Answer / Special Command Handling ---

    // Check 1: Release Info
    // --- DEBUG LOGGING ---
    console.log(`[Slack Handler DEBUG] Checking for release trigger. Query lowercase: \"${cleanedQuery.toLowerCase()}\"`);
    // --- END DEBUG LOGGING ---

    // Use regex to check for and extract product name
    const releaseMatchRegex = /latest (?:gravityforms\/)?([\w-]+(?: addon| checkout)?|\S+) release/i;
    const releaseMatch = cleanedQuery.match(releaseMatchRegex);

    if (releaseMatch) { // <<< Check if the regex matched successfully
        console.log("[Slack Handler] Release query detected.");
        // Check if octokit is needed/available - Assuming getLatestRelease still uses it
        if (octokit) { 
            try {
                // ---> Start of existing release logic (using releaseMatch defined above)
                if (releaseMatch && releaseMatch[1]) {
                    let productName = releaseMatch[1].toLowerCase();
                    let owner = 'gravityforms'; 
                    let repo = null;
                    const abbreviations = {
                         'gf': 'gravityforms', 'ppcp': 'gravityformsppcp', 'paypal checkout': 'gravityformsppcp',
                         'paypal': 'gravityformsppcp', 'stripe': 'gravityformsstripe', 'authorize.net': 'gravityformsauthorizenet',
                         'user registration': 'gravityformsuserregistration', 'core': 'gravityforms'
                    };
                    if (productName === 'gravityflow') { repo = 'gravityflow'; }
                    else if (abbreviations[productName]) { repo = abbreviations[productName]; }
                    else {
                         productName = productName.replace(/\s+addon$/, '').replace(/\s+checkout$/, '');
                         repo = productName.startsWith('gravityforms') ? productName : `gravityforms${productName}`;
                    }
                    console.log(`[Slack Handler] Determined GitHub target: ${owner}/${repo}`);
                    if (owner && repo) {
                        const releaseInfo = await getLatestRelease(owner, repo);
                        if (releaseInfo) {
                            const publishedDate = new Date(releaseInfo.publishedAt).toLocaleDateString();
                            const messageText = `The latest release for ${owner}/${repo} is ${releaseInfo.tagName}. Published on ${publishedDate}.`;
                            const richTextBlock = markdownToRichTextBlock(messageText, `release_${owner}_${repo}`);
                            if (richTextBlock) {
                                await slack.chat.postMessage({
                                     channel, thread_ts: replyTarget,
                                     text: `The latest release for ${owner}/${repo} is ${releaseInfo.tagName} (Published on ${publishedDate})`,
                                     blocks: [richTextBlock]
                                });
                                console.log("[Slack Handler] Responded directly with GitHub release info.");
                                const ts = await thinkingMessagePromise; if (ts) { slack.chat.delete({ channel: channel, ts: ts }).catch(()=>{}); }
                                return; // <<< SUCCESSFUL RETURN
                            }
                        } else {
                             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `I couldn't find any releases for ${owner}/${repo}.` });
                             const ts = await thinkingMessagePromise; if (ts) { slack.chat.delete({ channel: channel, ts: ts }).catch(()=>{}); }
                             return; // <<< HANDLED (NOT FOUND) RETURN
                        }
                    }
                }
                // ---> End of existing release logic
            } catch (githubError) {
                 console.error(`[Slack Handler] Error during GitHub release check:`, githubError);
                 // Fall through ONLY if octokit was available but the API call failed
            }
        } else {
             console.warn("[Slack Handler] Octokit client not available for release check.");
             // Fall through to main LLM if octokit isn't ready
        }
    }

    // Check 2: Issue Analysis
    const issueTriggerRegex = /^(analyze|summarize|explain|check|look into)\s+(issue|backlog)\s+#(\d+)/i;
    // --- DEBUG LOGGING --- 
    console.log(`[Slack Handler DEBUG] cleanedQuery for regex match: \"${cleanedQuery}\"`);
    // --- END DEBUG LOGGING ---
    const issueTriggerMatch = !releaseMatch && cleanedQuery.match(issueTriggerRegex); // Only match if releaseMatch failed
    // --- DEBUG LOGGING --- 
    console.log(`[Slack Handler DEBUG] issueTriggerMatch result:`, issueTriggerMatch);
    // --- END DEBUG LOGGING ---

    if (issueTriggerMatch) {
        const issueNumber = parseInt(issueTriggerMatch[3], 10);
        const userPrompt = cleanedQuery.substring(issueTriggerMatch[0].length).trim();
        console.log(`[Slack Handler] GitHub issue analysis triggered for backlog #${issueNumber}. User prompt: "${userPrompt}"`);

        // Check for GITHUB_TOKEN before proceeding
        if (!githubToken) {
             console.error("[Slack Handler] GITHUB_TOKEN is missing. Cannot perform issue analysis.");
             await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Sorry, I can't analyze GitHub issues because the GITHUB_TOKEN is not configured.` }).catch(() => {});
             const ts = await thinkingMessagePromise; if (ts) { slack.chat.delete({ channel: channel, ts: ts }).catch(()=>{}); }
             return; // <<< HANDLED (CONFIG ERROR) RETURN
        }

        try {
            await thinkingMessagePromise; // Ensure thinking message is posted
            const issueDetails = await getGithubIssueDetails(issueNumber);

            if (issueDetails) {
                // ---> Start of issue analysis logic
                let issueContext = `**GitHub Issue:** gravityforms/backlog#${issueNumber}\n`;
                issueContext += `**Title:** ${issueDetails.title}\n`;
                issueContext += `**URL:** <${issueDetails.url}|View on GitHub>\n`;
                issueContext += `**Body:**\n${issueDetails.body || '(No body)'}\n\n`;
                if (issueDetails.comments && issueDetails.comments.length > 0) {
                    issueContext += `**Recent Comments:**\n`;
                    issueDetails.comments.forEach(comment => { issueContext += `*${comment.user}:* ${comment.body.substring(0, 300)}${comment.body.length > 300 ? '...' : ''}\n---\n`; });
                }
                console.log(`[Slack Handler] Requesting LLM summary for issue #${issueNumber}`);
                const summarizePrompt = `Summarize the core problem described in the following GitHub issue details from gravityforms/backlog#${issueNumber}:\n\n${issueContext}`;
                // --- DEBUG LLM CALL 1 --- 
                console.log(`[Slack Handler DEBUG] Calling queryLlm (Summary). Workspace: ${workspaceSlugForThread}, Thread: ${anythingLLMThreadSlug}`);
                // --- END DEBUG --- 
                const summaryResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, summarizePrompt);
                if (!summaryResponse) throw new Error('LLM failed to provide a summary.');
                console.log(`[Slack Handler] Posting LLM summary for issue #${issueNumber}`);
                const summaryBlock = markdownToRichTextBlock(`*LLM Summary for issue #${issueNumber}:*\n${summaryResponse}`);
                if (summaryBlock) { await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Summary for issue #${issueNumber}: ${summaryResponse}`, blocks: [summaryBlock] }); }
                console.log(`[Slack Handler] Requesting LLM analysis for issue #${issueNumber}`);
                let analyzePrompt = `Based on your summary ("${summaryResponse}") and the full context below, analyze issue gravityforms/backlog#${issueNumber}`;
                if (userPrompt) { analyzePrompt += ` specifically addressing the following: "${userPrompt}"`; }
                else { analyzePrompt += ` and suggest potential causes or solutions.`; }
                analyzePrompt += `\n\n**Full Context:**\n${issueContext}`;
                // --- DEBUG LLM CALL 2 --- 
                console.log(`[Slack Handler DEBUG] Calling queryLlm (Analysis). Workspace: ${workspaceSlugForThread}, Thread: ${anythingLLMThreadSlug}`);
                // --- END DEBUG --- 
                const analysisResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, analyzePrompt);
                if (!analysisResponse) throw new Error('LLM failed to provide analysis.');
                console.log(`[Slack Handler] Processing and sending LLM analysis for issue #${issueNumber}`);
                const segments = extractTextAndCode(analysisResponse);
                for (let i = 0; i < segments.length; i++) {
                    const blocksToSend = []; 
                    const segment = segments[i];
                    if (segment.type === 'text') { const block = markdownToRichTextBlock(segment.content); if (block) blocksToSend.push(block); }
                    else if (segment.type === 'code') { const block = markdownToRichTextBlock(`\`\`\`${segment.language || ''}\n${segment.content}\`\`\``); if (block) blocksToSend.push(block); }
                    if (blocksToSend.length > 0) { await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Analysis Part ${i+1}`, blocks: blocksToSend }); console.log(`[Slack Handler] Posted analysis segment ${i+1}/${segments.length}`); }
                }
                // ---> End of issue analysis logic

                // Cleanup thinking message and return successfully
                const ts = await thinkingMessagePromise; if (ts) { slack.chat.delete({ channel: channel, ts: ts }).catch(()=>{}); }
                return; // <<< SUCCESSFUL RETURN
            } else {
                // Handle case where issue details couldn't be fetched
                await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `I couldn't fetch details for backlog issue #${issueNumber}. Please check if the number is correct and the GITHUB_TOKEN is valid.` });
                const ts = await thinkingMessagePromise; if (ts) { slack.chat.delete({ channel: channel, ts: ts }).catch(()=>{}); }
                return; // <<< HANDLED (NOT FOUND) RETURN
            }
        } catch (error) {
            console.error(`[Slack Handler] Error during GitHub issue analysis for #${issueNumber}:`, error);
            await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `Sorry, I encountered an error trying to analyze issue #${issueNumber}.` }).catch(() => {});
            const ts = await thinkingMessagePromise; if (ts) { slack.chat.delete({ channel: channel, ts: ts }).catch(()=>{}); }
            return; // <<< HANDLED (ERROR) RETURN
        }
    } 

    // --- GitHub API Command ---
    const isGithubCommand = cleanedQuery.toLowerCase().startsWith('github') || cleanedQuery.includes('#github');
    if (isGithubCommand && githubWorkspaceSlug) {
        console.log(`[GitHub API] Trigger detected for text: \"${cleanedQuery}\"`);

        const githubQuery = cleanedQuery.replace(/^github/i, '').replace(/#github/g, '').trim();
        console.log(`[GitHub API] Querying GitHub workspace with: \"${githubQuery}\"`);

        try {
            // Changed mode from 'query' to 'chat'
            const llmResponse = await queryLlm(githubWorkspaceSlug, null, githubQuery, 'chat', []); 
            console.log('[GitHub API] Raw LLM Response:', JSON.stringify(llmResponse, null, 2));

            if (!llmResponse) { // Check if llmResponse itself is null/undefined
                throw new Error('Received null or invalid response from GitHub workspace LLM.');
            }

            // Ensure the response is treated as text, even if null initially
            const responseText = llmResponse || '';

            // --- Clean the response text: Remove markdown code fences --- START
            let cleanedJsonString = responseText.trim();
            if (cleanedJsonString.startsWith('```json')) {
                cleanedJsonString = cleanedJsonString.substring(7); // Remove ```json
            }
            if (cleanedJsonString.startsWith('```')) { // Handle case with just ```
                 cleanedJsonString = cleanedJsonString.substring(3);
            }
            if (cleanedJsonString.endsWith('```')) {
                cleanedJsonString = cleanedJsonString.substring(0, cleanedJsonString.length - 3);
            }
            cleanedJsonString = cleanedJsonString.trim(); // Trim again after removing fences
            // --- Clean the response text: Remove markdown code fences --- END

            let apiDetails;
            try {
                // Attempt to parse the cleaned string
                if (cleanedJsonString === '') throw new Error('LLM response text was empty after cleaning.');
                apiDetails = JSON.parse(cleanedJsonString);
            } catch (parseError) {
                console.error('[GitHub API] Failed to parse cleaned LLM response as JSON:', parseError);
                console.error('[GitHub API] Original response text:', responseText); // Log original for debugging
                console.error('[GitHub API] Cleaned string before parse attempt:', cleanedJsonString);
                await slack.chat.postMessage({
                    channel: channel,
                    thread_ts: replyTarget,
                    // Show the *original* raw response in the error message
                    text: `⚠️ Sorry, I couldn't understand the API instructions from the GitHub knowledge base. The response wasn't valid JSON even after cleaning.\n\nRaw response: \`\`\`${responseText}\`\`\``
                });
                return;
            }

            // Call the GitHub API
            try { // Outer try for GitHub API call AND subsequent processing
                console.log("[GitHub API] Calling GitHub API with details:", apiDetails);
                const githubResponse = await callGithubApi(apiDetails);
                console.log("[GitHub API] Received response from GitHub.");
            
                // --- Format the response --- START
                let finalResponseText = ''; // Initialize final response text
                const rawJsonString = JSON.stringify(githubResponse, null, 2); // Stringify once for potential reuse
            
                if (formatterWorkspaceSlug) {
                    // Try to format using the formatter workspace
                    console.log(`[GitHub API] Formatting response using workspace: ${formatterWorkspaceSlug}`);
                    const formatPrompt = rawJsonString; // Send the stringified JSON
                    console.log(`[GitHub API] Sending stringified JSON to formatter (length: ${formatPrompt.length})`);
            
                    try { // Inner try for Formatter LLM call
                        const formattedLLMResponse = await queryLlm(formatterWorkspaceSlug, null, formatPrompt, 'chat', []);
                        // Handle null/undefined/empty/whitespace responses robustly
                        const trimmedResponse = formattedLLMResponse ? formattedLLMResponse.trim() : '';
            
                        if (trimmedResponse.length > 0) {
                            let rawFormatted = trimmedResponse;
                            console.log("[GitHub API] Successfully received formatted response (before cleaning).");
                            
                            // --- Clean the FORMATTED response text: Remove markdown code fences --- START
                            let cleanedFormattedResponse = rawFormatted;
                            if (cleanedFormattedResponse.startsWith('```markdown')) {
                                cleanedFormattedResponse = cleanedFormattedResponse.substring(11);
                            } else if (cleanedFormattedResponse.startsWith('```')) { 
                                cleanedFormattedResponse = cleanedFormattedResponse.substring(3);
                            }
                            if (cleanedFormattedResponse.endsWith('```')) {
                                cleanedFormattedResponse = cleanedFormattedResponse.substring(0, cleanedFormattedResponse.length - 3);
                            }
                            finalResponseText = cleanedFormattedResponse.trim(); // Assign cleaned text
                            console.log("[GitHub API] Cleaned formatted response before sending to Slack.");
                            // --- Clean the FORMATTED response text: Remove markdown code fences --- END
                        } else {
                            console.warn("[GitHub API] Formatter LLM returned an empty or null response. Falling back to raw JSON.");
                            // Use standard string literal for fallback
                            finalResponseText = `(Formatter failed or returned empty, showing raw data):\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                        }
                    } catch (formatError) { // Catch for Formatter LLM call
                        console.error('[GitHub API] Error calling formatter LLM:', formatError);
                        // Use template literal for error message
                        finalResponseText = `(Error during formatting: ${formatError.message})\n\nRaw data:\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                    } // End catch for Formatter LLM call
            
                } else {
                    // No formatter configured, use raw JSON
                    console.log("[GitHub API] No formatter workspace configured. Sending raw JSON.");
                    // Use template literal for raw response message
                    finalResponseText = `Here is the raw response from the GitHub API:\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                }
                // --- Format the response --- END
            
                // --- Post the final (formatted or raw) response back to Slack (Chunked) --- START
                console.log("[GitHub API] Splitting final response for Slack.");
                // Use the general text length limit for splitting the potentially formatted response
                const chunks = splitMessageIntoChunks(finalResponseText, MAX_SLACK_BLOCK_TEXT_LENGTH);
                console.log(`[GitHub API] Split into ${chunks.length} chunk(s).`);

                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    console.log(`[GitHub API] Processing chunk ${i + 1}/${chunks.length}`);
                    const responseBlock = markdownToRichTextBlock(chunk);
                    if (responseBlock) {
                        await slack.chat.postMessage({
                            channel: channel,
                            thread_ts: replyTarget,
                            text: chunk.substring(0, 200), // Use start of chunk text as fallback
                            blocks: [responseBlock]
                        });
                    } else {
                        // Fallback to plain text if block generation fails for a chunk
                        console.warn(`[GitHub API] Failed to generate block for chunk ${i + 1}. Sending plain text.`);
                        await slack.chat.postMessage({
                             channel: channel,
                             thread_ts: replyTarget,
                             text: chunk
                        });
                    }
                    // Add a small delay between posting chunks to avoid rate limits and improve readability
                    if (chunks.length > 1 && i < chunks.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
                    }
                }
                console.log("[GitHub API] Finished posting all chunks.");
                // --- Post the final (formatted or raw) response back to Slack (Chunked) --- END

                // --- Cleanup Thinking Message --- START
                try {
                    const tsToDelete = await thinkingMessagePromise; // Ensure promise is resolved
                    if (tsToDelete) {
                        console.log(`[GitHub API] Deleting thinking message (ts: ${tsToDelete}).`);
                        await slack.chat.delete({ channel: channel, ts: tsToDelete });
                    }
                } catch(deleteError) {
                    console.warn("[GitHub API] Failed to delete thinking message:", deleteError.data?.error || deleteError.message);
                }
                // --- Cleanup Thinking Message --- END

            } catch (apiError) { // Catch errors specifically from the GitHub API call
                console.error('[GitHub API] Error calling GitHub API:', apiError);
            
                // Attempt to report the API error back to Slack
                // This *also* needs its own try-catch in case Slack is unreachable
                try {
                    await slack.chat.postMessage({
                        channel: channel,
                        thread_ts: replyTarget,
                        text: `Sorry, I encountered an error while calling the GitHub API: ${apiError.message}`
                    });
                } catch (slackErrorWhileReportingApiError) {
                    console.error('[GitHub API] CRITICAL: Failed to call GitHub API AND failed to report the error to Slack:', slackErrorWhileReportingApiError);
                    console.error('[GitHub API] Original API Error was:', apiError); // Ensure original error is logged
                }
            } 

        } catch (llmError) {
            console.error('[GitHub API] Error querying GitHub workspace LLM:', llmError);
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: replyTarget,
                text: `Sorry, I encountered an error while trying to figure out the GitHub API call: ${llmError.message}`
            });
        }
        return; // Stop processing after handling GitHub command
    }

    // If neither command was handled and returned, proceed to main logic
    console.log("[Slack Handler] No direct answer command detected, proceeding to main LLM.");
    
    // --- End Direct Answer / Special Command Handling ---

    // --- Main Processing Logic (Only runs if no direct answer/command was handled and returned) ---
    // Thread/workspace slugs are already determined above
    try {
        // Update Thinking Message (if thinking message promise resolved successfully)
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
        let llmInputText = cleanedQuery; // Start with the base query
        
        // --- Add instruction for non-GitHub queries --- START
        console.log("[Slack Handler] This is NOT a GitHub command, adding LLM instructions.");
        const instruction = '\n\nIMPORTANT: Please do not include context references (like "CONTEXT 0", "CONTEXT 1", etc.) in your response. Provide a clean, professional answer without these annotations.';
        llmInputText += instruction;
        // --- Add instruction for non-GitHub queries --- END
        
        console.log(`[Slack Handler] Sending query to AnythingLLM Thread ${workspaceSlugForThread}:${anythingLLMThreadSlug}...`);

        // 9. Query LLM using thread endpoint
        const llmStartTime = Date.now();
        const rawReply = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, llmInputText);
        console.log(`[Slack Handler] LLM call duration: ${Date.now() - llmStartTime}ms`);
        if (!rawReply) throw new Error('LLM returned empty response.');
        console.log("[Slack Handler Debug] Raw LLM Reply:\n", rawReply);

        // 10. Process and Send Response

        // 10a. Refined Check for Substantive Response
        let isSubstantiveResponse = true;
        const lowerRawReplyTrimmed = rawReply.toLowerCase().trim();

        // Rule 1: Check length first
        if (lowerRawReplyTrimmed.length < MIN_SUBSTANTIVE_RESPONSE_LENGTH) {
            console.log(`[Slack Handler] Reply is short (${lowerRawReplyTrimmed.length} < ${MIN_SUBSTANTIVE_RESPONSE_LENGTH}). Skipping feedback buttons.`);
            isSubstantiveResponse = false;
        }

        // Rule 2: Check for exact, simple non-substantive replies (only if still substantive)
        if (isSubstantiveResponse) {
             const exactNonSubstantive = [
                  'ok', 'done', 'hello', 'hi', 'hey', 'thanks', 'thank you'
             ];
             if (exactNonSubstantive.includes(lowerRawReplyTrimmed)) {
                 console.log(`[Slack Handler] Exact non-substantive match found: "${lowerRawReplyTrimmed}". Skipping feedback buttons.`);
                 isSubstantiveResponse = false;
             }
        }

        // Rule 3: Check if the reply STARTS WITH common refusal or filler phrases (only if still substantive)
        if (isSubstantiveResponse) {
            const startingNonSubstantive = [
                'sorry', 'i cannot', 'i am unable', "i don't know", "i do not know", 'i have no information',
                'how can i help', 'conversation reset', 'context will be ignored',
                'hello ', 'hi ', 'hey ', // Keep space for greetings followed by more
                'encountered an error'
            ];
            for (const pattern of startingNonSubstantive) {
                if (lowerRawReplyTrimmed.startsWith(pattern)) {
                    console.log(`[Slack Handler] Non-substantive starting pattern found: "${pattern}". Skipping feedback buttons.`);
                    isSubstantiveResponse = false;
                    break;
                }
            }
        }

        // Rule 4: Check for specific error messages (using includes is okay here)
        if (isSubstantiveResponse) {
             if (lowerRawReplyTrimmed.includes('encountered an error processing your request')) {
                  console.log(`[Slack Handler] Specific error message found. Skipping feedback buttons.`);
                  isSubstantiveResponse = false;
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
            let blocksToSend = []; // Array to hold blocks for THIS segment
            let fallbackText = ''; // Initialize fallbackText for the segment

            if (segment.type === 'text') {
                // --- Handle Text Segments ---
                if (!segment.content || segment.content.trim().length === 0) continue;
                
                console.log(`[Slack Handler DEBUG] Converting text segment to single rich_text block`);
                const richTextBlock = markdownToRichTextBlock(segment.content, `msg_${Date.now()}_${i}`);
                
                if (richTextBlock) {
                     blocksToSend.push(richTextBlock);
                     // Generate fallback text for THIS segment
                     fallbackText = segment.content.replace(/\*\*|_|_|`|\[.*?\]\(.*?\)/g, '').substring(0, 200);
                } else {
                    console.warn(`[Slack Handler] Failed to generate rich text block for text segment ${i}`);
                    continue; // Skip if generation failed
                }

            } else if (segment.type === 'code') {
                // --- Handle Code Segments ---
                const language = segment.language || 'text';
                const filetype = getSlackFiletype(language);

                if (filetype === 'json') {
                    // JSON handled separately, fallback generation inside its block
                    // ... (existing JSON handling code) ...
                    // Ensure fallbackText is defined if JSON fails
                    fallbackText = `⚠️ Failed to upload JSON snippet...`; // Simplified for this scope
                } else {
                    // --- Format Other Code Blocks Inline --- 
                    if (!segment.content || segment.content.trim().length === 0) continue;
                    const inlineCodeContent = `\`\`\`${language}\n${segment.content}\`\`\``;
                    console.log(`[Slack Handler DEBUG] Converting code segment (${language}) to single rich_text block`);
                    const richTextBlock = markdownToRichTextBlock(inlineCodeContent, `code_${Date.now()}_${i}`);
                    
                    if (richTextBlock) {
                         blocksToSend.push(richTextBlock);
                         // Generate fallback text for THIS code segment
                         fallbackText = `Code Snippet (${language})`;
                    } else {
                         console.warn(`[Slack Handler] Failed to generate rich text block for code segment ${i}`);
                         continue; // Skip if generation failed
                    }
                }
            }
            
            if (blocksToSend.length === 0 && filetype !== 'json') { // Skip empty non-JSON segments
                 console.log(`[Slack Handler] No blocks generated for segment ${i}, skipping post.`);
                 continue;
            }

            // Post the message for the current segment
            try {
                const postResult = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: fallbackText, blocks: blocksToSend });
                const mainMessageTs = postResult?.ts;
                console.log(`[Slack Handler] Posted segment ${i + 1}/${segments.length} (ts: ${mainMessageTs}).`);

                // Post feedback buttons separately IF it's the last segment AND we have fallback text
                if (isLastSegment && isSubstantiveResponse && mainMessageTs && fallbackText) { 
                    try {
                         console.log(`[Slack Handler DEBUG] Posting feedback buttons separately after final segment ${mainMessageTs}.`);
                         // Truncate fallback text heavily for block_id and URL-encode it
                         const safeFallbackText = fallbackText.substring(0, 150); // Limit to ~150 chars for safety
                         const encodedFallback = encodeURIComponent(safeFallbackText);
                         const finalFeedbackBlock = [
                             { "type": "divider" },
                             // Format: feedback_originalTs_sphere_encodedText
                             { "type": "actions", "block_id": `feedback_${originalTs}_${workspaceSlugForThread}_${encodedFallback}`, "elements": feedbackButtonElements }
                         ];
                         const feedbackPostResult = await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: "Feedback:", blocks: finalFeedbackBlock });
                         console.log(`[Slack Handler] Posted feedback buttons separately (ts: ${feedbackPostResult?.ts}).`);
                    } catch (feedbackPostError) {
                         console.error(`[Slack Error] Failed to post feedback buttons separately:`, feedbackPostError.data?.error || feedbackPostError.message);
                    }
                }

            } catch (postError) {
                console.error(`[Slack Error] Failed post segment ${i + 1}:`, postError.data?.error || postError.message);
                await slack.chat.postMessage({ channel, thread_ts: replyTarget, text: `_(Error displaying part ${i + 1} of the response)_` }).catch(()=>{});
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

    // Note: Export command is now handled via /slack/commands endpoint

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
        
        // Upload as a file in Slack
        await slack.files.upload({
            channels: channel,
            thread_ts: thread_ts,
            content: content,
            filename: `conversation-${metadata.channelName}-${thread_ts}.md`,
            filetype: 'markdown',
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

// --- Slash Command Handler ---
async function handleSlashCommand(req, res) {
    // Verify the request is from Slack
    if (!req.body || !req.body.command) {
        return res.status(400).send('Invalid slash command request');
    }

    // Handle /export command
    if (req.body.command === '/export') {
        // Acknowledge receipt of the command immediately
        res.status(200).send('Processing your export request...');

        // Process the export in the background
        const { channel_id, thread_ts, user_id } = req.body;
        handleExportCommand(channel_id, thread_ts || req.body.ts, user_id).catch(console.error);
        return;
    }

    // Unknown command
    res.status(404).send('Unknown command');
}

export { slackEvents, handleSlackEvent, handleInteraction, handleSlashCommand };
