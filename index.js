// Enhanced DeepOrbit Slack bot using Upstash REST Redis API, smart workspace resolution, deduplication, and UX improvements
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();

// Slack signature validation middleware
function verifySlackRequest(req, res, buf) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];

  if (!timestamp || !slackSig) {
    console.error('⚠️ Missing Slack signature headers');
    res.status(400).send('Bad Request: Missing headers');
    return;
  }

  const baseString = `v0:${timestamp}:${buf}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex');

  const sigA = Buffer.from(mySig);
  const sigB = Buffer.from(slackSig);

  if (sigA.length !== sigB.length) {
    console.error('❌ Signature length mismatch');
    res.status(400).send('Bad Request: Signature mismatch');
    return;
  }

  const isValid = crypto.timingSafeEqual(sigA, sigB);
  if (!isValid) {
    console.error('❌ Invalid Slack signature');
    res.status(400).send('Invalid signature');
    return;
  }
}

app.use(bodyParser.json({ verify: verifySlackRequest }));
app.use('/slack/askllm', bodyParser.urlencoded({ extended: true }));

const {
  SLACK_BOT_TOKEN,
  ANYTHINGLLM_API,
  ANYTHINGLLM_API_KEY,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN
} = process.env;

// Redis client using Upstash REST API
const redis = {
  async get(key) {
    const res = await axios.get(`${UPSTASH_REDIS_REST_URL}/get/${key}`, {
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`
      }
    });
    return res.data.result;
  },
  async set(key, value) {
    await axios.get(`${UPSTASH_REDIS_REST_URL}/set/${key}/${value}`, {
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`
      }
    });
  },
  async del(key) {
    await axios.get(`${UPSTASH_REDIS_REST_URL}/del/${key}`, {
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`
      }
    });
  }
};

// Aliases to resolve workspace names to slugs
const workspaceAliases = {
  'stripe': 'gf-stripe', 'gf stripe': 'gf-stripe',
  'paypal': 'gf-paypal-checkout', 'paypal checkout': 'gf-paypal-checkout', 'checkout': 'gf-paypal-checkout',
  'gravity': 'gravityforms-core', 'gravity core': 'gravityforms-core', 'gravityforms': 'gravityforms-core', 'gravity forms': 'gravityforms-core', 'gf core': 'gravityforms-core',
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

function extractSwitchIntent(text) {
  const match = text.match(/(?:switch|use|change to)\s+([a-zA-Z\s]+)/i);
  return match ? resolveWorkspaceSlug(match[1]) : null;
}

async function handleLLM(message, workspace, sessionId) {
  const normalized = message.trim().toLowerCase();
  const vague = ['hi', 'hello', 'hey', 'help', 'can you help', 'i need help', 'what can you do', 'who are you'];
  if (!message || vague.some(q => normalized.includes(q))) {
    return `👋 Hello! I'm *DeepOrbit*. I can help you with:

• 💳 *Stripe* or *PayPal* add-ons
• 🧰 *Gravity Forms* features, entries, and data generation
• 🔄 *GravityFlow* workflows and approvals
• 📚 *Docs* and internal documentation

You can say: \`use docs\`, \`switch to gravityflow\`, or just ask a question!`;
  }
  const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
    message,
    mode: 'chat',
    sessionId
  }, {
    headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
  });
  return res.data.textResponse || 'No response.';
}

app.post('/slack/events', async (req, res) => {
  res.status(200).end();
  const { type, event, event_id } = req.body;
  if (!event || event.bot_id || !event.text?.trim()) return;

  const alreadyHandled = await redis.get(`event:${event_id}`);
  if (alreadyHandled) return;
  await redis.set(`event:${event_id}`, '1');

  const text = event.text;
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  const isDM = event.channel_type === 'im';
  const key = isDM ? event.user : thread_ts;

  if (text.toLowerCase() === 'reset') {
    await redis.del(`workspace:${key}`);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: '🧹 Workspace context has been reset. You can start fresh!'
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  if (text.toLowerCase() === 'topics') {
    const helpText = `👋 I'm *DeepOrbit*. I can help you with:

• 💳 *Stripe* or *PayPal* add-ons
• 🧰 *Gravity Forms* features, entries, and data generation
• 🔄 *GravityFlow* workflows and approvals
• 📚 *Docs* and internal documentation`;
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
    await redis.set(`workspace:${key}`, workspace);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: `🛰 Workspace switched to *${workspace}*.`
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  workspace = await redis.get(`workspace:${key}`);
  const question = text.replace(/#\{[^}]+\}/, '').trim();
  if (!workspace) workspace = await determineWorkspace(question);
  await redis.set(`workspace:${key}`, workspace);

  const loadingTs = await postThinking(channel, thread_ts, isDM);
  const reply = await handleLLM(question, workspace, key);
  await updateMessage(channel, loadingTs, `🛰 *Workspace: ${workspace}*

${reply}`);
});

app.post('/slack/askllm', async (req, res) => {
  const { text, user_id, response_url } = req.body;
  const key = user_id;
  if (!text?.trim()) return res.status(200).end();

  if (text.trim().toLowerCase() === 'reset') {
    await redis.del(`workspace:${key}`);
    await axios.post(response_url, { text: '🧹 Workspace context has been reset. You can start fresh!' });
    return res.status(200).end();
  }

  if (text.trim().toLowerCase() === 'topics') {
    const helpText = `👋 I'm *DeepOrbit*. I can help you with:

• 💳 *Stripe* or *PayPal* add-ons
• 🧰 *Gravity Forms* features, entries, and data generation
• 🔄 *GravityFlow* workflows and approvals
• 📚 *Docs* and internal documentation`;
    await axios.post(response_url, { text: helpText });
    return res.status(200).end();
  }

  const intent = extractSwitchIntent(text);
  if (intent) await redis.set(`workspace:${key}`, intent);

  let workspace = await redis.get(`workspace:${key}`);
  const question = text.replace(/#\{[^}]+\}/, '').trim();
  if (!workspace) workspace = await determineWorkspace(question);
  await redis.set(`workspace:${key}`, workspace);

  if (response_url && typeof response_url === 'string' && response_url.startsWith('http')) {
    console.log('📡 Posting thinking message to response_url');
    await axios.post(response_url, { text: ':hourglass_flowing_sand: DeepOrbit is thinking...' });
}
  const reply = await handleLLM(question, workspace, key);
  if (response_url && typeof response_url === 'string' && response_url.startsWith('http')) {
    console.log('📬 Posting LLM reply to response_url');
    await axios.post(response_url, { text: `🛰 *Workspace: ${workspace}*

${reply}` });
}
  res.status(200).end();
});

app.listen(3000, () => console.log('🚀 DeepOrbit running on port 3000'));
