# AGENTVBX

A chat-based orchestration layer that brings agentic AI to everyone.

Send a WhatsApp message. Get an AI-powered response from Claude, ChatGPT, DeepSeek, or your local Ollama — routed through intelligent agents, executed via multi-step recipes, and delivered with artifacts to Google Drive, Monday.com, Notion, or GitHub.

## How It Works

```
You (WhatsApp / Voice / SMS / App)
  → AGENTVBX Orchestrator
    → Routes to the right Agent (Researcher, Writer, Coder, Strategist...)
      → Dispatches to the best Provider (Anthropic, OpenAI, DeepSeek, Ollama)
        → Delivers artifacts (Google Drive, GitHub, Notion)
          → Notifies you (WhatsApp with preview link)
```

One message in, structured output back — across any channel.

## Quick Start

```bash
# Prerequisites: Node.js 20+, Redis
git clone https://github.com/willhutson/agentvbx.git
cd agentvbx
npm install
npm run build
npm test              # 45 tests passing

# Start the API server
npm run dev
# → http://localhost:3000
# → WebSocket at ws://localhost:3000/ws

# Send your first message
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "demo",
    "number_id": "default",
    "channel": "app",
    "from": "user",
    "to": "system",
    "text": "Research the latest trends in AI orchestration"
  }'
```

## Architecture

```
agentvbx/
├── packages/
│   ├── orchestrator/      # Core brain — queue, router, recipes, tenants, artifacts
│   ├── providers/         # Provider registry (21+), Model Genie, adapters
│   ├── api/               # REST API + WebSocket server
│   ├── whatsapp/          # WhatsApp channel (WWeb.js + House Channel)
│   ├── voice/             # Telnyx Voice AI, SMS, transcription
│   ├── agent-browser/     # Playwright sessions for BYOA
│   └── integrations/      # Google Drive, Monday.com, Notion, GitHub
├── config/
│   ├── agents/            # 7 agent blueprints (YAML)
│   └── recipes/           # Workflow templates (YAML)
├── packages/desktop/      # Tauri v2 desktop app
└── docs/                  # API manual + sandbox
```

### Packages

| Package | What It Does |
|---------|-------------|
| **orchestrator** | Redis Streams message queue with 3 priority lanes (voice > chat > background). Keyword/channel/tool routing engine. Sequential recipe execution with human approval gates. Multi-tenant isolation. Artifact capture/upload/notify pipeline. |
| **providers** | 21+ provider registry with YAML catalog. Model Genie recommends tools based on user intent. Adapters: Ollama (local), Anthropic Claude, OpenAI ChatGPT, DeepSeek. `AdapterManager` handles fallback chains. |
| **api** | Express REST API for all CRUD operations. WebSocket for real-time events (message:routed, message:completed, recipe:started). CORS enabled. Optional API key auth. |
| **whatsapp** | WWeb.js client with QR auth. `WhatsAppBridge` normalizes messages → queue → route → respond. House Channel for broadcasts with relevance scoring. |
| **voice** | Telnyx client for number provisioning, Voice AI, call control, SMS. `VoiceBridge` handles inbound calls → answer → Voice AI → transcribe → queue. Transcription routing: Whisper (free) → Deepgram Nova-3 (pro). |
| **agent-browser** | Playwright persistent contexts for BYOA (Bring Your Own Account). Session health monitoring, cookie persistence, multi-tenant isolation. |
| **integrations** | Unified `IntegrationAdapter` interface. Google Drive (OAuth2, file ops, sharing). Monday.com (GraphQL, board/item CRUD). Notion (pages, databases). GitHub (repos, files, issues, commits). |

## Agents

Agents are YAML blueprints that define behavior, provider preferences, and routing rules.

| Agent | Specialty | Default Providers | Channels |
|-------|-----------|-------------------|----------|
| **Researcher** | Deep research, web search, analysis | Claude → Perplexity → DeepSeek → Ollama | WhatsApp, Voice, App |
| **Writer** | Reports, articles, emails, social copy | Claude → ChatGPT → DeepSeek → Ollama | WhatsApp, App |
| **Strategist** | Business planning, frameworks, decisions | Claude → ChatGPT → DeepSeek | WhatsApp, Voice, App |
| **Coder** | Code generation, debugging, architecture | Anthropic → DeepSeek → OpenAI → Ollama | App, WhatsApp |
| **Assistant** | General Q&A, everyday tasks | Ollama → DeepSeek → OpenAI → Anthropic | All channels |
| **Scheduler** | Calendar, meetings, reminders | Ollama → ChatGPT → Claude | WhatsApp, Voice, SMS |
| **Creative Director** | Images, video, design, branding | ChatGPT → Claude → DeepSeek | WhatsApp, App |

### Creating an Agent

```yaml
# config/agents/my-agent.yaml
name: MyAgent
description: "What this agent does"
provider_priority:
  - ollama
  - anthropic
  - openai
tools:
  - think
  - search
channels:
  - whatsapp
  - app
routing_keywords:
  - keyword1
  - keyword2
temperature: 0.7
system_prompt: |
  Your system prompt goes here.
  Define the agent's personality and behavior.
```

## Recipes

Recipes are multi-step workflows. Each step can use a different agent, integration, or notification.

### Voice-to-Structured-Data

```
Voice note → Transcribe → Extract fields → Human confirm → Monday.com → WhatsApp notify
```

### Research & Deliver

```
Topic → Deep research (Claude) → Write report → Google Drive upload → WhatsApp link
```

### Recipe Step Types

| Type | Description |
|------|-------------|
| `agent` | Send to an LLM via the adapter manager |
| `integration_read` | Read from a platform (Drive, Monday, Notion) |
| `integration_write` | Write to a platform |
| `artifact_delivery` | Save file → upload to cloud → send notification |
| `notification` | Send message via WhatsApp, SMS, or app |

## Provider Adapters

| Adapter | Integration | Features |
|---------|------------|----------|
| **Ollama** | Local HTTP | Chat, embeddings, model listing. Free, private. |
| **Anthropic** | Messages API | Claude 4.5, vision, system prompts. |
| **OpenAI** | Chat Completions | GPT-4o, vision, organization support. |
| **DeepSeek** | OpenAI-compatible | DeepSeek-V3, reasoning, code. |

Adapters implement a shared interface. Adding a new one:

```typescript
class MyAdapter implements ProviderAdapter {
  readonly id = 'my-provider';
  readonly name = 'My Provider';
  async isAvailable(): Promise<boolean> { /* health check */ }
  async send(request: AdapterRequest): Promise<AdapterResponse> { /* call API */ }
  async initialize(): Promise<void> { /* setup */ }
  async destroy(): Promise<void> { /* cleanup */ }
}
```

## API

Full interactive documentation: **[docs/api-manual.html](docs/api-manual.html)**

Key endpoints:

```
GET  /api/health                    System health + queue stats
POST /api/tenants                   Create a tenant
POST /api/messages                  Send a message to the queue
POST /api/recipes/:name/execute     Execute a recipe
GET  /api/agents                    List registered agents
WS   /ws                            Real-time event stream
```

## Platform Integrations

| Platform | Capabilities |
|----------|-------------|
| **Google Drive** | OAuth2 auth, file upload/list/share, artifact destination |
| **Monday.com** | Board/item CRUD via GraphQL, voice-to-board recipes |
| **Notion** | Page/database CRUD, knowledge base, meeting notes |
| **GitHub** | File commits, issue creation, code artifact storage |

## Transcription Tiers

| Tier | Engine | Features |
|------|--------|----------|
| Free/Starter | Whisper via Ollama | On-device, private, no limits |
| Pro | Deepgram Nova-3 Batch | Cloud, smart formatting |
| Business/Agency | Deepgram Nova-3 Premium | Diarization, language detection |
| Live Calls | Telnyx Native | Always-on, sub-200ms latency |

## Development

```bash
npm install              # Install all workspace dependencies
npm run build            # Build all packages
npm test                 # Run all tests (Vitest)
npm run dev              # Start API server in dev mode
npm run dev:orchestrator # Start orchestrator in dev mode
npm run clean            # Remove all dist/ directories
```

### Project Layout

- **Config**: YAML files in `config/agents/` and `config/recipes/`
- **Types**: `packages/orchestrator/src/types.ts` — all core interfaces
- **Tests**: Vitest, 45+ tests across 5 suites
- **Logging**: Pino structured JSON logging
- **Queue**: Redis Streams with consumer groups (at-least-once delivery)

## Roadmap

- [x] Phase 1: Scaffold — monorepo, queue, router, recipe engine, tenant manager
- [x] Phase 2: Admin API, message dispatch, provider adapters (Anthropic/OpenAI/DeepSeek)
- [x] Phase 3: WhatsApp bridge, voice bridge, recipes, agent configs
- [x] Phase 4: Google Drive, Monday.com, Notion, GitHub, artifact pipeline
- [ ] Phase 5: Browser BYOA automation, session health, re-auth flows
- [ ] Phase 6: Recipe marketplace, multi-tenant at scale, CI/CD, Docker
- [ ] Phase 7: Mobile app, Meta Ads funnel, analytics, white-label

## License

UNLICENSED — All rights reserved.
