import axios from 'axios';
import {
    anythingLLMBaseUrl,
    anythingLLMApiKey,
    WORKSPACE_LIST_CACHE_KEY,
    WORKSPACE_LIST_CACHE_TTL,
    redisUrl
} from './config.js';
import { redisClient, isRedisReady } from './services.js';

// Cache for available workspace slugs
let availableWorkspacesCache = null;
let cacheTimestamp = 0;

// --- Helper: Get Available Sphere Slugs (with In-Memory + Redis Cache) ---
async function getAvailableSphereSlugs() {
    const now = Date.now();

    // 1. Check in-memory cache
    if (availableWorkspacesCache && (now - cacheTimestamp < WORKSPACE_LIST_CACHE_TTL * 1000)) {
        console.log(`[LLM Service/getSlugs] In-memory cache HIT.`);
        return availableWorkspacesCache;
    }

    // 2. Check Redis cache
    if (redisUrl && isRedisReady) {
        try {
            const cachedData = await redisClient.get(WORKSPACE_LIST_CACHE_KEY);
            if (cachedData) {
                const slugs = JSON.parse(cachedData);
                console.log(`[LLM Service/getSlugs] Redis cache HIT. Found ${slugs.length} slugs.`);
                availableWorkspacesCache = slugs;
                cacheTimestamp = now; // Update in-memory cache timestamp
                return slugs;
            }
            console.log(`[LLM Service/getSlugs] Redis cache MISS.`);
        } catch (err) {
            console.error(`[Redis Error] Failed to get workspace cache key ${WORKSPACE_LIST_CACHE_KEY}:`, err);
        }
    }

    // 3. Fetch from API
    console.log(`[LLM Service/getSlugs] Fetching available workspaces from API...`);
    try {
        const response = await axios.get(`${anythingLLMBaseUrl}/api/v1/workspaces`, {
            headers: { 'Accept': 'application/json', Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 10000,
        });

        if (response.data && Array.isArray(response.data.workspaces)) {
            const slugs = response.data.workspaces
                .map(ws => ws.slug)
                .filter(slug => slug && typeof slug === 'string');
            console.log(`[LLM Service/getSlugs] API returned ${slugs.length} slugs.`);

            availableWorkspacesCache = slugs; // Update in-memory cache
            cacheTimestamp = now;

            // Update Redis cache asynchronously (don't block return)
            if (redisUrl && isRedisReady && slugs.length > 0) {
                redisClient.set(WORKSPACE_LIST_CACHE_KEY, JSON.stringify(slugs), { EX: WORKSPACE_LIST_CACHE_TTL })
                    .then(() => console.log(`[LLM Service/getSlugs] Updated Redis cache key ${WORKSPACE_LIST_CACHE_KEY}.`))
                    .catch(cacheSetError => console.error(`[Redis Error] Failed to set workspace cache key ${WORKSPACE_LIST_CACHE_KEY}:`, cacheSetError));
            }
            return slugs;
        } else {
            console.error('[LLM Service/getSlugs] Unexpected API response structure:', response.data);
        }
    } catch (error) {
        console.error('[LLM Service/getSlugs] API Fetch failed:', error.response?.data || error.message);
    }

    // Fallback if all attempts fail
    console.warn("[LLM Service/getSlugs] Failed to get slugs from all sources. Falling back to ['all'].");
    return ['all']; // Default to 'all' if API fails
}

// --- Sphere Decision Logic (REMOVED - Sphere decision now happens in slack.js before creating/fetching thread) ---
// export async function decideSphere(userQuestion, conversationHistory = "") { ... }

// +++ NEW: Function to Create a New AnythingLLM Thread +++
/**
 * Creates a new thread in a specific AnythingLLM workspace.
 * @param {string} sphere - The workspace slug.
 * @returns {Promise<string | null>} The new thread slug, or null on error.
 */
export async function createNewAnythingLLMThread(sphere) {
    console.log(`[LLM Service/createThread] Creating new thread in sphere: ${sphere}...`);
    try {
        const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/thread/new`, 
            {}, // No body needed for thread creation
            { 
                headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
                timeout: 15000, // 15s timeout for thread creation
            });
        
        if (response.data && response.data.thread && response.data.thread.slug) {
            const newThreadSlug = response.data.thread.slug;
            console.log(`[LLM Service/createThread] Successfully created thread with slug: ${newThreadSlug}`);
            return newThreadSlug;
        } else {
            console.error('[LLM Service/createThread] Unexpected API response structure:', response.data);
            return null;
        }
    } catch (error) {
        console.error(`[LLM Error - Create Thread - Sphere: ${sphere}]`, error.response?.data || error.message);
        return null;
    }
}

// --- Main LLM Chat Function (MODIFIED to use Thread Endpoint) ---
// Now requires anythingLLMThreadSlug, uses thread chat endpoint, and only sends current message.
// Removed sessionId parameter.
export async function queryLlm(sphere, anythingLLMThreadSlug, inputText) {
    console.log(`[LLM Service/queryLlm] Querying sphere: ${sphere}, thread: ${anythingLLMThreadSlug}`);
    
    if (!anythingLLMThreadSlug) {
         console.error('[LLM Service/queryLlm] Error: anythingLLMThreadSlug is required but was not provided.');
         throw new Error('Internal error: Missing AnythingLLM thread slug.');
    }
    
    const requestBody = {
        message: inputText, // Only send the current message
        mode: 'query' // Keep mode as query for Q&A
    };

    console.log("[LLM Service/queryLlm] Request Body (Thread Chat):", JSON.stringify(requestBody, null, 2));

    try {
        const llmResponse = await axios.post(
            `${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/thread/${anythingLLMThreadSlug}/chat`,
            requestBody,
            {
                headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
                timeout: 90000, // 90s timeout for final answer
            }
        );
        return llmResponse.data.textResponse || null; // Return null if no textResponse
    } catch (error) {
        console.error(`[LLM Error - Sphere: ${sphere}, Thread: ${anythingLLMThreadSlug}]`, error.response?.data || error.message);
        // More specific error message
        throw new Error(`LLM query failed for sphere ${sphere}, thread ${anythingLLMThreadSlug}: ${error.message}`); 
    }
}

// --- Function to get available workspaces (exposed) ---
export const getWorkspaces = getAvailableSphereSlugs;
