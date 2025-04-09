import slackifyMarkdown from 'slackify-markdown';
import {
    isRedisReady, redisClient // Correct: Import only client and status from services
} from './services.js';
import {
    redisUrl, // Correct: Import URL from config
    DUPLICATE_EVENT_REDIS_PREFIX,
    DUPLICATE_EVENT_TTL
} from './config.js';

// --- Event Deduplication ---
export async function isDuplicateRedis(eventId) {
    if (!redisUrl || !isRedisReady) { return false; } // Feature disabled if Redis isn't configured/ready
    const key = `${DUPLICATE_EVENT_REDIS_PREFIX}${eventId}`;
    try {
        // SET NX (set if not exists) with EX (expiration) is atomic
        const result = await redisClient.set(key, '1', { NX: true, EX: DUPLICATE_EVENT_TTL });
        return result === null; // If null, key already existed
    } catch (error) {
        console.error(`[Redis Deduplication Error] Failed operation for key ${key}:`, error);
        return false; // Fail open (assume not duplicate) if Redis fails
    }
}

// --- Message Splitting ---
export function splitMessageIntoChunks(message, maxLength) {
    const chunks = [];
    let currentChunk = '';

    // Split message by lines first to avoid breaking mid-line potentially
    const lines = message.split('\\n');

    for (const line of lines) {
        // Check if adding the next line exceeds maxLength
        if (currentChunk.length + line.length + 1 <= maxLength) { // +1 for newline char
            currentChunk += line + '\\n';
        } else {
            // If the current line itself is too long, split it
            if (line.length > maxLength) {
                // Push the previous chunk if it has content
                if (currentChunk.trim().length > 0) {
                    chunks.push(currentChunk.trim());
                }
                currentChunk = ''; // Reset chunk

                // Split the long line
                let remainingLine = line;
                while (remainingLine.length > maxLength) {
                    // Find the best split point (e.g., space) backwards from maxLength
                    let splitPoint = remainingLine.lastIndexOf(' ', maxLength);
                    // If no space found, force break at maxLength
                    if (splitPoint === -1 || splitPoint === 0) {
                       splitPoint = maxLength;
                    }
                    chunks.push(remainingLine.substring(0, splitPoint));
                    remainingLine = remainingLine.substring(splitPoint).trimStart();
                }
                 // Add the rest of the split line as a new chunk potential
                if (remainingLine.length > 0) {
                    currentChunk = remainingLine + '\\n';
                }

            } else {
                // The current line isn't too long itself, but adding it exceeds the limit
                // Push the completed chunk and start a new one with the current line
                if (currentChunk.trim().length > 0) {
                     chunks.push(currentChunk.trim());
                }
                currentChunk = line + '\\n';
            }
        }
    }

    // Add the last chunk if it has content
    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    // Handle case where message was empty or only whitespace
    if (chunks.length === 0 && message.trim().length === 0) {
        return ['']; // Return a single empty chunk if input was effectively empty
    }

    return chunks;
}


// --- Text and Code Extraction ---

/**
 * Maps common language identifiers to Slack filetypes.
 * Add more mappings as needed.
 */
const languageToFiletypeMap = {
    'javascript': 'javascript', 'js': 'javascript',
    'typescript': 'typescript', 'ts': 'typescript',
    'python': 'python', 'py': 'python',
    'php': 'php',
    'java': 'java',
    'csharp': 'csharp', 'cs': 'csharp',
    'cpp': 'cpp', 'c++': 'cpp',
    'ruby': 'ruby', 'rb': 'ruby',
    'swift': 'swift',
    'kotlin': 'kotlin', 'kt': 'kotlin',
    'go': 'go', 'golang': 'go',
    'rust': 'rust', 'rs': 'rust',
    'html': 'html',
    'css': 'css',
    'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml',
    'markdown': 'markdown', 'md': 'markdown',
    'sql': 'sql',
    'shell': 'shell', 'bash': 'shell', 'sh': 'shell',
    'plaintext': 'text', 'text': 'text',
    'diff': 'diff',
    'dockerfile': 'dockerfile',
};

/**
 * Splits raw LLM text into an array of text and code segments.
 * @param {string} rawText - The raw text from the LLM.
 * @returns {Array<{type: 'text' | 'code', content: string, language?: string}>}
 */
export function extractTextAndCode(rawText) {
    if (!rawText) return [];

    const segments = [];
    // Regex to find code blocks, capturing optional language and content
    // Allows for optional spaces around language identifier
    const codeBlockRegex = /^``` *(\w+)? *\n([\s\S]*?)^```$/gm;

    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(rawText)) !== null) {
        const languageIdentifier = match[1]?.toLowerCase() || 'text'; // Default to 'text' if no language
        const codeContent = match[2];
        const startIndex = match.index;
        const endIndex = codeBlockRegex.lastIndex;

        // Add preceding text segment if it exists
        if (startIndex > lastIndex) {
            segments.push({
                type: 'text',
                content: rawText.substring(lastIndex, startIndex).trim() // Trim whitespace from text segments
            });
        }

        // Add the code block segment
        segments.push({
            type: 'code',
            content: codeContent,
            language: languageIdentifier // Store the identifier used by LLM
        });

        lastIndex = endIndex;
    }

    // Add any remaining text after the last code block
    if (lastIndex < rawText.length) {
        segments.push({
            type: 'text',
            content: rawText.substring(lastIndex).trim()
        });
    }

    // Filter out empty text segments that might result from trimming
    return segments.filter(segment => segment.type === 'code' || segment.content.length > 0);
}

/**
 * Gets the corresponding Slack filetype for a language identifier.
 * @param {string} language - The language identifier (e.g., 'javascript', 'php').
 * @returns {string} The Slack filetype (e.g., 'javascript', 'php', 'text').
 */
export function getSlackFiletype(language) {
    return languageToFiletypeMap[language?.toLowerCase()] || 'text'; // Default to 'text'
}


// --- Slack Markdown Conversion (Simplified) ---
// This function now ONLY handles basic markdown conversion for *text* segments.
// Code blocks are handled separately.
export function formatSlackMessage(textSegment) {
     if (!textSegment) return '';

     try {
         // STEP 1: Pre-process to remove language identifiers from code blocks
         // This helps slackify-markdown to properly handle code blocks
         let processedText = textSegment.replace(/^```(\w+)\n/gm, '```\n');
         
         // STEP 2: Add proper spacing around code fences for better rendering
         processedText = processedText.replace(/^```\n(?!\n)/gm, '```\n\n');
         processedText = processedText.replace(/(?<!\n)\n```$/gm, '\n\n```');
         
         // STEP 3: Remove any escaped newlines that might be at the end
         processedText = processedText.replace(/\\n\s*$/, '');
         
         // STEP 4: Remove any double-escaped newlines anywhere in the text
         processedText = processedText.replace(/\\\\n/g, '');

         // Convert the pre-processed Markdown text to Slack mrkdwn 
         return slackifyMarkdown(processedText);
     } catch (conversionError) {
         console.error("[Utils] Error converting text segment with slackify-markdown, using original:", conversionError);
         // Fallback to the original text if slackify fails
         return textSegment;
     }
}
