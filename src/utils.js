import slackifyMarkdown from 'slackify-markdown';
import { redisUrl, isRedisReady, redisClient } from './services.js'; // We'll create services.js next
import {
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
     try {
         return slackifyMarkdown(rawText);
     } catch (conversionError) {
         console.error("[Utils] Error converting response with slackify-markdown, using raw reply:", conversionError);
         return rawText; // Return raw text if conversion fails
     }
}
