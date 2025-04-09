import slackifyMarkdown from 'slackify-markdown';
import { isRedisReady, redisClient } from './services.js'; // Correct: Import only client and status from services
import {
    redisUrl, // Correct: Import URL from config
    DUPLICATE_EVENT_REDIS_PREFIX,
    DUPLICATE_EVENT_TTL
} from './config.js';

// --- Duplicate Event Detection (using Redis) ---
export async function isDuplicateRedis(eventId) {
    if (!eventId) { console.warn("isDuplicateRedis: null eventId"); return true; }
    if (!redisUrl || !isRedisReady) {
        // console.log("[Duplicate Check] Skipping check: Redis unavailable."); // Optional log
        return false; // Cannot check if Redis isn't ready/configured
    }
    try {
        const redisKey = `${DUPLICATE_EVENT_REDIS_PREFIX}${eventId}`;
        const result = await redisClient.set(redisKey, 'processed', { EX: DUPLICATE_EVENT_TTL, NX: true });
        if (result === null) {
            // console.log(`[Duplicate Check] Duplicate event detected: ${eventId}`); // Optional log
            return true; // Key existed
        }
        return false; // Key did not exist, set successfully
    } catch (err) {
        console.error('Redis error during duplicate check:', eventId, err);
        return false; // Assume not duplicate on error to avoid dropping messages
    }
}

// --- Helper Function to Split Long Messages ---
export function splitMessageIntoChunks(text, maxLength) {
    const chunks = [];
    if (!text) return chunks; // Handle null/empty text
    let remainingText = text;

    // Prioritize splitting by double newline (paragraph), then single newline, then sentences, then spaces
    const splitters = ['\n\n', '\n', '. ', '! ', '? ', ' '];

    while (remainingText.length > 0) {
        if (remainingText.length <= maxLength) {
            chunks.push(remainingText);
            break;
        }

        let bestSplitIndex = -1;
        // Try to find the best split point backwards from maxLength
        for (const splitter of splitters) {
             let searchEnd = Math.min(maxLength, remainingText.length -1);
             let splitIndex = remainingText.lastIndexOf(splitter, searchEnd);

             if (splitIndex > 0 && splitIndex > bestSplitIndex) {
                  bestSplitIndex = splitIndex + splitter.length;
             } else if (splitIndex === 0 && splitter.length === 1 && bestSplitIndex <= 0) {
                  bestSplitIndex = 1;
             }
        }

        if (bestSplitIndex <= 0) {
            console.warn(`[Splitter] Forced split at ${maxLength} chars.`);
            bestSplitIndex = maxLength;
        }

        if (bestSplitIndex > 0) {
            chunks.push(remainingText.substring(0, bestSplitIndex));
            remainingText = remainingText.substring(bestSplitIndex).trimStart();
        } else {
            console.error("[Splitter] Failed to find valid split point. Taking remaining text.");
            chunks.push(remainingText);
            remainingText = "";
        }
    }
    return chunks.filter(chunk => chunk.length > 0);
}

// --- Slack Markdown Conversion ---
export function formatSlackMessage(rawText) {
     if (!rawText) return '';

     // 1. Pre-process: Remove language identifiers
     let processedText = rawText.replace(/^``` *(\\w+?) *\\n/gm, '```\\n');

     // 2. Pre-process: Ensure extra newline padding around code blocks for Slack rendering
     processedText = processedText.replace(/^```\\n(?!\\n)/gm, '```\\n\\n');
     processedText = processedText.replace(/(?<!\\n)\\n```$/gm, '\\n\\n```');

     // 3. Isolate Code Blocks to bypass slackifyMarkdown for them
     const codeBlocks = [];
     const codeBlockRegex = /^```(?:.|\\n)*?^```$/gm; // Match ``` blocks spanning multiple lines

     // Temporarily replace code blocks with placeholders
     const textWithoutCodeBlocks = processedText.replace(codeBlockRegex, (match) => {
         const placeholder = `___CODEBLOCK_${codeBlocks.length}___`;
         codeBlocks.push(match); // Store the original, pre-processed block
         return placeholder;
     });

     let slackifiedText = '';
     try {
         // 4. Run slackifyMarkdown ONLY on the text *without* code blocks
         slackifiedText = slackifyMarkdown(textWithoutCodeBlocks);
     } catch (conversionError) {
         console.error("[Utils] Error converting non-code text with slackify-markdown:", conversionError);
         slackifiedText = textWithoutCodeBlocks; // Fallback to text without code blocks if conversion fails
     }

     try {
        // 5. Re-insert the original, pre-processed code blocks
        let finalText = slackifiedText;
        codeBlocks.forEach((block, index) => {
            finalText = finalText.replace(`___CODEBLOCK_${index}___`, block);
        });
        return finalText;

     } catch (reinsertionError) {
        console.error("[Utils] Error re-inserting code blocks:", reinsertionError);
        // Fallback: return the processed text with placeholders OR the original processed text
        // Returning original processed text is safer if re-insertion fails badly.
        return processedText;
     }
}
