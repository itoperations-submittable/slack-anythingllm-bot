// index.js
import express from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const redisUrl = process.env.REDIS_URL;
const anythingLLMBaseURL = process.env.LLM_URL;
const anythingLLMApiKey = process.env.LLM_API_KEY;
const developerId = process.env.DEVELOPER_ID;

let validWorkspaces = [ 'public' ];

// Middleware to verify Slack request
function verifySlackRequest(req, res, buf) {
  const slackSignature = req.headers['x-slack-signature'];
  const requestTimestamp = req.headers['x-slack-request-timestamp'];
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
  const [version, hash] = slackSignature.split('=');
  hmac.update(`${version}:${requestTimestamp}:${buf.toString()}`);
  const digest = hmac.digest('hex');
  if (digest !== hash) {
    throw new Error('Invalid Slack signature');
  }
}

app.use(bodyParser.json({ verify: verifySlackRequest }));

// Connect to Redis
const redis = createClient({ url: redisUrl });
redis.on('error', (err) => console.error('Redis error:', err));
redis.connect().then(() => console.log('Redis connected!'));

// Load workspaces from AnythingLLM
async function fetchWorkspaces() {
  try {
    const res = await axios.get(`${anythingLLMBaseURL}/v1/workspaces`, {
      headers: { Authorization: `Bearer ${anythingLLMApiKey}` }
    });
    validWorkspaces = res.data.map(w => w.slug);
    console.log('[BOOT] Valid workspaces loaded:', validWorkspaces);
  } catch (err) {
    console.error('[BOOT] Failed to fetch workspaces:', err.message);
  }
}

await fetchWorkspaces();

// Slack event endpoint
app.post('/slack/events', async (req, res) => {
  const event = req.body.event;
  const userId = event?.user;
  const channelId = event?.channel;
  const text = event?.text;
  const isDM = req.body.event?.channel_type === 'im';

  // Avoid bot loops
  if (event.bot_id) return res.sendStatus(200);

  // Developer-only gate (DM only)
  if (isDM && userId !== developerId) {
    await postToSlack(channelId, `:hourglass_flowing_sand: I'm under development. Please wait for the developer to open me up!`);
    console.log('[EVENT] Non-developer DM => ignoring');
    return res.sendStatus(200);
  }

  // Retrieve user's last workspace from Redis
  let workspace = await redis.get(`user:${userId}:workspace`) || 'public';

  // Send to LLM
  try {
    const response = await axios.post(`${anythingLLMBaseURL}/api/v1/workspace/${workspace}/chat`, {
      message: text,
      mode: 'chat',
      sessionId: userId
    }, {
      headers: {
        Authorization: `Bearer ${anythingLLMApiKey}`,
        'Content-Type': 'application/json'
      }
    });
    const reply = response.data.textResponse || '...';
    await postToSlack(channelId, reply);
  } catch (err) {
    console.error(`[LLM ERROR] Failed to talk to workspace "${workspace}":`, err.message);
    await postToSlack(channelId, `:warning: Failed to talk to workspace "${workspace}". Using public fallback...`);
    try {
      const fallback = await axios.post(`${anythingLLMBaseURL}/api/v1/workspace/public/chat`, {
        message: text,
        mode: 'chat',
        sessionId: userId
      }, {
        headers: { Authorization: `Bearer ${anythingLLMApiKey}` }
      });
      await postToSlack(channelId, fallback.data.textResponse || '...');
    } catch (err2) {
      console.error('[FALLBACK ERROR]', err2.message);
      await postToSlack(channelId, ':boom: I am having trouble reaching the LLM. Please try again later.');
    }
  }

  res.sendStatus(200);
});

async function postToSlack(channel, text) {
  try {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text
    }, {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('[SLACK ERROR]', err.message);
  }
}

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
