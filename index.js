// Enhanced DeepOrbit Slack bot with deduplication, smart workspace resolution, memory, better UX, and DM support
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();

// Middleware to verify Slack request authenticity using the signing secret
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
  DEVELOPER_ID // optional: only allow replies to this user
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
  redisClient = createClient({
    url: REDIS_URL,
    socket: {
      tls: true,
      reconnectStrategy: retries => Math.min(retries * 50, 2000)
    }
  });
  redisClient.on('error', err => console.error('Redis error:', err));
  redisClient.on('connect', () => console.log('Redis connected!'));
  redisClient.on('reconnecting', () => console.log('Redis reconnecting...'));
  redisClient.on('end', () => console.log('Redis connection ended'));
  (async () => await redisClient.connect())();
}

// Workspace keyword mapping
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
  } catch (err) {
    console.error("Error determining workspace:", err.message);
    return 'public';
  }
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
•  *Docs* and *Internal docs*`;
  }

  try {
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
      message,
      mode: 'chat',
      sessionId
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });

    if (res.data.textResponse) {
      return `🛰 *Workspace*: ${workspace}
${res.data.textResponse}`;
    }
    return 'No response.';
  } catch (err) {
    console.error("Error from LLM:", err.message);
    return `❌ Error: Workspace *${workspace}* may be invalid. Try again or switch.`;
  }
}

// Other parts of the code (like /slack/events and /slack/askllm) stay unchanged unless you want them updated now too.
