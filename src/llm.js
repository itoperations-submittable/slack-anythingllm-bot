import axios from 'axios';
import {
    anythingLLMBaseUrl,
    anythingLLMApiKey,
    WORKSPACE_LIST_CACHE_KEY,
    WORKSPACE_LIST_CACHE_TTL
} from './config.js';
import { redisClient, isRedisReady, redisUrl } from './services.js';

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
    console.warn("[LLM Service/getSlugs] Failed to get slugs from all sources. Falling back to ['public'].");
    return ['public'];
}

// --- Sphere Decision Logic ---
export async function decideSphere(userQuestion, conversationHistory = "") {
    console.log(`[LLM Service/decideSphere] Starting for query: "${userQuestion}".`);
    const availableWorkspaces = await getAvailableSphereSlugs();

    if (!availableWorkspaces || availableWorkspaces.length === 0) {
         console.error("[LLM Service/decideSphere] No workspace slugs available. Falling back.");
         return 'public';
    }

    // Ensure 'public' is always an option if not explicitly listed
    if (!availableWorkspaces.includes('public')) {
        availableWorkspaces.push('public');
    }

    let selectionPrompt = "Consider the following conversation history (if any):\n";
    selectionPrompt += conversationHistory ? conversationHistory.trim() + "\n\n" : "[No History Provided]\n\n";
    selectionPrompt += `Based on the history (if any) and the latest user query: "${userQuestion}"\n\n`;
    selectionPrompt += `Which knowledge sphere (represented by a workspace slug) from this list [${availableWorkspaces.join(', ')}] is the most relevant context to answer the query?\n`;
    selectionPrompt += `Your answer should ONLY be the workspace slug itself, exactly as it appears in the list.`;

    console.log(`[LLM Service/decideSphere] Sending context-aware prompt to public routing.`);

    try {
        const startTime = Date.now();
        const selectionResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/public/chat`, {
            message: selectionPrompt, mode: 'chat',
        }, { headers: { Authorization: `Bearer ${anythingLLMApiKey}` }, timeout: 35000 });
        const duration = Date.now() - startTime;
        console.log(`[LLM Service/decideSphere] Routing LLM call duration: ${duration}ms`);

        const chosenSlugRaw = selectionResponse.data?.textResponse;
        console.log(`[LLM Service/decideSphere] Raw routing response: "${chosenSlugRaw}"`);
        if (!chosenSlugRaw || typeof chosenSlugRaw !== 'string') { console.warn('[LLM Service/decideSphere] Bad routing response.'); return 'public';}
        const chosenSlug = chosenSlugRaw.trim();

        if (availableWorkspaces.includes(chosenSlug)) {
            console.log(`[LLM Service/decideSphere] Context-aware valid slug selected: "${chosenSlug}"`);
            return chosenSlug;
        } else {
            // Try to find a partial match in case of extra text from LLM
            const foundSlug = availableWorkspaces.find(slug => chosenSlug.includes(slug));
            if (foundSlug) {
                console.log(`[LLM Service/decideSphere] Found valid slug "${foundSlug}" in noisy response.`);
                return foundSlug;
            }
            console.warn(`[LLM Service/decideSphere] Invalid slug response "${chosenSlug}". Falling back.`);
            return 'public';
        }
    } catch (error) {
        console.error('[LLM Service/decideSphere] Failed query public workspace:', error.response?.data || error.message);
        return 'public'; // Fallback on error
    }
}

// --- Main LLM Chat Function (Non-Streaming) ---
export async function queryLlm(sphere, inputText, sessionId) {
    console.log(`[LLM Service/queryLlm] Querying sphere: ${sphere}`);
    try {
        const llmResponse = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${sphere}/chat`, {
            message: inputText,
            mode: 'chat',
            sessionId: sessionId,
        }, {
            headers: { Authorization: `Bearer ${anythingLLMApiKey}` },
            timeout: 90000, // 90s timeout for final answer
        });
        return llmResponse.data.textResponse || null; // Return null if no textResponse
    } catch (error) {
        console.error(`[LLM Error - Sphere: ${sphere}]`, error.response?.data || error.message);
        throw new Error(`LLM query failed for sphere ${sphere}: ${error.message}`); // Re-throw error for handling upstream
    }
}

// --- Function to get available workspaces (exposed) ---
export const getWorkspaces = getAvailableSphereSlugs;
