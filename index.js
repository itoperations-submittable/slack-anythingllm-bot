require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { createClient } = require('redis');

const app = express();

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
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error("Empty or invalid message received.");
  }

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
      text: '🛰 Hello. I’m *DeepOrbit*. I intelligently route your questions across knowledge space. You can tag me or use `#{workspace}` to guide me.',
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
                  text: "_Built with LLMs. Powered by your data._"
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
      console.log("🧠 No workspace specified. Using public LLM to detect appropriate workspace...");
      try {
        workspace = await determineWorkspaceFromPublic(text);
      } catch (err) {
        console.error('Error determining workspace:', err);
        return res.status(500).send('Failed to determine workspace');
      }
    }

    const existingThreadId = await redisClient.get(redisKey);

    try {
      console.log("🔗 Sending to AnythingLLM:", { message: text, workspace, thread_ts });

      const llmRes = await axios.post(`${ANYTHINGLLM_API}/api/v1/workspace/${workspace}/chat`, {
        message: text,
        mode: "chat",
        sessionId: thread_ts
      }, {
        headers: { Authorization: `Bearer ${ANYTHINGLLM_API_KEY}` }
      });

      const reply = llmRes.data.textResponse || 'No response.';
      const threadId = llmRes.data.id;

      if (!existingThreadId && threadId) {
        await redisClient.set(redisKey, threadId);
      }

      await sendIntroMessage(channel, thread_ts);

      console.log("💬 Responding in Slack with:", reply);
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
  console.log(`DeepOrbit bot is running on port ${PORT}`);
});
