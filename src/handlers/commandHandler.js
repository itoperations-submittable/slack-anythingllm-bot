// src/handlers/commandHandler.js
// This file will contain handlers for specific commands or message triggers.

// No direct imports needed *yet* for this specific handler,
// but we might need them for others (e.g., config, services)

// Add imports needed for release command
import { getLatestRelease } from '../githubService.js';
import { markdownToRichTextBlock, extractTextAndCode, splitMessageIntoChunks } from '../formattingService.js';
// Add imports needed for PR review command
import { getPrDetailsForReview } from '../githubService.js';
import { queryLlm } from '../llm.js';
import { githubToken } from '../config.js'; // Needed for the check
// Add imports needed for issue analysis command
import { getGithubIssueDetails, callGithubApi } from '../githubService.js';

/**
 * Handles the '#delete_last_message' command.
 * Attempts to find and delete the bot's last message in the thread.
 *
 * @param {string} channel - The channel ID.
 * @param {string} replyTarget - The timestamp of the message to reply to (thread TS or original message TS).
 * @param {string} botUserId - The user ID of the bot.
 * @param {import('@slack/web-api').WebClient} slack - The Slack WebClient instance.
 * @returns {Promise<boolean>} - True if the command was handled (message deleted or error posted), False otherwise.
 */
async function handleDeleteLastMessageCommand(channel, replyTarget, botUserId, slack) {
    console.log(`[Command Handler] Handling #delete_last_message in channel ${channel}`);
    try {
        // Fetch thread history to find bot's last message
        const historyResult = await slack.conversations.replies({
            channel: channel,
            ts: replyTarget, // Use replyTarget which is thread_ts or original_ts
            limit: 20 // Fetch enough messages to find recent bot messages
        });

        if (historyResult.ok && historyResult.messages) {
            // Find the last message from the bot
            const lastBotMessage = historyResult.messages
                .reverse() // Start from most recent
                .find(msg => msg.user === botUserId && !msg.text?.includes('✅') && !msg.text?.includes('❌')); // Exclude confirmation messages

            if (lastBotMessage) {
                try {
                    // Try to delete the message
                    await slack.chat.delete({
                        channel: channel,
                        ts: lastBotMessage.ts
                    });
                    console.log(`[Command Handler] Successfully deleted last message (ts: ${lastBotMessage.ts})`);

                    // Send confirmation and delete it after 5 seconds
                    const confirmMsg = await slack.chat.postMessage({
                        channel: channel,
                        thread_ts: replyTarget,
                        text: "✅ Last message deleted."
                    });

                    // Delete confirmation message after 5 seconds
                    setTimeout(async () => {
                        try {
                            await slack.chat.delete({
                                channel: channel,
                                ts: confirmMsg.ts
                            });
                        } catch (deleteError) {
                            console.error('[Command Handler] Error deleting confirmation:', deleteError);
                        }
                    }, 5000);

                } catch (deleteError) {
                    console.error('[Command Handler] Error deleting message:', deleteError);
                    await slack.chat.postMessage({
                        channel: channel,
                        thread_ts: replyTarget,
                        text: "❌ Sorry, I couldn't delete the message. It might be too old or I might not have permission."
                    });
                }
            } else {
                await slack.chat.postMessage({
                    channel: channel,
                    thread_ts: replyTarget,
                    text: "❌ I couldn't find my last message in this thread."
                });
            }
        } else {
            throw new Error('Failed to fetch thread history');
        }
    } catch (error) {
        console.error('[Command Handler] Error handling delete_last_message:', error);
        await slack.chat.postMessage({
            channel: channel,
            thread_ts: replyTarget,
            text: "❌ An error occurred while trying to delete the message."
        });
    }
    return true; // Command was handled (even if an error occurred and was reported)
}

/**
 * Handles the 'latest ... release' command.
 * Checks if the query matches the release pattern, fetches info from GitHub, and posts it.
 *
 * @param {string} cleanedQuery - The processed user query text.
 * @param {string} replyTarget - The timestamp of the message to reply to.
 * @param {import('@slack/web-api').WebClient} slack - The Slack WebClient instance.
 * @param {object} appOctokitInstance - The initialized Octokit instance (or null).
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @param {string} channel - The channel ID.
 * @returns {Promise<boolean>} - True if the command pattern matched and was handled, False otherwise.
 */
async function handleReleaseInfoCommand(cleanedQuery, replyTarget, slack, appOctokitInstance, thinkingMessagePromise, channel) {
    const releaseMatchRegex = /latest (?:gravityforms\/)?([\w-]+(?: addon| checkout)?|\S+) release/i;
    const releaseMatch = cleanedQuery.match(releaseMatchRegex);

    if (!releaseMatch) {
        return false; // Pattern didn't match
    }

    console.log("[Command Handler] Release query detected.");

    // Logic moved from messageHandler.js
    try {
        if (releaseMatch && releaseMatch[1]) {
            let productName = releaseMatch[1].toLowerCase();
            let owner = 'gravityforms';
            let repo = null;
            const abbreviations = {
                'gf': 'gravityforms',
                'ppcp': 'gravityformsppcp',
                'paypal checkout': 'gravityformsppcp',
                'paypal': 'gravityformsppcp',
                'stripe': 'gravityformsstripe',
                'authorize.net': 'gravityformsauthorizenet',
                'user registration': 'gravityformsuserregistration',
                'core': 'gravityforms'
            };
            if (productName === 'gravityflow') {
                repo = 'gravityflow';
            } else if (abbreviations[productName]) {
                repo = abbreviations[productName];
            } else {
                productName = productName.replace(/\s+addon$/, '').replace(/\s+checkout$/, '');
                repo = productName.startsWith('gravityforms') ? productName : `gravityforms${productName}`;
            }
            console.log(`[Command Handler] Determined GitHub target: ${owner}/${repo}`);

            if (owner && repo && appOctokitInstance) {
                const releaseInfo = await getLatestRelease(appOctokitInstance, owner, repo);

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
                        console.log("[Command Handler] Responded directly with GitHub release info.");
                        const ts = await thinkingMessagePromise;
                        if (ts) {
                            slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
                        }
                        return true; // Command handled successfully
                    }
                } else {
                    await slack.chat.postMessage({
                        channel,
                        thread_ts: replyTarget,
                        text: `I couldn't find any releases for ${owner}/${repo}.`
                    });
                    const ts = await thinkingMessagePromise;
                    if (ts) {
                        slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
                    }
                    return true; // Command handled (not found)
                }
            } else if (!appOctokitInstance) {
                console.warn("[Command Handler] Octokit instance not available for release check.");
                await slack.chat.postMessage({
                    channel,
                    thread_ts: replyTarget,
                    text: `Sorry, I can't check GitHub releases right now (missing configuration).`
                });
                const ts = await thinkingMessagePromise;
                if (ts) slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
                return true; // Command handled (config error)
            }
        }
    } catch (githubError) {
        console.error(`[Command Handler] Error during GitHub release check:`, githubError);
        // Don't return true here, let the main handler proceed
        // We could potentially post an error message, but the original logic fell through
    }

    // If the regex matched but something went wrong internally (like octokit error, but not config error)
    // or if the initial if (releaseMatch && releaseMatch[1]) failed somehow.
    // The original logic would fall through, so we return false to mimic that.
    return false;
}

/**
 * Handles the 'review pr gravityforms/REPO#NUM #WORKSPACE' command.
 * Fetches PR details, constructs a prompt, queries LLM, and posts the review.
 *
 * @param {string} cleanedQuery - The processed user query text.
 * @param {string} replyTarget - The timestamp of the message to reply to.
 * @param {string} channel - The channel ID.
 * @param {import('@slack/web-api').WebClient} slack - The Slack WebClient instance.
 * @param {object} appOctokitInstance - The initialized Octokit instance (or null).
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @returns {Promise<boolean>} - True if the command pattern matched and was handled, False otherwise.
 */
async function handlePrReviewCommand(cleanedQuery, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise) {
    const prReviewRegex = /^review\s+pr\s+gravityforms\/([\w-]+)#(\d+)\s+#([\w-]+)/i;
    const prMatch = cleanedQuery.match(prReviewRegex);

    if (!prMatch) {
        return false; // Pattern didn't match
    }

    const subRepo = prMatch[1];
    const prNumber = parseInt(prMatch[2], 10);
    const workspaceSlug = prMatch[3];
    console.log(`[Command Handler] PR review triggered for PR gravityforms/${subRepo}#${prNumber} in workspace ${workspaceSlug}`);

    // Logic moved from messageHandler.js
    if (!githubToken || !appOctokitInstance) {
        console.error("[Command Handler] GITHUB_TOKEN or Octokit instance missing. Cannot perform PR review.");
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I can't review PRs because the GitHub integration is not configured correctly.`
        }).catch(() => {});
        const ts = await thinkingMessagePromise;
        if (ts) {
            slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        }
        return true; // Indicate command was handled (config error)
    }

    try {
        await thinkingMessagePromise; // Ensure thinking message is posted
        const prDetails = await getPrDetailsForReview(appOctokitInstance, 'gravityforms', subRepo, prNumber);

        if (!prDetails) {
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `Sorry, I couldn't fetch details for PR gravityforms/${subRepo}#${prNumber}. It might not exist or there was an API issue.`
            });
            const ts = await thinkingMessagePromise;
            if (ts) {
                slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
            }
            return true; // Indicate command was handled (PR not found/error)
        }

        // Construct PR context
        let prContext = `**Pull Request:** gravityforms/${subRepo}#${prNumber}\n`;
        prContext += `**Title:** ${prDetails.title}\n`;
        prContext += `**Description:**\n${prDetails.body || '(No description)'}\n\n`;
        prContext += `**Changes:**\n`;

        const MAX_DIFF_SIZE = 5000; // Characters per file
        (prDetails.files || []).forEach(file => {
            prContext += `\n**File:** ${file.filename}\n`;
            prContext += `**Status:** ${file.status} (${file.additions} additions, ${file.deletions} deletions)\n`;
            if (file.patch) {
                const truncatedDiff = file.patch.length > MAX_DIFF_SIZE
                    ? file.patch.substring(0, MAX_DIFF_SIZE) + '\n... (diff truncated)'
                    : file.patch;
                prContext += `\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
            }
        });

        if (prDetails.comments && prDetails.comments.length > 0) {
            prContext += `\n**Comments:**\n`;
            prDetails.comments.forEach(comment => {
                prContext += `*${comment.user.login}:* ${comment.body.substring(0, 300)}${comment.body.length > 300 ? '...' : ''}\n---\n`;
            });
        }

        // Create detailed review prompt
        const reviewPrompt = `You are performing a code review of this Pull Request. Please provide a comprehensive review that includes:

1. Overview:
   - Brief summary of the changes
   - The main purpose of this PR
   - Impact and scope of changes

2. Code Analysis:
   - Code quality and best practices
   - Potential bugs or issues
   - Performance implications
   - Security considerations
   - Test coverage

3. Specific Recommendations:
   - Concrete suggestions for improvements
   - Alternative approaches if applicable
   - Any missing documentation

4. Summary:
   - Overall assessment
   - Key points that need attention
   - Whether the PR is ready to merge

Please be specific and provide examples when pointing out issues or suggesting improvements. If you see something good, mention that as well.

Here's the PR context:

${prContext}`;

        // Query LLM with the workspace from the command
        console.log(`[Command Handler] Requesting LLM analysis for PR #${prNumber} in workspace ${workspaceSlug}`);
        const analysisResponse = await queryLlm(workspaceSlug, null, reviewPrompt);

        if (!analysisResponse) throw new Error('LLM failed to provide analysis.');

        // Process and send the response
        const segments = extractTextAndCode(analysisResponse);
        for (let i = 0; i < segments.length; i++) {
            const blocksToSend = [];
            const segment = segments[i];
            if (segment.type === 'text') {
                const block = markdownToRichTextBlock(segment.content);
                if (block) blocksToSend.push(block);
            } else if (segment.type === 'code') {
                const block = markdownToRichTextBlock(`\`\`\`${segment.language || ''}\n${segment.content}\`\`\``);
                if (block) blocksToSend.push(block);
            }
            if (blocksToSend.length > 0) {
                await slack.chat.postMessage({
                    channel,
                    thread_ts: replyTarget,
                    text: `PR Review Part ${i + 1}`,
                    blocks: blocksToSend
                });
                console.log(`[Command Handler] Posted review segment ${i + 1}/${segments.length}`);
            }
        }

        // Cleanup thinking message
        const ts = await thinkingMessagePromise;
        if (ts) {
            await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        }
        return true; // Command handled successfully

    } catch (error) {
        console.error(`[Command Handler] Error during PR review for gravityforms/${subRepo}#${prNumber}:`, error);
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I encountered an error trying to review PR gravityforms/${subRepo}#${prNumber}. Details: ${error.message}`
        }).catch(() => {});
        // Cleanup thinking message on error too
        const ts = await thinkingMessagePromise;
        if (ts) {
            await slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        }
        return true; // Indicate command was handled (error reported)
    }
}

/**
 * Handles the 'analyze|summarize|etc. issue|backlog #NUM' command.
 * Fetches issue details, constructs prompts, queries LLM for summary and analysis, and posts results.
 *
 * @param {string} cleanedQuery - The processed user query text.
 * @param {string} replyTarget - The timestamp of the message to reply to.
 * @param {string} channel - The channel ID.
 * @param {import('@slack/web-api').WebClient} slack - The Slack WebClient instance.
 * @param {object} appOctokitInstance - The initialized Octokit instance (or null).
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @param {string} workspaceSlugForThread - The AnythingLLM workspace slug for the current thread.
 * @param {string} anythingLLMThreadSlug - The AnythingLLM thread slug for the current thread.
 * @returns {Promise<boolean>} - True if the command pattern matched and was handled, False otherwise.
 */
async function handleIssueAnalysisCommand(cleanedQuery, replyTarget, channel, slack, appOctokitInstance, thinkingMessagePromise, workspaceSlugForThread, anythingLLMThreadSlug) {
    const issueTriggerRegex = /^(analyze|summarize|explain|check|look into)\s+(issue|backlog)\s+#(\d+)/i;
    const issueTriggerMatch = cleanedQuery.match(issueTriggerRegex);

    if (!issueTriggerMatch) {
        return false; // Pattern didn't match
    }

    const issueNumber = parseInt(issueTriggerMatch[3], 10);
    const userPrompt = cleanedQuery.substring(issueTriggerMatch[0].length).trim();
    const ghOwner = 'gravityforms'; // Assuming constant owner
    const ghRepo = 'backlog'; // Assuming constant repo
    console.log(`[Command Handler] GitHub issue analysis triggered for ${ghRepo}#${issueNumber}. User prompt: "${userPrompt}"`);

    // Logic moved from messageHandler.js
    if (!githubToken || !appOctokitInstance) {
        console.error("[Command Handler] GITHUB_TOKEN or Octokit instance missing. Cannot perform issue analysis.");
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I can't analyze GitHub issues because the GitHub integration is not configured correctly.`
        }).catch(() => {});
        const ts = await thinkingMessagePromise;
        if (ts) {
            slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        }
        return true; // Command handled (config error)
    }

    try {
        await thinkingMessagePromise; // Ensure thinking message is posted
        const issueDetails = await getGithubIssueDetails(appOctokitInstance, issueNumber);

        if (issueDetails) {
            // Construct context
            let issueContext = `**GitHub Issue:** ${ghOwner}/${ghRepo}#${issueNumber}\n`;
            issueContext += `**Title:** ${issueDetails.title}\n`;
            issueContext += `**URL:** <${issueDetails.url}|View on GitHub>\n`;
            issueContext += `**Body:**\n${issueDetails.body || '(No body)'}\n\n`;
            if (issueDetails.comments && issueDetails.comments.length > 0) {
                issueContext += `**Recent Comments:**\n`;
                issueDetails.comments.forEach(comment => {
                    issueContext += `*${comment.user}:* ${comment.body.substring(0, 300)}${comment.body.length > 300 ? '...' : ''}\n---\n`;
                });
            }

            // Get summary
            console.log(`[Command Handler] Requesting LLM summary for issue #${issueNumber}`);
            const summarizePrompt = `Summarize the core problem described in the following GitHub issue details from gravityforms/backlog#${issueNumber}:\n\n${issueContext}`;
            console.log(`[Command Handler DEBUG] Calling queryLlm (Summary). Workspace: ${workspaceSlugForThread}, Thread: ${anythingLLMThreadSlug}`);
            const summaryResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, summarizePrompt);
            if (!summaryResponse) throw new Error('LLM failed to provide a summary.');

            // Post summary
            console.log(`[Command Handler] Posting LLM summary for issue #${issueNumber}`);
            const summaryBlock = markdownToRichTextBlock(`*LLM Summary for issue #${issueNumber}:*\n${summaryResponse}`);
            if (summaryBlock) {
                await slack.chat.postMessage({
                    channel,
                    thread_ts: replyTarget,
                    text: `Summary for issue #${issueNumber}: ${summaryResponse}`,
                    blocks: [summaryBlock]
                });
            }

            // Get analysis
            console.log(`[Command Handler] Requesting LLM analysis for issue #${issueNumber}`);
            let analyzePrompt = `Based on your summary ("${summaryResponse}") and the full context below, analyze issue gravityforms/backlog#${issueNumber}`;
            if (userPrompt) {
                analyzePrompt += ` specifically addressing the following: "${userPrompt}"`;
            } else {
                analyzePrompt += ` and suggest potential causes or solutions.`;
            }
            analyzePrompt += `\n\n**Full Context:**\n${issueContext}`;
            console.log(`[Command Handler DEBUG] Calling queryLlm (Analysis). Workspace: ${workspaceSlugForThread}, Thread: ${anythingLLMThreadSlug}`);
            const analysisResponse = await queryLlm(workspaceSlugForThread, anythingLLMThreadSlug, analyzePrompt);
            if (!analysisResponse) throw new Error('LLM failed to provide analysis.');

            // Post analysis
            console.log(`[Command Handler] Processing and sending LLM analysis for issue #${issueNumber}`);
            const segments = extractTextAndCode(analysisResponse);
            for (let i = 0; i < segments.length; i++) {
                const blocksToSend = [];
                const segment = segments[i];
                if (segment.type === 'text') {
                    const block = markdownToRichTextBlock(segment.content);
                    if (block) blocksToSend.push(block);
                } else if (segment.type === 'code') {
                    const block = markdownToRichTextBlock(`\`\`\`${segment.language || ''}\n${segment.content}\`\`\``);
                    if (block) blocksToSend.push(block);
                }
                if (blocksToSend.length > 0) {
                    await slack.chat.postMessage({
                        channel,
                        thread_ts: replyTarget,
                        text: `Analysis Part ${i + 1}`,
                        blocks: blocksToSend
                    });
                    console.log(`[Command Handler] Posted analysis segment ${i + 1}/${segments.length}`);
                }
            }

            // Cleanup and return success
            const ts = await thinkingMessagePromise;
            if (ts) {
                slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
            }
            return true; // Command handled successfully

        } else {
            // Handle case where issue details couldn't be fetched
            await slack.chat.postMessage({
                channel,
                thread_ts: replyTarget,
                text: `I couldn't fetch details for backlog issue #${issueNumber}. Please check if the number is correct.`
            });
            const ts = await thinkingMessagePromise;
            if (ts) {
                slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
            }
            return true; // Command handled (issue not found)
        }
    } catch (error) {
        console.error(`[Command Handler] Error during GitHub issue analysis for #${issueNumber}:`, error);
        await slack.chat.postMessage({
            channel,
            thread_ts: replyTarget,
            text: `Sorry, I encountered an error trying to analyze issue #${issueNumber}.`
        }).catch(() => {});
        const ts = await thinkingMessagePromise;
        if (ts) {
            slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
        }
        return true; // Command handled (error reported)
    }
}

/**
 * Handles the generic 'github' or '#github' command.
 * Queries the GitHub LLM workspace, parses the response as API details, executes the API call,
 * optionally formats the result, and posts it back.
 *
 * @param {string} cleanedQuery - The processed user query text.
 * @param {string} replyTarget - The timestamp of the message to reply to.
 * @param {string} channel - The channel ID.
 * @param {import('@slack/web-api').WebClient} slack - The Slack WebClient instance.
 * @param {Promise<string | null>} thinkingMessagePromise - Promise resolving to the thinking message timestamp.
 * @param {string|null} githubWorkspaceSlug - Slug for the GitHub LLM workspace.
 * @param {string|null} formatterWorkspaceSlug - Slug for the Formatter LLM workspace.
 * @returns {Promise<boolean>} - True if the command pattern matched and was handled, False otherwise.
 */
async function handleGithubApiCommand(cleanedQuery, replyTarget, channel, slack, thinkingMessagePromise, githubWorkspaceSlug, formatterWorkspaceSlug) {
    const isGithubCommand = cleanedQuery.toLowerCase().startsWith('github') || cleanedQuery.includes('#github');

    if (!isGithubCommand || !githubWorkspaceSlug) {
        return false; // Pattern didn't match or slug not configured
    }

    console.log(`[Command Handler] GitHub API command trigger detected for text: "${cleanedQuery}"`);
    const githubQuery = cleanedQuery.replace(/^github/i, '').replace(/#github/g, '').trim();
    console.log(`[Command Handler] Querying GitHub workspace with: "${githubQuery}"`);

    // Logic moved from messageHandler.js
    try {
        const llmResponse = await queryLlm(githubWorkspaceSlug, null, githubQuery, 'chat', []);
        console.log('[Command Handler] Raw LLM Response:', JSON.stringify(llmResponse, null, 2));

        if (!llmResponse) {
            throw new Error('Received null or invalid response from GitHub workspace LLM.');
        }

        const responseText = llmResponse || '';
        let cleanedJsonString = responseText.trim();
        if (cleanedJsonString.startsWith('```json')) {
            cleanedJsonString = cleanedJsonString.substring(7);
        }
        if (cleanedJsonString.startsWith('```')) {
            cleanedJsonString = cleanedJsonString.substring(3);
        }
        if (cleanedJsonString.endsWith('```')) {
            cleanedJsonString = cleanedJsonString.substring(0, cleanedJsonString.length - 3);
        }
        cleanedJsonString = cleanedJsonString.trim();

        let apiDetails;
        try {
            if (cleanedJsonString === '') throw new Error('LLM response text was empty after cleaning.');
            apiDetails = JSON.parse(cleanedJsonString);
        } catch (parseError) {
            console.error('[Command Handler] Failed to parse cleaned LLM response as JSON:', parseError);
            console.error('[Command Handler] Original response text:', responseText);
            console.error('[Command Handler] Cleaned string before parse attempt:', cleanedJsonString);
            await slack.chat.postMessage({
                channel: channel,
                thread_ts: replyTarget,
                text: `⚠️ Sorry, I couldn't understand the API instructions from the GitHub knowledge base. The response wasn't valid JSON even after cleaning.\n\nRaw response: \`\`\`${responseText}\`\`\``
            });
             const ts = await thinkingMessagePromise; // Cleanup thinking message on parse error
             if (ts) slack.chat.delete({ channel: channel, ts: ts }).catch(() => {});
            return true; // Handled (parse error reported)
        }

        // Call the GitHub API using the service
        try {
            console.log("[Command Handler] Calling GitHub API with details:", apiDetails);
            const githubResponse = await callGithubApi(apiDetails);
            console.log("[Command Handler] Received response from GitHub.");

            let finalResponseText = '';
            const rawJsonString = JSON.stringify(githubResponse, null, 2);

            if (formatterWorkspaceSlug) {
                console.log(`[Command Handler] Formatting response using workspace: ${formatterWorkspaceSlug}`);
                const formatPrompt = rawJsonString;
                console.log(`[Command Handler] Sending stringified JSON to formatter (length: ${formatPrompt.length})`);
                try {
                    const formattedLLMResponse = await queryLlm(formatterWorkspaceSlug, null, formatPrompt, 'chat', []);
                    const trimmedResponse = formattedLLMResponse ? formattedLLMResponse.trim() : '';
                    if (trimmedResponse.length > 0) {
                        let rawFormatted = trimmedResponse;
                        console.log("[Command Handler] Successfully received formatted response (before cleaning).");
                        let cleanedFormattedResponse = rawFormatted;
                        if (cleanedFormattedResponse.startsWith('```markdown')) {
                            cleanedFormattedResponse = cleanedFormattedResponse.substring(11);
                        } else if (cleanedFormattedResponse.startsWith('```')) {
                            cleanedFormattedResponse = cleanedFormattedResponse.substring(3);
                        }
                        if (cleanedFormattedResponse.endsWith('```')) {
                            cleanedFormattedResponse = cleanedFormattedResponse.substring(0, cleanedFormattedResponse.length - 3);
                        }
                        finalResponseText = cleanedFormattedResponse.trim();
                        console.log("[Command Handler] Cleaned formatted response before sending to Slack.");
                    } else {
                        console.warn("[Command Handler] Formatter LLM returned empty. Falling back to raw JSON.");
                        finalResponseText = `(Formatter failed or returned empty, showing raw data):\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                    }
                } catch (formatError) {
                    console.error('[Command Handler] Error calling formatter LLM:', formatError);
                    finalResponseText = `(Error during formatting: ${formatError.message})\n\nRaw data:\n\`\`\`json\n${rawJsonString}\n\`\`\``;
                }
            } else {
                console.log("[Command Handler] No formatter workspace configured. Sending raw JSON.");
                finalResponseText = `Here is the raw response from the GitHub API:\n\`\`\`json\n${rawJsonString}\n\`\`\``;
            }

            console.log("[Command Handler] Splitting final response for Slack.");
            const chunks = splitMessageIntoChunks( finalResponseText );
            console.log(`[Command Handler] Split into ${chunks.length} chunk(s).`);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                console.log(`[Command Handler] Processing chunk ${i + 1}/${chunks.length}`);
                const responseBlock = markdownToRichTextBlock(chunk);
                if (responseBlock) {
                    await slack.chat.postMessage({
                        channel: channel,
                        thread_ts: replyTarget,
                        text: chunk.substring(0, 200),
                        blocks: [responseBlock]
                    });
                } else {
                    console.warn(`[Command Handler] Failed block generation for chunk ${i + 1}. Sending plain text.`);
                    await slack.chat.postMessage({
                        channel: channel,
                        thread_ts: replyTarget,
                        text: chunk
                    });
                }
                if (chunks.length > 1 && i < chunks.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            console.log("[Command Handler] Finished posting all chunks.");

            // Cleanup handled below

        } catch (apiError) {
            console.error('[Command Handler] Error calling GitHub API:', apiError);
            try {
                await slack.chat.postMessage({
                    channel: channel,
                    thread_ts: replyTarget,
                    text: `Sorry, I encountered an error while calling the GitHub API: ${apiError.message}`
                });
            } catch (slackErrorWhileReportingApiError) {
                console.error('[Command Handler] CRITICAL: Failed API call AND failed report to Slack:', slackErrorWhileReportingApiError);
                console.error('[Command Handler] Original API Error:', apiError);
            }
            // Cleanup handled below, still return true as we handled the command trigger
        }

    } catch (llmError) {
        console.error('[Command Handler] Error querying GitHub workspace LLM:', llmError);
        await slack.chat.postMessage({
            channel: channel,
            thread_ts: replyTarget,
            text: `Sorry, I encountered an error trying to figure out the GitHub API call: ${llmError.message}`
        });
        // Cleanup handled below, still return true as we handled the command trigger
    }

    // Cleanup Thinking Message regardless of success/failure within this handler
    try {
        const tsToDelete = await thinkingMessagePromise;
        if (tsToDelete) {
            console.log(`[Command Handler] Deleting thinking message (ts: ${tsToDelete}).`);
            await slack.chat.delete({ channel: channel, ts: tsToDelete });
        }
    } catch (deleteError) {
        console.warn("[Command Handler] Failed to delete thinking message:", deleteError.data?.error || deleteError.message);
    }

    return true; // Command was handled (success or error reported)
}

// TODO: Add handlers for GitHub API calls

export {
    handleDeleteLastMessageCommand,
    handleReleaseInfoCommand,
    handlePrReviewCommand,
    handleIssueAnalysisCommand,
    handleGithubApiCommand // Export the new handler
    // Add other handlers here as they are created
};
