import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import { createClient } from 'redis';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware to verify Slack request signature
app.use(bodyParser.json({ verify: verifySlackRequest }));

function verifySlackRequest(req, res, buf) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSignature = req.headers['x-slack-signature'];
  const baseString = `v0:${timestamp}:${buf.toString()}`;
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
  hmac.update(baseString);
  const mySignature = `v0=${hmac.digest('hex')}`;
  if (slackSignature !== mySignature) {
    throw new Error('Slack signature verification failed');
  }
}

const redisUrl = process.env.REDIS_URL;
let redis;

(async () => {
  try {
    redis = createClient({ url: redisUrl, socket: { tls: true }, legacyMode: true });
    redis.on('error', err => console.error('Redis error:', err));
    await redis.connect();
    console.log('✅ Redis connected!');
  } catch (err) {
    console.error('❌ Redis connection failed:', err);
  }
})();

const ALLOWED_USER = process.env.DEVELOPER_ID;

// Handle Slack event callbacks
app.post('/slack/events', async (req, res) => {
  try {
    const event = req.body.event;
    console.log(`[Slack Event] Type: ${event.type}`);

    // Handle app_home_opened event
    if (event.type === 'app_home_opened') {
      console.log(`[Home] Opened by user: ${event.user}`);
      return res.status(200).end();
    }

    // Ignore bot messages
    if (event.subtype === 'bot_message') return res.status(200).end();

    const userId = event.user;
    const sessionId = event.channel;

    // Check if user is allowed
    if (userId !== ALLOWED_USER) {
      console.log(`[Unauthorized User] ID: ${userId}`);
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: '🛑 I only talk to my creator... unless you bribe me with cookies 🍪',
      });
      return res.status(200).end();
    }

    const workspace = await getWorkspace(sessionId);
    console.log(`[Workspace] Current: ${workspace}`);

    const userMessage = event.text;
    const fallback = 'public';

    try {
      const llmResponse = await handleLLM(userMessage, sessionId, workspace);
      console.log(`[LLM] Response:`, llmResponse);
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: llmResponse,
      });
    } catch (llmErr) {
      console.error('[LLM Error]', llmErr.message);
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: '⚠️ Something went wrong while talking to the AI. Try again later.',
      });
    }

    res.status(200).end();
  } catch (err) {
    console.error('[Slack Event Error]', err);
    res.status(500).send('Internal Server Error');
  }
});

// Root path handler
app.get('/', (req, res) => {
  console.log('[GET] / homepage accessed');
  res.send('DeepOrbit is alive 🚀');
});

// Retrieve workspace from Redis
async function getWorkspace(sessionId) {
  try {
    const workspace = await redis.get(`workspace:${sessionId}`);
    return workspace || 'public';
  } catch (err) {
    console.error('[Redis Get Error]', err);
    return 'public';
  }
}

// Send message to LLM and return response
async function handleLLM(message, sessionId, workspace) {
  const validWorkspaces = ['gravity-forms-core', 'gf-stripe', 'gf-paypal', 'gravityflow', 'docs', 'internal-docs', 'public'];

  if (!validWorkspaces.includes(workspace)) {
    console.warn(`[Workspace Warning] Invalid workspace: ${workspace}. Falling back to public.`);
    workspace = 'public';
  }

  const url = `${process.env.LLM_URL}/api/v1/workspace/${workspace}/chat`;

  try {
    const response = await axios.post(url, {
      message,
      mode: 'chat',
      sessionId,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
    });
    return response.data.textResponse || '🤖 No response from LLM';
  } catch (error) {
    console.error('[Axios Error]', error.message, 'URL:', url);
    throw error;
  }
}

// Start the app
app.listen(port, () => {
  console.log(`🚀 DeepOrbit is running on port ${port}`);
});
