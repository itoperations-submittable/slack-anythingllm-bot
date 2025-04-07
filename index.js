// Enhanced DeepOrbit Slack bot with deduplication, smart workspace resolution, memory, better UX, and DM support
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();

// Verify Slack request signature using signing secret
function verifySlackRequest(req, res, buf) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  const baseString = `v0:${timestamp}:${buf}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(baseString).digest('hex');

  const isValid = crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
  if (!isValid) {
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

let redisClient;

// Mock Redis in DEV_MODE, else connect to real Redis
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
  (async () => await redisClient.connect())();
}

const workspaceAliases = {
  'stripe': 'gf-stripe', 'gf stripe': 'gf-stripe',
  'paypal': 'gf-paypal-checkout', 'paypal checkout': 'gf-paypal-checkout', 'checkout': 'gf-paypal-checkout',
  'gravity': 'gravity-forms-core', 'gravity core': 'gravity-forms-core', 'gravityforms': 'gravity-forms-core', 'gravity forms': 'gravity-forms-core', 'gf core': 'gravity-forms-core',
  'flow': 'gravityflow', 'gravityflow': 'gravityflow', 'approval': 'gravityflow', 'workflow': 'gravityflow',
  'docs': 'docs', 'documentation': 'docs', 'manual': 'docs',
  'internal': 'internal-docs', 'internal docs': 'internal-docs',
  'github': 'github', 'code': 'github',
  'data': 'data-provider', 'data provider': 'data-provider', 'provider': 'data-provider', 'api': 'data-provider'
};

function toSlug(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '-');
}

function resolveWorkspaceSlug(userInput) {
  const lower = userInput.toLowerCase().trim();
  for (const [alias, slug] of Object.entries(workspaceAliases)) {
    if (lower.includes(alias)) return slug;
  }
  return toSlug(userInput);
}

async function determineWorkspace(message) {
  if (!message || !message.trim()) return 'public';
  const prompt = `User asked: "${message}". Which workspace from: GF Stripe, GF PayPal Checkout, Gravity Forms Core, GravityFlow, Docs, Internal Docs, GitHub, Data Provider best matches? Return only the name.`;

  try {
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/public/chat`, {
      message: prompt,
      mode: 'chat',
      sessionId: `routing-${Date.now()}`
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });

    const result = res.data.textResponse?.trim() || 'unknown';
    console.log(`[Decision] LLM chose: "${result}" for message: "${message}"`);
    return resolveWorkspaceSlug(result);
  } catch (error) {
    console.error('Workspace determination failed:', error);
    return 'public';
  }
}

async function postThinking(channel, thread_ts, isDM) {
  const payload = {
    channel,
    text: ':hourglass_flowing_sand: DeepOrbit is thinking...'
  };
  if (!isDM) payload.thread_ts = thread_ts;

  const res = await axios.post('https://slack.com/api/chat.postMessage', payload, {
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

async function resetWorkspace(key) {
  return await redisClient.del(`workspace:${key}`);
}

function extractSwitchIntent(text) {
  const match = text.match(/(?:switch|use|change to)\s+([a-zA-Z\s]+)/i);
  return match ? resolveWorkspaceSlug(match[1]) : null;
}

async function handleLLM(message, workspace, sessionId) {
  const normalized = message.trim().toLowerCase();
  const vague = [
    'hi', 'hello', 'hey', 'help', 'can you help', 'i need help', 'what can you do', 'who are you'
  ];
  if (!message || vague.some(q => normalized.includes(q))) {
    return `👋 Hello! I'm *DeepOrbit*. I can help you with:

•  *Stripe* or *PayPal* add-ons.
•  *Gravity Forms* Core.
•  *GravityFlow* 
•  *Docs* and *Internal docs*`
  }

  try {
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
      message,
      mode: 'chat',
      sessionId
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });
    return `💡 *Workspace*: ${workspace}

${res.data.textResponse || 'No response.'}`;
  } catch (err) {
    console.error('LLM chat error:', err);
    return '❌ There was a problem reaching the LLM. Please try again.';
  }
}

app.post('/slack/events', async (req, res) => {
  res.status(200).end();

  const { type, event, event_id } = req.body;
  if (!event || event.bot_id) return;
  if (!event.text || event.text.trim().length < 1) return;

  // Only allow developer to use the bot
  if (event.user !== DEVELOPER_ID) {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: event.channel,
      text: "🛑 I'm still booting up. For now, I only talk to my creator 👽."
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  const alreadyHandled = await redisClient.get(`event:${event_id}`);
  if (alreadyHandled) return;
  await redisClient.set(`event:${event_id}`, '1', { EX: 60 });

  const text = event.text || '';
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  const isDM = event.channel_type === 'im';
  const key = isDM ? event.user : thread_ts;

  if (text.trim().toLowerCase() === 'reset') {
    await resetWorkspace(key);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: '🧹 Workspace context has been reset. You can start fresh!'
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  if (text.trim().toLowerCase() === 'topics') {
    const helpText = `👋 I'm *DeepOrbit*. I can help you with:

•  *Stripe* or *PayPal* add-ons.
•  *Gravity Forms* Core.
•  *GravityFlow* 
•  *Docs* and *Internal docs*`;
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: helpText
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  let workspace = extractSwitchIntent(text);
  if (workspace) {
    await storeWorkspace(key, workspace);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: `🛰 Workspace switched to *${workspace}*.`
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  workspace = await fetchStoredWorkspace(key);
  const question = text.replace(/#\{[^}]+\}/, '').trim();

  if (!workspace) workspace = await determineWorkspace(question);
  await storeWorkspace(key, workspace);

  const loadingTs = await postThinking(channel, thread_ts, isDM);
  const reply = await handleLLM(question, workspace, key);
  await updateMessage(channel, loadingTs, reply);
});

app.post('/slack/askllm', async (req, res) => {
  const { text, user_id, response_url } = req.body;
  const key = user_id;

  if (user_id !== DEVELOPER_ID) {
    await axios.post(response_url, {
      text: "🤖 Access denied. Only the chosen one may speak to me... for now."
    });
    return res.status(200).end();
  }

  if (!text || text.trim().length < 1) return res.status(200).end();

  if (text.trim().toLowerCase() === 'reset') {
    await resetWorkspace(key);
    await axios.post(response_url, { text: '🧹 Workspace context has been reset. You can start fresh!' });
    return res.status(200).end();
  }

  if (text.trim().toLowerCase() === 'topics') {
    const helpText = `👋 I'm *DeepOrbit*. I can help you with:

•  *Stripe* or *PayPal* add-ons.
•  *Gravity Forms* Core.
•  *GravityFlow* 
•  *Docs* and *Internal docs*`;
    await axios.post(response_url, { text: helpText });
    return res.status(200).end();
  }

  const workspaceIntent = extractSwitchIntent(text);
  if (workspaceIntent) await storeWorkspace(key, workspaceIntent);

  let workspace = await fetchStoredWorkspace(key);
  const question = text.replace(/#\{[^}]+\}/, '').trim();
  if (!workspace) workspace = await determineWorkspace(question);
  await storeWorkspace(key, workspace);

  await axios.post(response_url, { text: ':hourglass_flowing_sand: DeepOrbit is thinking...' });
  const reply = await handleLLM(question, workspace, key);
  await axios.post(response_url, { text: reply });

  res.status(200).end();
});

app.listen(3000, () => console.log('🚀 DeepOrbit running on port 3000'));
