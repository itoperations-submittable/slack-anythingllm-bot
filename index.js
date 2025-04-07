// Enhanced DeepOrbit Slack bot with deduplication, smart workspace resolution, memory, better UX, and DM support
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();

function verifySlackRequest(req, res, buf) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  const baseString = `v0:${timestamp}:${buf}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(baseString).digest('hex');

  const isValid = slackSig && crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
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
  DEV_MODE
} = process.env;

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

const knownWorkspaces = new Set(Object.values(workspaceAliases).concat(['public']));

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

function isValidWorkspace(workspace) {
  return knownWorkspaces.has(workspace);
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
    const resolved = resolveWorkspaceSlug(result);
    return isValidWorkspace(resolved) ? resolved : 'public';
  } catch (error) {
    console.error('[determineWorkspace] Error:', error);
    return 'public';
  }
}

async function postThinking(channel, thread_ts, isDM) {
  const payload = {
    channel,
    text: ':hourglass_flowing_sand: DeepOrbit is thinking...'
  };
  if (!isDM) payload.thread_ts = thread_ts;

  try {
    const res = await axios.post('https://slack.com/api/chat.postMessage', payload, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return res.data.ts;
  } catch (err) {
    console.error('[postThinking] Error:', err);
    return null;
  }
}

async function updateMessage(channel, ts, text) {
  try {
    await axios.post('https://slack.com/api/chat.update', {
      channel,
      ts,
      text
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
  } catch (err) {
    console.error('[updateMessage] Error:', err);
  }
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

• 💳 *Stripe* or *PayPal* add-ons
• 🧰 *Gravity Forms* features, entries, and data generation
• 🔄 *GravityFlow* workflows and approvals
• 📚 *Docs* and internal documentation

You can say: \`use docs\`, \`switch to gravityflow\`, or just ask a question!`;
  }

  try {
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
      message,
      mode: 'chat',
      sessionId
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });
    return `🛰 *(Workspace: ${workspace})*\n\n${res.data.textResponse || 'No response.'}`;
  } catch (err) {
    console.error('[handleLLM] Error:', err);
    return `⚠️ Something went wrong while querying the workspace *${workspace}*. Falling back to *public*.`;
  }
}

// Server listener
app.listen(3000, () => console.log('🚀 DeepOrbit running on port 3000'));
