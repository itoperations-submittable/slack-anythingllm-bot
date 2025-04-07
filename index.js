// index.js – Slack events with dev-only DM fix

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();

// Use environment variable or fallback to 3000
const PORT = process.env.PORT || 3000;

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  ANYTHINGLLM_API,
  ANYTHINGLLM_API_KEY,
  REDIS_URL,
  DEV_MODE,
  DEVELOPER_ID
} = process.env;

// Slack signature verification
function verifySlackRequest(req, res, buf) {
  console.log('[VERIFY] Checking Slack signature');
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  const baseString = `v0:${timestamp}:${buf}`;
  const mySig = 'v0=' + crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex');

  if (!slackSig || !crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig))) {
    console.error('[VERIFY] Invalid Slack signature');
    res.status(400).send('Invalid signature');
    throw new Error('Invalid Slack signature');
  }
}

app.use(bodyParser.json({ verify: verifySlackRequest }));
app.use('/slack/askllm', bodyParser.urlencoded({ extended: true }));

// Redis init
let redisClient;
if (DEV_MODE === 'true') {
  console.log('[REDIS] DEV_MODE: Using mock Redis');
  redisClient = {
    get: async () => null,
    set: async () => {},
    del: async () => {},
    on: () => {}
  };
} else {
  console.log('[REDIS] Connecting to real Redis:', REDIS_URL);
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', err => console.error('[REDIS] Error:', err));
  redisClient.connect().then(() => console.log('[REDIS] Connected!'));
}

// TOTALLY LLM DRIVEN
// 1) Ask LLM in 'public' which workspace is best
// 2) Chat in that chosen workspace
async function llmChooseWorkspace(question, sessionId) {
  console.log('[LLM:CHOOSE] message =>', question);
  const prompt = `I have a user question: "${question}". Which workspace from: GF Stripe, GF PayPal Checkout, Gravity Forms Core, GravityFlow, Docs, Internal Docs, GitHub, Data Provider best matches? Return only the name.`;

  try {
    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/public/chat`, {
      message: prompt,
      mode: 'chat',
      sessionId: `decide-${sessionId}`
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });
    const chosen = res.data.textResponse?.trim() || 'public';
    console.log('[LLM:CHOOSE] LLM responded =>', chosen);
    return chosen;
  } catch (err) {
    console.error('[LLM:CHOOSE] Error =>', err.message);
    return 'public';
  }
}

async function llmChat(question, workspace, sessionId) {
  console.log(`[LLM:CHAT] ${question} in workspace="${workspace}" sessionId="${sessionId}"`);

  // Basic greeting check
  const greetingChecks = ['hi','hello','hey','help','what can you do','who are you'];
  if (!question || greetingChecks.some(g => question.toLowerCase().includes(g))) {
    return `👋 Hello! I'm DeepOrbit. I can help:
- Stripe/PayPal
- Gravity Forms
- GravityFlow
- Docs/Internal Docs

Ask me anything!`;
  }

  try {
    const ep = `${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`;
    console.log('[LLM:CHAT] endpoint =>', ep);
    const res = await axios.post(ep, {
      message: question,
      mode: 'chat',
      sessionId
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });

    const textResp = res.data.textResponse || 'No response.';
    return `:satellite: *Workspace:* ${workspace}\n${textResp}`;
  } catch (err) {
    console.error('[LLM:CHAT] Axios error =>', err.message);
    return `⚠️ Failed to talk to workspace "${workspace}". Using public fallback...`;
  }
}

async function postThinking(channel, thread_ts, isDM) {
  console.log('[THINKING] Channel =>', channel, 'Thread =>', thread_ts);
  const payload = {
    channel,
    text: ':hourglass_flowing_sand: Thinking...'
  };
  if (!isDM) payload.thread_ts = thread_ts;

  try {
    const r = await axios.post('https://slack.com/api/chat.postMessage', payload, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return r.data.ts;
  } catch (err) {
    console.error('[THINKING] Error =>', err.message);
    return null;
  }
}

async function updateMessage(channel, ts, text) {
  if (!ts) return;
  console.log('[UPDATE] Replacing hourglass =>', text.slice(0, 80), '...');
  try {
    await axios.post('https://slack.com/api/chat.update', {
      channel,
      ts,
      text
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
  } catch (err) {
    console.error('[UPDATE] chat.update error =>', err.message);
  }
}

app.post('/slack/events', async (req, res) => {
  console.log('[EVENTS] Incoming event =>', JSON.stringify(req.body, null, 2));
  res.status(200).end();

  const { type, event, event_id } = req.body;
  if (!event) {
    console.log('[EVENTS] No event object');
    return;
  }
  if (event.bot_id || event.subtype === 'bot_message') {
    console.log('[EVENTS] Skipping bot message.');
    return;
  }

  // If user is not developer in DM, show dev message, skip.
  const isDM = (event.channel_type === 'im');
  if (isDM && DEVELOPER_ID && event.user !== DEVELOPER_ID) {
    console.log('[EVENTS] Non-dev user in DM => ignoring.');
    try {
      await axios.post('https://slack.com/api/chat.postMessage', {
        channel: event.channel,
        text: "🛑 I'm under development. I'm only talking to the mothership now."
      }, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
      });
    } catch (err) {
      console.error('[EVENTS] dev notice post error =>', err.message);
    }
    return;
  }

  // App home
  if (type === 'event_callback' && event.type === 'app_home_opened') {
    console.log('[APP HOME] => user', event.user);
    try {
      await axios.post('https://slack.com/api/views.publish', {
        user_id: event.user,
        view: {
          type: 'home',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Welcome to DeepOrbit app home!' } }
          ]
        }
      }, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
      });
      console.log('[APP HOME] published');
    } catch(e) {
      console.error('[APP HOME] error =>', e.message);
    }
    return;
  }

  // skip empty text
  if (!event.text) return;

  // deduplicate
  try {
    const handled = await redisClient.get(`event:${event_id}`);
    if (handled) {
      console.log('[EVENTS] Already handled event =>', event_id);
      return;
    }
    await redisClient.set(`event:${event_id}`, '1', { EX: 60 });
  } catch(e) {
    console.error('[EVENTS] deduplicate error =>', e.message);
  }

  const question = event.text.trim();
  console.log('[EVENTS] user asked =>', question);

  // Step 1) LLM choose workspace
  const chosenWorkspace = await llmChooseWorkspace(question, event.user);

  // Step 2) LLM chat on that workspace
  const finalReply = await llmChat(question, chosenWorkspace, event.user);

  // show hourglass, then replace
  const threadTs = event.thread_ts || event.ts;
  const thinkingTs = await postThinking(event.channel, threadTs, isDM);
  await updateMessage(event.channel, thinkingTs, finalReply);
});

// If you have slash command /askllm
app.post('/slack/askllm', async (req, res) => {
  console.log('[ASKLLM] => payload', JSON.stringify(req.body, null, 2));
  res.status(200).end();

  const { text, user_id, response_url } = req.body;

  if (DEVELOPER_ID && user_id !== DEVELOPER_ID) {
    console.log('[ASKLLM] Non-dev slash => ignoring');
    try {
      await axios.post(response_url, { text: "🛑 I'm under dev. Access denied." });
    } catch(e) {
      console.error('[ASKLLM] dev denial error =>', e.message);
    }
    return;
  }

  if (!text || !text.trim()) {
    await axios.post(response_url, { text: '⚠️ Provide a question please.' });
    return;
  }

  // choose workspace
  await axios.post(response_url, { text: ':hourglass_flowing_sand: Thinking...' });
  const workspace = await llmChooseWorkspace(text, user_id);
  const final = await llmChat(text, workspace, user_id);
  await axios.post(response_url, { text: final });
});

app.listen(PORT, () => {
  console.log(`[STARTUP] DeepOrbit on port ${PORT} - LLM decides workspace, dev-only DM check.`);
});
