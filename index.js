// index.js
import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import { WebClient } from '@slack/web-api';

// Load environment variables
dotenv.config();

const app = express();
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const redis = new Redis(process.env.REDIS_URL);
const PORT = process.env.PORT || 3000;

const DEV_MODE = process.env.DEV_MODE === 'true';
const DEVELOPER_ID = process.env.DEVELOPER_ID;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

let activeWorkspaceBySession = new Map();

app.use(bodyParser.json({ verify: verifySlackRequest }));

// Slack signature verification middleware
function verifySlackRequest(req, res, buf) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const sigBaseString = `v0:${timestamp}:${buf.toString()}`;
  const hmac = crypto.createHmac('sha256', SIGNING_SECRET);
  hmac.update(sigBaseString);
  const expectedSignature = `v0=${hmac.digest('hex')}`;
  const actualSignature = req.headers['x-slack-signature'];

  if (!crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(actualSignature))) {
    throw new Error('Invalid Slack signature');
  }
}

// Utility: fetch workspace list from AnythingLLM
async function fetchWorkspaces() {
  try {
    const response = await axios.get(`${process.env.ANYTHINGLLM_URL}/api/v1/workspaces`, {
      headers: {
        Authorization: `Bearer ${process.env.ANYTHINGLLM_API_KEY}`
      }
    });
    return response.data.workspaces || [];
  } catch (err) {
    console.error('[ERROR] Failed to fetch workspaces:', err);
    return [];
  }
}

// Utility: send message to Slack
async function sendMessage(channel, text) {
  try {
    await slackClient.chat.postMessage({ channel, text });
  } catch (err) {
    console.error('[ERROR] Failed to send Slack message:', err);
  }
}

// Event endpoint
app.post('/slack/events', async (req, res) => {
  const { event, type } = req.body;
  res.sendStatus(200);

  if (type !== 'event_callback') return;
  if (!event || event.bot_id || !event.text) return;

  const isDM = event.channel_type === 'im';
  const isDeveloper = event.user === DEVELOPER_ID;
  const channel = event.channel;

  if (DEV_MODE && (!isDeveloper && isDM)) {
    console.log('[EVENT] Non-developer DM => ignoring');
    return;
  }

  // Get or fallback workspace
  const sessionId = event.user;
  const activeWorkspace = activeWorkspaceBySession.get(sessionId) || 'public';

  // Send message to AnythingLLM workspace
  const llmRes = await talkToLLM(activeWorkspace, event.text, sessionId);

  if (llmRes && llmRes.type === 'abort' && llmRes.error?.includes('not a valid workspace')) {
    await sendMessage(channel, `:warning: Failed to talk to workspace "${activeWorkspace}". Using public fallback...`);
    const fallbackRes = await talkToLLM('public', event.text, sessionId);
    if (fallbackRes?.textResponse) await sendMessage(channel, fallbackRes.textResponse);
  } else if (llmRes?.textResponse) {
    await sendMessage(channel, llmRes.textResponse);
  }
});

// Utility: talk to AnythingLLM
async function talkToLLM(workspace, message, sessionId) {
  try {
    const response = await axios.post(
      `${process.env.ANYTHINGLLM_URL}/api/v1/workspace/${workspace}/chat`,
      {
        message,
        mode: 'chat',
        sessionId
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.ANYTHINGLLM_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (err) {
    console.error('[ERROR] Failed to talk to workspace:', err?.response?.data || err);
    return null;
  }
}

// Show logs on Render
app.get('/', (req, res) => {
  res.send('DeepOrbit is live');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
