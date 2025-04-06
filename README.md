# Slack + AnythingLLM Bot

This Slack bot connects your workspace to AnythingLLM using intelligent thread routing and workspace detection. Built with Node.js, Docker, and Redis.

## Features

- Replies in Slack threads using AnythingLLM thread context
- Detects `#{workspace}` tags in messages
- If no tag, queries the `general` workspace to pick the best match
- Persists Slack ↔ LLM thread mapping via Redis
- Dockerized for easy deployment

## Quick Start

```bash
git clone https://github.com/yourname/slack-anythingllm-bot.git
cd slack-anythingllm-bot
cp .env.example .env
# edit .env with your secrets

docker-compose up --build
```

## Environment Variables

| Variable             | Description |
|----------------------|-------------|
| `SLACK_BOT_TOKEN`    | Slack bot token |
| `SLACK_SIGNING_SECRET` | Slack app secret |
| `ANYTHINGLLM_API`    | Base URL to your AnythingLLM server |
| `ANYTHINGLLM_API_KEY`| API key for AnythingLLM |
| `REDIS_URL`          | Redis instance URL (default for Docker: `redis://redis:6379`) |

## Dockerized

- App runs on Node 20
- Redis included via docker-compose
- Healthchecks included

## Dev Tips

- Edit `index.js` to change logic or add slash commands
- Restart: `docker-compose restart bot`
- Add persistent Redis volume if desired

## License

MIT
