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

  const isValid = crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
  if (!isValid) {
    res.status(400).send('Invalid signature');
    throw new Error('Invalid Slack signature');
  }
}

app.use(bodyParser.json({ verify: verifySlackRequest }));

const {
  SLACK_BOT_TOKEN,
  ANYTHINGLLM_API,
  ANYTHINGLLM_API_KEY,
  REDIS_URL
} = process.env;

const redisClient = createClient({ url: REDIS_URL });
redisClient.on('error', err => console.error('Redis Client Error', err));
(async () => await redisClient.connect())();

async function determineWorkspaceFromPublic(message) {
  const prompt = `I have a user question: "${message.trim()}". Based on the available workspaces: GF Stripe, GF PayPal Checkout, gravityforms core, gravityflow, docs, internal docs, github, data provider — which workspace is the best match for this question? Just return the exact name of the best matching workspace.`;

  const res = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/public/chat`, {
    message: prompt,
    mode: "chat",
    sessionId: "routing-" + Date.now()
  }, {
    headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
  });

  const result = res.data.textResponse?.trim() || 'unknown';

  const logKey = `log:${Date.now()}`;
  await redisClient.set(logKey, JSON.stringify({ original: message, decided: result, ts: Date.now() }));
  console.log(`[DeepOrbit] Workspace decision: "${result}" for message: "${message}"`);

  return result;
}

async function sendIntroMessage(channel, thread_ts) {
  const introKey = `intro:${thread_ts}`;
  const alreadySeen = await redisClient.get(introKey);
  if (!alreadySeen) {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text: '🛰 Hello. I’m *DeepOrbit*. Tag me with your question or use `/askllm`.\nAdd `#{workspace}` to guide me.',
      thread_ts
    }, {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    await redisClient.set(introKey, 'true');
  }
}

app.post('/slack/events', async (req, res) => {
  console.log("📥 Received Slack event:", JSON.stringify(req.body, null, 2));
  const { type, challenge, event } = req.body;

  if (event) {
    console.log("🛰️ Unhandled event received:", JSON.stringify(event, null, 2));
  }

  if (type === 'url_verification') {
    console.log("✅ URL verification challenge received.");
    return res.send({ challenge });
  }

  if (event && event.type === 'app_home_opened') {
    console.log("🏠 App Home opened by user:", event.user);

    try {
      await axios.post('https://slack.com/api/views.publish', {
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: "🚀 Welcome to DeepOrbit",
                emoji: true
              }
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "I'm here to help you navigate the knowledge space.\n\n• Tag me with `@DeepOrbit`\n• Use `/askllm`\n• Add `#{workspace}` to guide me"
              }
            },
            {
              type: "divider"
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "_Built with AnythingLLM. Powered by your data._"
                }
              ]
            }
          ]
        }
      }, {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });

      console.log("✅ App Home view published.");
    } catch (err) {
      console.error("❌ Failed to publish App Home view:", err.response?.data || err.message);
    }

    return res.status(200).end();
  }

  if (event && event.type === 'app_mention') {
    console.log("📌 app_mention received:", event);

    let text = event.text;
    const channel = event.channel;
    const thread_ts = event.thread_ts || event.ts;
    const redisKey = `thread:${thread_ts}`;

    const workspaceMatch = text.match(/#\{([^}]+)\}/);
    let workspace = workspaceMatch ? workspaceMatch[1] : null;
    text = text.replace(/#\{[^}]+\}/, '').trim();

    if (!workspace) {
      try {
        workspace = await determineWorkspaceFromPublic(text);
      } catch (err) {
        console.error('Error determining workspace:', err);
        return res.status(500).send('Failed to determine workspace');
      }
    }

    try {
      const llmRes = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
        message: text,
        mode: "chat",
        sessionId: thread_ts
      }, {
        headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
      });

      const reply = llmRes.data.textResponse || 'No response.';
      await sendIntroMessage(channel, thread_ts);

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

app.post('/slack/askllm', async (req, res) => {
  const { text, user_id, channel_id, response_url } = req.body;
  res.status(200).send("⏳ DeepOrbit is thinking...");

  try {
    let question = text || '';
    const workspaceMatch = question.match(/#\{([^}]+)\}/);
    let workspace = workspaceMatch ? workspaceMatch[1] : null;
    question = question.replace(/#\{[^}]+\}/, '').trim();

    if (!workspace) {
      try {
        workspace = await determineWorkspaceFromPublic(question);
      } catch (err) {
        console.error('Error determining workspace (slash command):', err);
        await axios.post(response_url, {
          response_type: "ephemeral",
          text: "⚠️ Couldn't determine the right workspace."
        });
        return;
      }
    }

    const response = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
      message: question,
      mode: "chat",
      sessionId: "slash-" + Date.now()
    }, {
      headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
    });

    const answer = response.data.textResponse || 'No response from DeepOrbit.';

    await axios.post(response_url, {
      response_type: "in_channel",
      text: `*DeepOrbit* (${workspace}):\n${answer}`
    });

  } catch (err) {
    console.error('Error in /askllm handler:', err.response?.data || err.message);
    await axios.post(response_url, {
      response_type: "ephemeral",
      text: "❌ Something went wrong asking DeepOrbit."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 DeepOrbit bot is running on port ${PORT}`);
});
