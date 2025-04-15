import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { redisClient, dbPool } from '../src/services.js';
// import fetchMock from 'jest-fetch-mock'; // REMOVED

// REMOVED fetchMock.enableMocks();

// This file runs automatically after the test framework has been set up.

// Set a longer timeout for cleanup
jest.setTimeout(10000);

beforeAll(async () => {
  // Wait for Redis to connect
  if (redisClient && ! redisClient.isOpen ) {
    try {
      await redisClient.connect();
    } catch (err) {
      console.error('\n[Test Setup] Error connecting to Redis:', err);
    }
  }
});

afterAll(async () => {
  // Close connections after all tests are done to prevent Jest warnings
  if (redisClient) {
    try {
      await redisClient.quit(); // Use quit() instead of disconnect() for cleaner shutdown
      console.log('\n[Test Teardown] Redis client disconnected.');
    } catch (err) {
      console.error('\n[Test Teardown] Error disconnecting Redis:', err);
    }
  }
  if (dbPool) {
    try {
      await dbPool.end();
      console.log('[Test Teardown] Database pool closed.');
    } catch (err) {
      console.error('\n[Test Teardown] Error closing database pool:', err);
    }
  }
  // Give time for cleanup
  await new Promise(resolve => setTimeout(resolve, 1000));
});