import {
    isRedisReady, redisClient // Correct: Import only client and status from services
} from './services.js';
import {
    redisUrl, // Correct: Import URL from config
    DUPLICATE_EVENT_REDIS_PREFIX,
    DUPLICATE_EVENT_TTL
    // GITHUB_OWNER, // Removed
    // githubToken // Removed
} from './config.js';
// import fetch from 'node-fetch'; // Removed - was for callGithubApi

// --- Event Deduplication ---

// Function to check for duplicate events using Redis
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

// --- Formatting functions moved to src/formattingService.js ---
// - splitByCharCount
// - splitMessageIntoChunks
// - splitTextByLogicalBreaks
// - extractTextAndCode
// - getSlackFiletype
// - formatSlackMessage (REMOVED - unused)
// - markdownToRichTextBlock
// - parseInlineFormatting
