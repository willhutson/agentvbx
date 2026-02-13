# AGENTVBX

A chat-based orchestration layer that brings agentic AI to everyone.

Send a WhatsApp message. Get an AI-powered response from Claude, ChatGPT, DeepSeek, or your local Ollama — routed through intelligent agents, executed via multi-step recipes, and delivered with artifacts to Google Drive, Monday.com, Notion, or GitHub.

## How It Works

```
You (WhatsApp / Voice / SMS / Mobile PWA / Desktop App)
  → AGENTVBX Orchestrator
    → Rate Limiter (tier-based quota enforcement)
      → Routes to the right Agent (Researcher, Writer, Coder, Strategist...)
        → Dispatches to the best Provider (Anthropic, OpenAI, DeepSeek, Ollama)
          → Delivers artifacts (Google Drive, GitHub, Notion)
            → Tracks analytics → Notifies you (WhatsApp with preview link)
```

One message in, structured output back — across any channel.

## Quick Start

```bash
# Prerequisites: Node.js 20+, Redis
git clone https://github.com/willhutson/agentvbx.git
cd agentvbx
npm install
npm run build
npm test              # 138 tests passing

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

### Docker

```bash
docker compose up -d                    # Start API + Redis
docker compose --profile gpu up -d      # With GPU Ollama
docker compose --profile cpu up -d      # With CPU Ollama
```

## Architecture

```
agentvbx/
├── packages/
│   ├── orchestrator/      # Core brain — queue, router, recipes, tenants, artifacts,
│   │                      # marketplace, analytics, rate limiter, white-label
│   ├── providers/         # Provider registry (21+), Model Genie, adapters
│   ├── api/               # REST API + WebSocket (30+ endpoints)
│   ├── whatsapp/          # WhatsApp channel (WWeb.js + House Channel)
│   ├── voice/             # Telnyx Voice AI, SMS, transcription
│   ├── agent-browser/     # Playwright BYOA — task runner, health monitor, re-auth
│   ├── integrations/      # Google Drive, Monday.com, Notion, GitHub, Meta Ads
│   ├── mobile/            # Progressive Web App (PWA)
│   └── desktop/           # Tauri v2 desktop app (17-view SPA)
├── config/
│   ├── agents/            # 7 agent blueprints (YAML)
│   └── recipes/           # Workflow templates (YAML)
├── recipes/               # 6 community/example recipes
├── .github/workflows/     # CI/CD pipeline
├── Dockerfile             # Multi-stage production build
├── docker-compose.yml     # API + Redis + Ollama
└── docs/                  # API manual + sandbox
```

### Packages

| Package | What It Does |
|---------|-------------|
| **orchestrator** | Redis Streams message queue with 3 priority lanes (voice > chat > background). Keyword/channel/tool routing engine. Sequential recipe execution with human approval gates. Multi-tenant isolation. Artifact capture/upload/notify pipeline. Recipe marketplace. Analytics engine. Tier-based rate limiter. White-label config. |
| **providers** | 21+ provider registry with YAML catalog. Model Genie recommends tools based on user intent. Adapters: Ollama (local), Anthropic Claude, OpenAI ChatGPT, DeepSeek. `AdapterManager` handles fallback chains. |
| **api** | Express REST API with 30+ endpoints. WebSocket for real-time events. Browser session management. Marketplace CRUD. Analytics queries. White-label config. |
| **whatsapp** | WWeb.js client with QR auth. `WhatsAppBridge` normalizes messages → queue → route → respond. House Channel for broadcasts with relevance scoring. |
| **voice** | Telnyx client for number provisioning, Voice AI, call control, SMS. `VoiceBridge` handles inbound calls → answer → Voice AI → transcribe → queue. Transcription routing: Whisper (free) → Deepgram Nova-3 (pro). |
| **agent-browser** | Playwright persistent contexts for BYOA (Bring Your Own Account). Task runner with provider-specific UI scripts. Health monitoring with re-auth flows. Supports ChatGPT, Claude, Gemini, Perplexity, Midjourney, Lovable. |
| **integrations** | Unified `IntegrationAdapter` interface. Google Drive (OAuth2, file ops, sharing). Monday.com (GraphQL, board/item CRUD). Notion (pages, databases). GitHub (repos, files, issues, commits). Meta Ads (campaigns, audiences, lead forms, webhooks). |
| **mobile** | Progressive Web App with service worker, offline support, push notifications. 4-tab layout: Dashboard, Chat, Recipes, Settings. |
| **desktop** | Tauri v2 native desktop app with 17-view SPA. Role-based UI (User/Builder/Admin). Setup wizard, provider priority drag-and-drop, visual recipe editor, artifact management, admin analytics, marketplace moderation. Rust backend for filesystem, Obsidian vault discovery, session storage, content hashing. |

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

### Built-in Recipes

| Recipe | Trigger | Flow |
|--------|---------|------|
| **Research & Deliver** | Manual | Topic → Deep research → Write report → Google Drive → WhatsApp link |
| **Voice-to-Structured-Data** | Voice note | Transcribe → Extract fields → Human confirm → Monday.com → WhatsApp |
| **Monday Morning Briefing** | Schedule (Mon 9am) | Pull updates → Summarize → Voice-note-style delivery |
| **Social Video Pipeline** | Manual | Script → Storyboard → Generate video → Upload → Notify |
| **Meta Lead Nurture** | Meta Ads webhook | Capture lead → Research company → Craft personalized WhatsApp → Log to CRM |
| **Content Calendar** | Schedule (Mon 9am) | Research trends → Generate calendar → Write posts → Review gate → Drive + Notion |

### Recipe Step Types

| Type | Description |
|------|-------------|
| `agent` | Send to an LLM via the adapter manager |
| `integration_read` | Read from a platform (Drive, Monday, Notion, Meta Ads) |
| `integration_write` | Write to a platform |
| `artifact_delivery` | Save file → upload to cloud → send notification |
| `notification` | Send message via WhatsApp, SMS, or app |

## Recipe Marketplace

Publish, discover, install, and fork recipes across the platform.

- **Publish** recipes with pricing (free, one-time, subscription)
- **Search** by category, tags, or keywords
- **Sort** by popularity, rating, or newest
- **Fork** any recipe to customize for your workflow
- **Rate** recipes (1-5 stars)
- **Version** tracking with automatic bumps

## Provider Adapters

| Adapter | Integration | Features |
|---------|------------|----------|
| **Ollama** | Local HTTP | Chat, embeddings, model listing. Free, private. |
| **Anthropic** | Messages API | Claude 4.5, vision, system prompts. |
| **OpenAI** | Chat Completions | GPT-4o, vision, organization support. |
| **DeepSeek** | OpenAI-compatible | DeepSeek-V3, reasoning, code. |

### Browser BYOA Providers

The agent-browser package automates these provider web UIs directly:

| Provider | Capabilities |
|----------|-------------|
| **ChatGPT** | Chat, artifacts, code execution |
| **Claude** | Chat, artifacts, document analysis |
| **Gemini** | Chat, image generation |
| **Perplexity** | Search, citations |
| **Midjourney** | Image generation (5-min timeout) |
| **Lovable** | App building, code generation |

## Platform Integrations

| Platform | Capabilities |
|----------|-------------|
| **Google Drive** | OAuth2 auth, file upload/list/share, artifact destination |
| **Monday.com** | Board/item CRUD via GraphQL, voice-to-board recipes |
| **Notion** | Page/database CRUD, knowledge base, meeting notes |
| **GitHub** | File commits, issue creation, code artifact storage |
| **Meta Ads** | Campaign creation, audience targeting, lead forms, ROAS tracking, webhook processing |

## Multi-Tenant Scaling

5-tier system with per-tenant rate limiting:

| Tier | Messages/min | Messages/day | Browser Sessions | Recipes/hr |
|------|-------------|-------------|-----------------|-----------|
| Free | 5 | 50 | 1 | 3 |
| Starter | 20 | 500 | 3 | 20 |
| Pro | 60 | 5,000 | 10 | 100 |
| Business | 200 | 50,000 | 50 | 500 |
| Agency | 1,000 | 500,000 | 200 | 5,000 |

## Analytics

- Per-tenant usage tracking (messages, recipes, tokens, costs)
- Provider cost calculation with real rate tables
- Daily cost breakdowns by provider and tenant
- Top providers and agents dashboards

## White-Label

Business and Agency tier tenants can fully customize:

- Brand name, logo, tagline, favicon
- Color theme (primary, secondary, accent, background, surface, text)
- Custom fonts and border radius
- Custom domain / subdomain
- Email branding (from name, reply-to, footer)
- Feature toggles (hide AGENTVBX branding, custom login page)

## API

Full interactive documentation: **[docs/api-manual.html](docs/api-manual.html)**

30+ endpoints across 9 categories:

```
GET  /api/health                              System health + queue stats
POST /api/tenants                             Create a tenant
POST /api/messages                            Send a message to the queue
POST /api/recipes/:name/execute               Execute a recipe
GET  /api/agents                              List registered agents
GET  /api/browser/sessions                    List browser sessions
POST /api/browser/reauth                      Request re-authentication
GET  /api/marketplace/recipes                 Browse recipe marketplace
GET  /api/analytics/overview                  System-wide analytics
GET  /api/analytics/costs                     Cost breakdown
PUT  /api/whitelabel/:tenantId                Set white-label config
WS   /ws                                      Real-time event stream
```

## Desktop App

The Tauri v2 desktop app (`packages/desktop/`) is the zero-infrastructure hub for AGENTVBX. It runs as a native app on macOS, Windows, and Linux.

### Role-Based Views

| Role | Views | Purpose |
|------|-------|---------|
| **User** | Setup, Dashboard, Providers, Files, Artifacts, Recipes, Marketplace, Settings | Day-to-day usage: connect providers, browse files, run recipes, manage artifacts |
| **Builder** | My Recipes, Recipe Editor, Published | Create and publish recipes with a visual drag-and-drop editor |
| **Admin** | Dashboard, System Health, Tenants, Analytics, Revenue, Moderation | Platform management: tenant CRUD, health monitoring, usage analytics, marketplace moderation |

### Key Features

- **Setup Wizard** — 4-step onboarding: Connect AI providers, file stores, WhatsApp
- **Provider Priority Chain** — Drag-and-drop to reorder the provider fallback chain
- **Visual Recipe Editor** — 3-column layout: step palette, canvas with connectors, config panel. Supports all 5 step types (agent, integration_read, integration_write, artifact_delivery, notification)
- **Context Menus** — Right-click on providers, recipes, artifacts, tenants for contextual actions
- **Tauri IPC Bridge** — Rust backend provides filesystem access, Obsidian vault discovery, session storage, content hashing. Falls back to REST API when running in browser.

### Desktop Rust Commands

| Command | Description |
|---------|-------------|
| `get_health` | App health + platform info |
| `list_directory` | Browse filesystem (hidden files filtered) |
| `read_text_file` | Read file content (10MB limit) |
| `hash_file` | SHA-256 hash for artifact versioning |
| `get_user_directories` | Home, Desktop, Documents, Downloads paths |
| `discover_obsidian_vaults` | Scan for `.obsidian` directories (max depth 4) |
| `get_provider_login_config` | Login URL + success indicators for BYOA providers |
| `ensure_session_dir` | Create session storage directory per tenant/provider |

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
npm test                 # Run all 138 tests (Vitest)
npm run dev              # Start API server in dev mode
npm run dev:orchestrator # Start orchestrator in dev mode
npm run clean            # Remove all dist/ directories
```

### Project Layout

- **Config**: YAML files in `config/agents/` and `config/recipes/`
- **Types**: `packages/orchestrator/src/types.ts` — all core interfaces
- **Tests**: Vitest, 138 tests across orchestrator and providers
- **Logging**: Pino structured JSON logging
- **Queue**: Redis Streams with consumer groups (at-least-once delivery)
- **CI/CD**: GitHub Actions (lint → test → build → Docker push to GHCR)

## Roadmap

- [x] Phase 1: Scaffold — monorepo, queue, router, recipe engine, tenant manager
- [x] Phase 2: Admin API, message dispatch, provider adapters (Anthropic/OpenAI/DeepSeek)
- [x] Phase 3: WhatsApp bridge, voice bridge, recipes, agent configs
- [x] Phase 4: Google Drive, Monday.com, Notion, GitHub, artifact pipeline
- [x] Phase 5: Browser BYOA automation, session health, re-auth flows
- [x] Phase 6: Recipe marketplace, multi-tenant at scale, CI/CD, Docker
- [x] Phase 7: Mobile PWA, Meta Ads funnel, analytics, white-label
- [x] Phase 8: Desktop app — Tauri v2 with session adapters, file stores, visual recipe builder, admin panel

## License

UNLICENSED — All rights reserved.
