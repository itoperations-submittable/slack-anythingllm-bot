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