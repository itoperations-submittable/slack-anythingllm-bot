import { createClient } from 'redis';
import pg from 'pg';
import { redisUrl, databaseUrl } from './config.js';

// --- Redis Client Setup ---
export let redisClient;
export let isRedisReady = false;

if (redisUrl) {
    console.log("[Service Init] Configuring Redis...");
    redisClient = createClient({
        url: redisUrl,
        socket: { reconnectStrategy: retries => Math.min(retries * 100, 3000) },
    });
    redisClient.on('error', err => { console.error('Redis error:', err); isRedisReady = false; });
    redisClient.on('connect', () => console.log('Redis connecting...'));
    redisClient.on('ready', () => { console.log('Redis connected!'); isRedisReady = true; });
    redisClient.on('end', () => { console.log('Redis connection closed.'); isRedisReady = false; });
    redisClient.connect().catch(err => {
        console.error("Initial Redis connection failed:", err);
        // Optionally exit if Redis is critical
        // process.exit(1);
    });
} else {
    console.warn("[Service Init] Redis URL not provided. Using dummy Redis client.");
    redisClient = {
        isReady: false,
        set: async () => null, get: async() => null, del: async() => 0,
        on: () => {}, connect: async () => {}, isOpen: false, quit: async () => {}
    };
}

// --- Database Setup (PostgreSQL Example) ---
export let dbPool;

if (databaseUrl) {
    console.log("[Service Init] Configuring Database Pool...");
    dbPool = new pg.Pool({
        connectionString: databaseUrl,
        // ssl: { rejectUnauthorized: false } // Uncomment/adjust if needed
    });
    dbPool.on('error', (err, client) => {
         console.error('Unexpected DB pool error', err);
    });
} else {
    console.warn("[Service Init] Database URL not provided. Using dummy DB pool.");
    dbPool = {
        query: async (...args) => {
             console.warn("DB query attempted but DATABASE_URL not set. Args:", args);
             return { rows: [{ id: null }], rowCount: 0, command: 'INSERT' };
        },
        connect: async () => ({
            query: async (...args) => {
                console.warn("DB query attempted on dummy client but DATABASE_URL not set. Args:", args);
                return { rows: [{ id: null }], rowCount: 0, command: 'INSERT' };
            },
            release: () => {}
        })
    };
}

// Graceful shutdown function for services
export async function shutdownServices(signal) {
    console.log(`${signal} signal received: closing service connections.`);
    if (redisClient?.isOpen) {
        try {
            await redisClient.quit();
            console.log('Redis connection closed gracefully.');
        } catch(err) {
            console.error('Error closing Redis connection:', err);
        }
    }
    if (dbPool && databaseUrl) {
        try {
            await dbPool.end();
            console.log('Database pool closed gracefully.');
        } catch (err) {
            console.error('Error closing Database pool:', err);
        }
    }
}

// --- Slack/AnythingLLM Thread Mapping --- 

/**
 * Retrieves the AnythingLLM thread mapping for a given Slack thread.
 * Updates the last_accessed_at timestamp.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @returns {Promise<{anythingllm_thread_slug: string, anythingllm_workspace_slug: string} | null>} Mapping object or null if not found.
 */
export async function getAnythingLLMThreadMapping(channelId, slackThreadTs) {
    if (!dbPool || !databaseUrl) {
        console.warn("[Service/ThreadMap] DB unavailable, cannot get mapping.");
        return null;
    }
    const selectQuery = `
        SELECT anythingllm_thread_slug, anythingllm_workspace_slug
        FROM slack_anythingllm_threads
        WHERE slack_channel_id = $1 AND slack_thread_ts = $2;`;
    const updateAccessTimeQuery = `
        UPDATE slack_anythingllm_threads
        SET last_accessed_at = CURRENT_TIMESTAMP
        WHERE slack_channel_id = $1 AND slack_thread_ts = $2;`;

    let client;
    try {
        client = await dbPool.connect();
        // Select first
        const result = await client.query(selectQuery, [channelId, slackThreadTs]);
        if (result.rows.length > 0) {
            const mapping = result.rows[0];
            console.log(`[Service/ThreadMap] Found mapping: Slack ${channelId}:${slackThreadTs} -> AnythingLLM ${mapping.anythingllm_workspace_slug}:${mapping.anythingllm_thread_slug}`);
            // Update access time asynchronously (don't wait for it)
            client.query(updateAccessTimeQuery, [channelId, slackThreadTs])
                .catch(err => console.error("[Service/ThreadMap] Failed update access time:", err));
            return mapping;
        } else {
            console.log(`[Service/ThreadMap] No mapping found for Slack ${channelId}:${slackThreadTs}`);
            return null;
        }
    } catch (err) {
        console.error("[Service/ThreadMap DB Error] Failed getting mapping:", err);
        return null;
    } finally {
        if (client) client.release();
    }
}

/**
 * Stores a new mapping between a Slack thread and an AnythingLLM thread.
 * @param {string} channelId - The Slack channel ID.
 * @param {string} slackThreadTs - The starting timestamp of the Slack thread.
 * @param {string} workspaceSlug - The AnythingLLM workspace slug.
 * @param {string} anythingLLMThreadSlug - The AnythingLLM thread slug.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
export async function storeAnythingLLMThreadMapping(channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug) {
    if (!dbPool || !databaseUrl) {
        console.warn("[Service/ThreadMap] DB unavailable, cannot store mapping.");
        return false;
    }
    const insertQuery = `
        INSERT INTO slack_anythingllm_threads 
            (slack_channel_id, slack_thread_ts, anythingllm_workspace_slug, anythingllm_thread_slug)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (slack_channel_id, slack_thread_ts) DO NOTHING; -- Avoid errors if mapping somehow already exists
    `;
    let client;
    try {
        client = await dbPool.connect();
        const result = await client.query(insertQuery, [channelId, slackThreadTs, workspaceSlug, anythingLLMThreadSlug]);
        console.log(`[Service/ThreadMap] Stored mapping: Slack ${channelId}:${slackThreadTs} -> AnythingLLM ${workspaceSlug}:${anythingLLMThreadSlug}. Result rows: ${result.rowCount}`);
        return result.rowCount > 0;
    } catch (err) {
        console.error("[Service/ThreadMap DB Error] Failed storing mapping:", err);
        return false;
    } finally {
        if (client) client.release();
    }
} 