// DeepOrbit Slack bot with LLM-based workspace detection and Render-compatible logging
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// Slack request verification
function verifySlackRequest(req, res, buf) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  const baseString = `v0:${timestamp}:${buf}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(baseString).digest('hex');

  if (!slackSig || !crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig))) {
    res.status(400).send('Invalid signature');
    throw new Error('Invalid Slack signature');
  }
}

app.use(bodyParser.json({ verify: verifySlackRequest }));
app.use('/slack/askllm', bodyParser.urlencoded({ extended: true }));

const {
  SLACK_BOT_TOKEN,
  ANYTHINGLLM_API,
  ANYTHINGLLM_API_KEY,
  REDIS_URL,
  DEV_MODE,
  DEVELOPER_ID
} = process.env;

// Redis setup
let redisClient;
if (DEV_MODE === 'true') {
  console.log("🧪 DEV_MODE active: Redis is mocked.");
  redisClient = {
    get: async () => null,
    set: async () => {},
    del: async () => {},
    on: () => {}
  };
} else {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', err => console.error('Redis error:', err));
  redisClient.connect().then(() => console.log('✅ Redis connected!')).catch(console.error);
}

function extractSwitchIntent(text) {
  const match = text.match(/(?:switch|use|change to)\s+([a-zA-Z\s]+)/i);
  return match ? match[1].toLowerCase().trim() : null;
}

async function determineWorkspace(message) {
  const prompt = `User asked: "${message}". Which workspace from: GF Stripe, GF PayPal Checkout, Gravity Forms Core, GravityFlow, Docs, Internal Docs best matches? Return only the name.`;
  try {
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/public/chat`, {
      message: prompt,
      mode: 'chat',
      sessionId: `routing-${Date.now()}`
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });

    const result = res.data.textResponse?.trim() || 'public';
    console.log(`[Decision] LLM chose: "${result}" for message: "${message}"`);
    return result.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  } catch (err) {
    console.error("[LLM workspace detection error]", err);
    return 'public';
  }
}

async function postThinking(channel, thread_ts) {
  const res = await axios.post('https://slack.com/api/chat.postMessage', {
    channel,
    thread_ts,
    text: ':hourglass_flowing_sand: DeepOrbit is thinking...'
  }, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
  return res.data.ts;
}

async function updateMessage(channel, ts, text) {
  await axios.post('https://slack.com/api/chat.update', {
    channel,
    ts,
    text
  }, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
}

async function fetchStoredWorkspace(key) {
  return await redisClient.get(`workspace:${key}`);
}

async function storeWorkspace(key, workspace) {
  return await redisClient.set(`workspace:${key}`, workspace);
}

async function handleLLM(message, workspace, sessionId) {
  try {
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
      message,
      mode: 'chat',
      sessionId
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });
    return res.data.textResponse || 'No response.';
  } catch (err) {
    console.error(`[handleLLM] Error in workspace "${workspace}":`, err);
    return `Something went wrong while querying workspace *${workspace}*. Please try again later.`;
  }
}

app.post('/slack/events', async (req, res) => {
  const { type, event } = req.body;
  console.log('[Slack Event]', JSON.stringify(req.body));

  if (type === 'url_verification') return res.send({ challenge: req.body.challenge });
  if (!event || event.bot_id) return res.status(200).end();

  const { text = '', channel, thread_ts, user, channel_type } = event;
  const key = channel_type === 'im' ? user : thread_ts;

  // Restrict bot access during development
  if (DEVELOPER_ID && user !== DEVELOPER_ID) {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      thread_ts: thread_ts || event.ts,
      text: `🤖 Sorry, I'm still learning. Try again later!`
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return res.status(200).end();
  }

  let workspace = extractSwitchIntent(text);
  if (workspace) {
    workspace = workspace.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await storeWorkspace(key, workspace);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      thread_ts: thread_ts || event.ts,
      text: `🛰 Workspace switched to *${workspace}*.`
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return res.status(200).end();
  }

  const question = text.trim();
  workspace = await determineWorkspace(question);
  await storeWorkspace(key, workspace);

  const loadingTs = await postThinking(channel, thread_ts || event.ts);
  const reply = await handleLLM(question, workspace, key);
  await updateMessage(channel, loadingTs, `*(Workspace: ${workspace})*\n\n${reply}`);

  res.status(200).end();
});

app.post('/slack/askllm', async (req, res) => {
  const { text, user_id, channel_id, response_url } = req.body;
  const key = user_id;

  const switchIntent = extractSwitchIntent(text);
  if (switchIntent) await storeWorkspace(key, switchIntent);

  const question = text.trim();
  const workspace = await determineWorkspace(question);
  await storeWorkspace(key, workspace);

  await axios.post(response_url, { text: ':hourglass_flowing_sand: DeepOrbit is thinking...' });
  const reply = await handleLLM(question, workspace, key);
  await axios.post(response_url, { text: `*(Workspace: ${workspace})*\n\n${reply}` });

  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`🚀 DeepOrbit is live on port ${PORT}`);
});
