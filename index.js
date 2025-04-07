require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();

// Use environment variable or fallback to 3000 for local dev
const PORT = process.env.PORT || 3000;

// Slack secrets and keys
const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  ANYTHINGLLM_API,
  ANYTHINGLLM_API_KEY,
  REDIS_URL,
  DEV_MODE,
  DEVELOPER_ID, // optional: lock DMs to a single user
} = process.env;

// 1. Slack signature check
function verifySlackRequest(req, res, buf) {
  console.log('[VERIFY] Checking Slack signature...');
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  const baseString = `v0:${timestamp}:${buf}`;
  const mySig = 'v0=' + crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex');

  // Log for debug (do NOT log in production if secret is critical)
  console.log('[VERIFY] Generated signature:', mySig);
  console.log('[VERIFY] Slack signature:', slackSig);

  if (!slackSig || !crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig))) {
    console.error('[VERIFY] Invalid Slack signature');
    res.status(400).send('Invalid signature');
    throw new Error('Invalid Slack signature');
  }
}

app.use(bodyParser.json({ verify: verifySlackRequest }));
app.use('/slack/askllm', bodyParser.urlencoded({ extended: true }));

// 2. Initialize Redis client
let redisClient;
if (DEV_MODE === 'true') {
  console.log('[REDIS] DEV_MODE active: using mocked Redis');
  redisClient = {
    get: async () => null,
    set: async () => {},
    del: async () => {},
    on: () => {}
  };
} else {
  console.log('[REDIS] Connecting to real Redis at:', REDIS_URL);
  redisClient = createClient({
    url: REDIS_URL
  });
  redisClient.on('error', (err) => console.error('[REDIS] Error:', err));
  redisClient.connect().then(() => console.log('[REDIS] Connected!'));
}

// 3. Workspace detection: aliasing
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

// 4. Let LLM decide in fallback scenario
async function determineWorkspace(message) {
  if (!message || !message.trim()) {
    console.log('[DETERMINE] No message text, defaulting to public workspace');
    return 'public';
  }
  console.log('[DETERMINE] Deciding workspace for message:', message);

  try {
    const prompt = `User asked: \"${message}\". Which workspace from: GF Stripe, GF PayPal Checkout, Gravity Forms Core, GravityFlow, Docs, Internal Docs, GitHub, Data Provider best matches? Return only the name.`;
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/public/chat`, {
      message: prompt,
      mode: 'chat',
      sessionId: `routing-${Date.now()}`
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });

    const chosen = res.data.textResponse?.trim() || 'public';
    console.log(`[DETERMINE] LLM chose: "${chosen}"`);
    return resolveWorkspaceSlug(chosen);
  } catch (err) {
    console.error('[DETERMINE] Error calling LLM workspace decision:', err.message);
    return 'public';
  }
}

function resolveWorkspaceSlug(input) {
  if (!input) return 'public';
  const lower = input.toLowerCase();
  for (const [alias, slug] of Object.entries(workspaceAliases)) {
    if (lower.includes(alias)) {
      console.log(`[RESOLVE] Found alias match: "${alias}" => "${slug}"`);
      return slug;
    }
  }
  const fallback = toSlug(input);
  console.log(`[RESOLVE] No alias match, slug fallback => "${fallback}"`);
  return fallback;
}

// 5. Actually call LLM
async function handleLLM(message, workspace, sessionId) {
  console.log(`[LLM] Handling message with workspace="${workspace}" sessionId="${sessionId}" text="${message}"`);

  // Basic greeting check
  const normalized = message.trim().toLowerCase();
  const vague = ['hi', 'hello', 'hey', 'help', 'can you help', 'i need help', 'what can you do', 'who are you'];
  if (!message || vague.some(q => normalized.includes(q))) {
    return `👋 Hello! I'm *DeepOrbit*. I can help you with:\n\n•  *Stripe* or *PayPal* add-ons.\n•  *Gravity Forms* Core.\n•  *GravityFlow*\n•  *Docs* and *Internal docs*\n\nTry \`use gravityflow\` or ask me a question!`;
  }

  try {
    const endpoint = `${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`;
    console.log('[LLM] Calling LLM endpoint:', endpoint);
    const res = await axios.post(endpoint, {
      message,
      mode: 'chat',
      sessionId
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });

    const textResponse = res.data.textResponse || 'No response.';
    console.log(`[LLM] LLM responded: "${textResponse.slice(0, 80)}..."`);
    return `🛰 *Workspace: ${workspace}*\n${textResponse}`;
  } catch (err) {
    console.error(`[LLM] Error from LLM workspace "${workspace}":`, err.message);
    return `⚠️ Something went wrong with workspace *${workspace}*. Please try again or switch.`;
  }
}

// 6. Post a "thinking" message
async function postThinking(channel, thread_ts, isDM) {
  console.log('[THINKING] Posting hourglass in channel:', channel, 'thread:', thread_ts);
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
    console.error('[THINKING] Error posting hourglass:', err.message);
    return null;
  }
}

// 7. Update the "thinking" message
async function updateMessage(channel, ts, text) {
  console.log('[UPDATE] Replacing hourglass with final text');
  if (!ts) return; // If we failed to post thinking, skip
  try {
    await axios.post('https://slack.com/api/chat.update', {
      channel,
      ts,
      text
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
  } catch (err) {
    console.error('[UPDATE] Error updating message:', err.message);
  }
}

// 8. Simple alias to get from Redis
async function fetchStoredWorkspace(key) {
  console.log('[REDIS] fetchStoredWorkspace =>', key);
  try {
    return await redisClient.get(`workspace:${key}`);
  } catch (err) {
    console.error('[REDIS] fetch error:', err.message);
    return null;
  }
}

// 9. Store to Redis
async function storeWorkspace(key, workspace) {
  console.log('[REDIS] storeWorkspace =>', key, '=>', workspace);
  try {
    return await redisClient.set(`workspace:${key}`, workspace);
  } catch (err) {
    console.error('[REDIS] store error:', err.message);
  }
}

// 10. Reset Redis key
async function resetWorkspace(key) {
  console.log('[REDIS] resetWorkspace =>', key);
  try {
    return await redisClient.del(`workspace:${key}`);
  } catch (err) {
    console.error('[REDIS] delete error:', err.message);
  }
}

// 11. Switch intent
function extractSwitchIntent(text) {
  console.log('[SWITCH] Checking for switch intent in text:', text);
  const match = text.match(/(?:switch|use|change to)\s+([a-zA-Z\s]+)/i);
  if (match) {
    console.log('[SWITCH] Found phrase =>', match[1]);
    return resolveWorkspaceSlug(match[1]);
  }
  return null;
}

// 12. Slack events route
app.post('/slack/events', async (req, res) => {
  console.log('[EVENTS] Slack event payload =>', JSON.stringify(req.body, null, 2));
  res.status(200).end(); // respond immediately to Slack

  const { type, event, event_id } = req.body;
  if (!event || event.bot_id) {
    console.log('[EVENTS] Skipping because event is missing or from a bot');
    return;
  }

  // Log user text quickly
  console.log('[EVENTS] Received text =>', event.text);

  // If there's a home tab event
  if (type === 'event_callback' && event.type === 'app_home_opened') {
    console.log('[APP HOME] user =>', event.user);
    try {
      await axios.post('https://slack.com/api/views.publish', {
        user_id: event.user,
        view: {
          type: 'home',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '*👋 Welcome to DeepOrbit!* I can help you with:' }
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '•  *Stripe* or *PayPal* add-ons.\n•  *Gravity Forms* Core.\n•  *GravityFlow*\n•  *Docs* and *Internal docs*' }
            }
          ]
        }
      }, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
      });
      console.log('[APP HOME] Published!');
    } catch (err) {
      console.error('[APP HOME] Error publishing:', err.message);
    }
    return;
  }

  if (!event.text || event.text.trim().length < 1) {
    console.log('[EVENTS] No text found, ignoring');
    return;
  }

  // Deduplicate
  try {
    const alreadyHandled = await redisClient.get(`event:${event_id}`);
    if (alreadyHandled) {
      console.log('[EVENTS] Duplicate event, skipping');
      return;
    }
    await redisClient.set(`event:${event_id}`, '1', { EX: 60 });
  } catch (err) {
    console.error('[EVENTS] Error deduplicating event:', err.message);
  }

  // Developer only in DMs
  const isDM = event.channel_type === 'im';
  const key = isDM ? event.user : event.thread_ts || event.ts;
  if (isDM && DEVELOPER_ID && event.user !== DEVELOPER_ID) {
    console.log('[EVENTS] Non-developer tried in DM => ignoring');
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: event.channel,
      text: "🛑 I'm under dev mode. Please wait or contact the developer."
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
    return;
  }

  // handle commands
  if (event.text.toLowerCase() === 'reset') {
    console.log('[EVENTS] Reset workspace command');
    await resetWorkspace(key);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: event.channel,
      text: '🧹 Workspace context reset.'
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
    return;
  }

  const workspaceIntent = extractSwitchIntent(event.text);
  if (workspaceIntent) {
    console.log('[EVENTS] user wants to switch workspace =>', workspaceIntent);
    await storeWorkspace(key, workspaceIntent);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: event.channel,
      text: `🛰 Workspace switched to *${workspaceIntent}*.`
    }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
    return;
  }

  let workspace = await fetchStoredWorkspace(key);
  const question = event.text.replace(/#\{[^}]+\}/, '').trim();

  if (!workspace) {
    console.log('[EVENTS] No workspace stored, asking LLM to choose => question:', question);
    workspace = await determineWorkspace(question);
    await storeWorkspace(key, workspace);
  }

  // Post thinking, then update
  const thinkingTs = await postThinking(event.channel, event.thread_ts || event.ts, isDM);
  const finalReply = await handleLLM(question, workspace, key);
  await updateMessage(event.channel, thinkingTs, finalReply);
});

// 13. For Render to detect your web service is running
app.listen(PORT, () => {
  console.log(`[STARTUP] DeepOrbit is live on port ${PORT}`);
});
