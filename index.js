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
  DEVELOPER_ID,
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
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  redisClient.connect().then(() => console.log('Redis connected!'));
}

// 3. Let LLM decide the workspace
// Step 1: ask LLM in 'public' about which workspace is best
// Step 2: call that workspace
async function llmChooseWorkspace(question, sessionId) {
  console.log('[WORKSPACE-DECIDE] Asking LLM for best workspace');
  try {
    const prompt = `I have a user question: "${question}". Based on the available workspaces: GF Stripe, GF PayPal Checkout, Gravity Forms Core, GravityFlow, Docs, Internal Docs, GitHub, Data Provider, which is the best workspace name? Return only that workspace name, no explanations.`;

    const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/public/chat`, {
      message: prompt,
      mode: 'chat',
      sessionId: `decide-${sessionId}`
    }, {
      headers: {
        Authorization: `Bearer ${ANYTHINGLLM_API_KEY}`
      }
    });

    const chosen = res.data.textResponse?.trim() || 'public';
    console.log(`[WORKSPACE-DECIDE] LLM chose => "${chosen}"`);
    return chosen;
  } catch (err) {
    console.error('[WORKSPACE-DECIDE] Error:', err.message);
    return 'public';
  }
}

// Once we have workspace from LLM, we do an actual chat there
async function llmChat(question, workspace, sessionId) {
  console.log(`[LLM-CHAT] Chat with workspace="${workspace}" sessionId="${sessionId}" text="${question}"`);
  const vague = ['hi','hello','hey','help','what can you do','who are you'];
  if (!question || vague.some(v => question.toLowerCase().includes(v))) {
    return `👋 Hello! I'm DeepOrbit. I can help you with:\n- Stripe or PayPal\n- Gravity Forms\n- GravityFlow\n- Docs / Internal Docs\n\nAsk me anything.`;
  }

  try {
    const endpoint = `${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`;
    console.log('[LLM-CHAT] endpoint =>', endpoint);
    const chatRes = await axios.post(endpoint, {
      message: question,
      mode: 'chat',
      sessionId
    }, {
      headers: {
        Authorization: `Bearer ${ANYTHINGLLM_API_KEY}`
      }
    });
    const textResponse = chatRes.data.textResponse || 'No response.';
    return `🛰 *Workspace: ${workspace}*\n${textResponse}`;
  } catch (err) {
    console.error(`[LLM-CHAT] Error calling workspace="${workspace}":`, err.message);
    return `⚠️ Error in workspace "${workspace}". Using public fallback.`;
  }
}

// show hourglass
async function postThinking(channel, thread_ts, isDM) {
  console.log('[THINKING] Channel:', channel, 'Thread:', thread_ts);
  const msg = {
    channel,
    text: ':hourglass_flowing_sand: DeepOrbit is thinking...'
  };
  if (!isDM) msg.thread_ts = thread_ts;

  try {
    const r = await axios.post('https://slack.com/api/chat.postMessage', msg, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return r.data.ts;
  } catch (err) {
    console.error('[THINKING] Post error:', err.message);
    return null;
  }
}

// update hourglass
async function updateMessage(channel, ts, text) {
  if (!ts) return;
  console.log('[UPDATE] Final text =>', text.slice(0,80)+'...');
  try {
    await axios.post('https://slack.com/api/chat.update', {
      channel,
      ts,
      text
    },{
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
  } catch (err) {
    console.error('[UPDATE] Error updating message:', err.message);
  }
}

// Slack /slack/events route
app.post('/slack/events', async (req, res) => {
  console.log('[EVENT] Slack event =>', JSON.stringify(req.body, null, 2));
  res.status(200).end();

  const { type, event, event_id } = req.body;
  if (!event) return;

  // app_home
  if (type === 'event_callback' && event.type === 'app_home_opened') {
    console.log('[APP HOME] user =>', event.user);
    try {
      await axios.post('https://slack.com/api/views.publish', {
        user_id: event.user,
        view: {
          type: 'home',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: '*Welcome to DeepOrbit!* I can help with:' } },
            { type: 'section', text: { type: 'mrkdwn', text: '- Stripe or PayPal\n- Gravity Forms\n- GravityFlow\n- Docs / Internal Docs' } }
          ]
        }
      }, {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`
        }
      });
      console.log('[APP HOME] published');
    } catch(e) {
      console.error('[APP HOME] error =>', e.message);
    }
    return;
  }

  // ignore if no text
  if (!event.text) return;

  // developer-only in DM?
  const isDM = event.channel_type === 'im';
  if (DEVELOPER_ID && isDM && event.user !== DEVELOPER_ID) {
    console.log('[EVENT] Non-developer DM => ignoring');
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: event.channel,
      text: "⏳ I'm under development. Please wait for the developer to open me up!"
    },{
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  // deduplicate
  try {
    const stored = await redisClient.get(`event:${event_id}`);
    if (stored) {
      console.log('[EVENT] Already handled, skipping');
      return;
    }
    await redisClient.set(`event:${event_id}`, '1', { EX: 60 });
  } catch(e) {
    console.error('[EVENT] deduplicate error =>', e.message);
  }

  const text = event.text.trim();
  console.log('[EVENT] Received =>', text);

  // reset
  if (text.toLowerCase() === 'reset') {
    console.log('[EVENT] reset command');
    await redisClient.del(`workspace:${event.user}`);
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: event.channel,
      text: '🧹 Workspace reset. LLM will pick again next time.'
    },{
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    return;
  }

  const question = text;
  console.log('[EVENT] question =>', question);

  // 1) LLM picks workspace
  const workspace = await llmChooseWorkspace(question, event.user);
  // 2) chat in that workspace
  const chatReply = await llmChat(question, workspace, event.user);

  // show hourglass, then final
  const threadTs = event.thread_ts || event.ts;
  const thinkingTs = await postThinking(event.channel, threadTs, isDM);
  await updateMessage(event.channel, thinkingTs, chatReply);
});

// Slash command
app.post('/slack/askllm', async (req, res) => {
  console.log('[ASKLLM] payload =>', JSON.stringify(req.body, null, 2));
  const { text, user_id, response_url } = req.body;
  res.status(200).end();

  if (DEVELOPER_ID && user_id !== DEVELOPER_ID) {
    console.log('[ASKLLM] Non-developer slash => ignoring');
    await axios.post(response_url, {
      text: "⏳ I'm in dev mode. Access denied for non-developer."
    });
    return;
  }

  if (!text || !text.trim()) {
    await axios.post(response_url, { text: "⚠️ Provide a question." });
    return;
  }

  // pick workspace
  const chosenWksp = await llmChooseWorkspace(text, user_id);
  // then chat
  await axios.post(response_url, { text: ":hourglass_flowing_sand: Thinking..." });
  const final = await llmChat(text, chosenWksp, user_id);
  await axios.post(response_url, { text: final });
});

app.listen(PORT, () => {
  console.log(`🚀 DeepOrbit fully LLM-driven, listening on port ${PORT}`);
});
