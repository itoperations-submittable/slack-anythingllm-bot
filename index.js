require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('redis');

const app = express();
app.use(bodyParser.json());

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  ANYTHINGLLM_API,
  ANYTHINGLLM_API_KEY,
  REDIS_URL
} = process.env;

const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', err => console.error('Redis Client Error', err));
(async () => await redisClient.connect())();

function verifySlackRequest(req, res, buf) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];
  const baseString = `v0:${timestamp}:${buf}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseString).digest('hex');

  const isValid = crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
  if (!isValid) {
    res.status(400).send('Invalid signature');
    throw new Error('Invalid Slack signature');
  }
}
app.use(bodyParser.json({ verify: verifySlackRequest }));

async function determineWorkspaceFromGeneral(message) {
  const prompt = `I have a user question: "${message}". Based on the available workspaces: GF Stripe, GF PayPal Checkout, gravityforms core, gravityflow, docs, internal docs, github, data provider — which workspace is the best match for this question? Just return the exact name of the best matching workspace.`;

  const res = await axios.post(`${ANYTHINGLLM_API}/query`, {
    message: prompt,
    workspace: 'general'
  }, {
    headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
  });

  return res.data.response.trim();
}

app.post('/slack/events', async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === 'url_verification') return res.send({ challenge });

  if (event && event.type === 'app_mention') {
    let text = event.text;
    const channel = event.channel;
    const thread_ts = event.thread_ts || event.ts;
    const redisKey = `thread:${thread_ts}`;

    const workspaceMatch = text.match(/#\{([^}]+)\}/);
    let workspace = workspaceMatch ? workspaceMatch[1] : null;
    text = text.replace(/#\{[^}]+\}/, '').trim();

    if (!workspace) {
      try {
        workspace = await determineWorkspaceFromGeneral(text);
      } catch (err) {
        console.error('Error determining workspace:', err);
        return res.status(500).send('Failed to determine workspace');
      }
    }

    const existingThreadId = await redisClient.get(redisKey);

    try {
      const llmRes = await axios.post(`${ANYTHINGLLM_API}/query`, {
        message: text,
        workspace,
        threadId: existingThreadId || null
      }, {
        headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
      });

      const reply = llmRes.data.response || 'No response.';
      const threadId = llmRes.data.threadId;

      if (!existingThreadId && threadId) {
        await redisClient.set(redisKey, threadId);
      }

      await axios.post('https://slack.com/api/chat.postMessage', {
        channel,
        text: reply,
        thread_ts
      }, {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

    } catch (err) {
      console.error('Error handling LLM query:', err.response?.data || err.message);
    }
  }

  res.status(200).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Slack LLM bot is running on port ${PORT}`);
});
