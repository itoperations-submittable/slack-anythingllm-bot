// index.js

import express from 'express';
import { createEventAdapter } from '@slack/events-api';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import { WebClient } from '@slack/web-api';
import bodyParser from 'body-parser';
import crypto from 'crypto';

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
const slackToken = process.env.SLACK_BOT_TOKEN;
const anythingLLMBaseUrl = process.env.LLM_API_BASE_URL;
const anythingLLMApiKey = process.env.LLM_API_KEY;
const developerId = process.env.DEVELOPER_ID;

const redisUrl = process.env.REDIS_URL;
const redisClient = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: retries => Math.min(retries * 100, 3000),
  },
});

// Log Redis connection status
redisClient.on('error', err => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('Redis connecting...'));
redisClient.on('ready', () => console.log('Redis connected!'));
redisClient.connect();

const slackEvents = createEventAdapter(slackSigningSecret);
const slack = new WebClient(slackToken);

const recentEvents = new Set();

function isDuplicate(eventId) {
  if (recentEvents.has(eventId)) return true;
  recentEvents.add(eventId);
  setTimeout(() => recentEvents.delete(eventId), 60 * 1000);
  return false;
}

// Slack events endpoint
app.post('/slack/events', bodyParser.json(), async (req, res) => {
  const body = req.body;

  if (!body.event || !body.event.type || !body.event_id) {
    return res.status(400).send('Invalid request');
  }

  if (isDuplicate(body.event_id)) {
    console.log(`[Duplicate] Skipping event: ${body.event_id}`);
    return res.status(200).send();
  }

  res.status(200).send(); // Acknowledge Slack immediately

  try {
    await handleSlackEvent(body);
  } catch (err) {
    console.error('[Slack Event Error]', err);
  }
});

// Main event handler
async function handleSlackEvent(body) {
  const { event } = body;

  if (event.type === 'message' && event.subtype !== 'bot_message') {
    const userId = event.user;
    const text = event.text;
    const threadTs = event.thread_ts || event.ts;
    const channel = event.channel;

    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: ':hourglass_flowing_sand: DeepOrbit is thinking...'
    });

    // Send message to LLM for workspace decision
    const workspace = await decideWorkspace(text);

    // Handle unauthorized users
    if (developerId && userId !== developerId) {
      await slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `🛑 Sorry, DeepOrbit only responds to the developer for now.`
      });
      return;
    }

    try {
      const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace/${workspace}/chat`, {
        message: text,
        mode: 'chat',
        sessionId: userId,
      }, {
        headers: {
          Authorization: `Bearer ${anythingLLMApiKey}`,
        }
      });

      const reply = response.data.textResponse || '⚠️ Something went wrong';
      await slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: reply
      });
    } catch (error) {
      console.error('[LLM Error]', error);
      await slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '⚠️ DeepOrbit ran into an error. Please try again later.'
      });
    }
  }
}

// Determine workspace using LLM
async function decideWorkspace(prompt) {
  try {
    const response = await axios.post(`${anythingLLMBaseUrl}/api/v1/workspace-detection`, {
      message: prompt
    }, {
      headers: {
        Authorization: `Bearer ${anythingLLMApiKey}`,
      }
    });

    const workspace = response.data?.workspace || 'public';
    console.log(`[Decision] LLM chose workspace: "${workspace}" for message: "${prompt}"`);

    // Validate workspace format
    if (!workspace.match(/^[a-z0-9\-]+$/i)) {
      console.warn(`[Invalid Workspace] Falling back to public`);
      return 'public';
    }

    return workspace;
  } catch (error) {
    console.error('[Workspace Decision Error]', error);
    return 'public';
  }
}

app.get('/', (req, res) => {
  res.send('DeepOrbit is live 🎯');
});

app.listen(port, () => {
  console.log(`🚀 DeepOrbit running on port ${port}`);
});
