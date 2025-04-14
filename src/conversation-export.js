import { slack } from './slack.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { anythingLLMBaseUrl, anythingLLMApiKey } from './config.js';
import axios from 'axios';

/**
 * Formats a Slack message into Markdown
 * @param {Object} message - Slack message object
 * @param {Object} userInfo - User info cache object
 * @returns {Promise<string>} Formatted markdown string
 */
async function formatMessageToMarkdown(message, userInfo) {
    // Get user info if not in cache
    if (!userInfo[message.user]) {
        try {
            const result = await slack.users.info({ user: message.user });
            userInfo[message.user] = result.user;
        } catch (error) {
            console.error(`Error fetching user info for ${message.user}:`, error);
            userInfo[message.user] = { real_name: 'Unknown User' };
        }
    }

    const userName = userInfo[message.user]?.real_name || 'Unknown User';
    const timestamp = new Date(parseFloat(message.ts) * 1000).toISOString();
    
    // Format the message text
    let messageText = message.text || '';
    
    // Handle code blocks
    messageText = messageText.replace(/```(\w+)?\n([\s\S]+?)```/g, (match, lang, code) => {
        const language = lang || '';
        return `\n\`\`\`${language}\n${code.trim()}\n\`\`\`\n`;
    });

    // Handle inline code
    messageText = messageText.replace(/`([^`]+)`/g, '`$1`');

    // Handle links
    messageText = messageText.replace(/<(https?:[^>|]+)(\|([^>]+))?>/g, '[$3]($1)');

    // Handle user mentions
    messageText = messageText.replace(/<@(\w+)>/g, async (match, userId) => {
        if (!userInfo[userId]) {
            try {
                const result = await slack.users.info({ user: userId });
                userInfo[userId] = result.user;
            } catch (error) {
                return '@Unknown User';
            }
        }
        return `@${userInfo[userId].real_name}`;
    });

    return `### ${userName} (${timestamp})\n\n${messageText}\n\n`;
}

/**
 * Exports a Slack conversation to Markdown format
 * @param {string} channelId - Slack channel ID
 * @param {string} threadTs - Thread timestamp
 * @returns {Promise<{content: string, metadata: Object}>} Markdown content and metadata
 */
/**
 * Uploads a document to AnythingLLM workspace
 * @param {string} content - The markdown content to upload
 * @param {string} filename - The filename to use
 * @returns {Promise<Object>} Response from AnythingLLM
 */
/**
 * Adds an uploaded document to the conversations workspace
 * @param {string} docPath - The path of the uploaded document
 * @returns {Promise<Object>} Response from AnythingLLM
 */
async function addToConversationsWorkspace(docPath) {
    try {
        const response = await axios.post(
            `${anythingLLMBaseUrl}/api/v1/workspace/conversations/documents/add`,
            { documents: [docPath] },
            {
                headers: {
                    'Authorization': `Bearer ${anythingLLMApiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error adding document to workspace:', error);
        throw error;
    }
}

/**
 * Uploads a document to AnythingLLM and adds it to conversations workspace
 * @param {string} content - The markdown content to upload
 * @param {string} filename - The filename to use
 * @returns {Promise<Object>} Response from AnythingLLM
 */
async function uploadToAnythingLLM(content, filename) {
    // Create a temporary file
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }
    const tempFile = path.join(tempDir, filename);
    fs.writeFileSync(tempFile, content);

    try {
        // Create form data
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFile));

        // Upload to AnythingLLM
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/document/upload`, form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${anythingLLMApiKey}`,
                'Accept': 'application/json'
            }
        });

        const uploadResponse = response.data;
        
        // If upload successful, add to conversations workspace
        if (uploadResponse.success && uploadResponse.documents && uploadResponse.documents.length > 0) {
            const docPath = uploadResponse.documents[0];
            const workspaceResponse = await addToConversationsWorkspace(docPath);
            return {
                ...uploadResponse,
                workspace: workspaceResponse
            };
        }
        
        return uploadResponse;
    } finally {
        // Clean up temp file
        fs.unlinkSync(tempFile);
    }
}

/**
 * Exports a Slack conversation to Markdown and optionally uploads to AnythingLLM
 * @param {string} channelId - Slack channel ID
 * @param {string} threadTs - Thread timestamp
 * @param {boolean} uploadToLLM - Whether to upload to AnythingLLM
 * @returns {Promise<{content: string, metadata: Object, llmResponse?: Object}>}
 */
export async function exportConversationToMarkdown(channelId, threadTs, uploadToLLM = true) {
    try {
        // Get channel info
        const channelInfo = await slack.conversations.info({ channel: channelId });
        const channelName = channelInfo.channel.name || 'unknown-channel';

        // Get conversation history
        const result = await slack.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: 1000 // Adjust as needed
        });

        if (!result.ok || !result.messages) {
            throw new Error('Failed to fetch conversation history');
        }

        // User info cache to avoid repeated API calls
        const userInfo = {};

        // Generate markdown content
        let markdown = `# Slack Conversation Export\n\n`;
        markdown += `**Channel:** #${channelName}\n`;
        markdown += `**Thread:** ${new Date(parseFloat(threadTs) * 1000).toISOString()}\n\n`;
        markdown += `---\n\n`;

        // Process each message
        for (const message of result.messages) {
            markdown += await formatMessageToMarkdown(message, userInfo);
        }

        // Add export metadata
        const metadata = {
            exportedAt: new Date().toISOString(),
            channelId,
            channelName,
            threadTs,
            messageCount: result.messages.length
        };

        const exportResult = {
            content: markdown,
            metadata
        };

        // Upload to AnythingLLM if requested
        if (uploadToLLM) {
            try {
                const filename = `conversation-${metadata.channelName}-${threadTs}.md`;
                const llmResponse = await uploadToAnythingLLM(markdown, filename);
                exportResult.llmResponse = llmResponse;
            } catch (error) {
                console.error('Error uploading to AnythingLLM:', error);
                exportResult.llmError = error.message;
            }
        }

        return exportResult;
    } catch (error) {
        console.error('Error exporting conversation:', error);
        throw error;
    }
}
