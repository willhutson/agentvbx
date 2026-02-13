# AGENTVBX

> Project conventions and architecture reference for AI-assisted development.

## Architecture

Monorepo (npm workspaces, Node 20+) with 9 packages:

| Package | Purpose |
|---------|---------|
| `packages/orchestrator` | Core brain — Redis Streams queue, message router, recipe engine, tenant manager, artifact pipeline, marketplace, analytics, rate limiter, white-label |
| `packages/providers` | Provider registry (21+), Model Genie recommendation engine, adapters (Ollama, Anthropic, OpenAI, DeepSeek) |
| `packages/api` | Express REST API + WebSocket server for admin operations and real-time events |
| `packages/whatsapp` | WhatsApp channel via WWeb.js + House Channel broadcasts |
| `packages/voice` | Telnyx Voice AI, call control, SMS, transcription routing (Whisper/Deepgram) |
| `packages/agent-browser` | Playwright browser sessions for BYOA provider automation, task runner, health monitoring, re-auth flows |
| `packages/integrations` | Platform adapters — Google Drive, Monday.com, Notion, GitHub, Meta Ads |
| `packages/mobile` | Progressive Web App — mobile-first dashboard, chat, push notifications |
| `packages/desktop` | Tauri v2 desktop app — 17-view SPA with role-based UI (User/Builder/Admin), visual recipe editor, provider priority drag-and-drop, admin analytics, Rust backend for filesystem/Obsidian/sessions |

Supporting directories:
- `config/agents/` — Agent blueprint YAML files (7 agents)
- `config/recipes/` — Recipe workflow YAML files
- `recipes/` — Community/example recipes (6 recipes)

## Message Flow

```
Channel (WhatsApp/Voice/SMS/App/Mobile PWA)
  → Bridge (normalize to Message format)
    → Rate Limiter (tier-based quota enforcement)
      → Redis Streams (3 priority queues: voice > chat > background)
        → Router (keyword + channel + tool scoring → agent selection)
          → Provider Adapter (with fallback chain)
            → Response → Analytics tracking → Channel Sender → back to user
```

## Key Types

All in `packages/orchestrator/src/types.ts`:
- `Message` — channel-agnostic message with attachments, call metadata, artifacts
- `AgentBlueprint` — agent config: providers, tools, channels, keywords, system prompt
- `Recipe` / `RecipeStep` — multi-step workflows with gates and integration I/O
- `RecipeMarketplace` — marketplace metadata: pricing, stats, versioning
- `TenantConfig` — multi-tenant isolation with numbers, transcription, integrations
- `Artifact` — generated file with cloud destination and notification tracking

## Conventions

### TypeScript
- Target: ES2022, module: NodeNext
- Strict mode enabled
- Pino for logging (`createLogger('component-name')`)
- All packages use the same `tsconfig.base.json`

### Testing
- Vitest for all packages
- 138 tests across orchestrator (config, routing, recipes, marketplace, rate-limiter, analytics) and providers (registry, genie)
- Run: `npm test` (all workspaces) or `npm test --workspace=packages/orchestrator`

### Config Files
- YAML for agent blueprints, recipes, provider registry, tenant configs
- Loaded via `ConfigLoader` with hot-reload support
- Agent blueprints define `provider_priority` as a fallback chain

### Naming
- Files: kebab-case (`agent-step-handler.ts`)
- Classes: PascalCase (`AgentStepHandler`)
- Interfaces: PascalCase with descriptive suffixes (`AdapterManagerLike`, `StepHandler`)
- Type exports use `export type` for type-only exports

### Package Patterns
- Each package has `src/index.ts` barrel export
- Each package has `src/logger.ts` (Pino instance)
- Adapters implement a shared interface (`ProviderAdapter`, `IntegrationAdapter`)
- Bridges connect channels to orchestrator queue (`WhatsAppBridge`, `VoiceBridge`)

## API Endpoints

Base: `http://localhost:3000/api`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | System health + queue stats |
| GET | `/system` | Version, uptime, memory, WS clients |
| POST | `/tenants` | Create tenant |
| GET | `/tenants` | List tenants |
| GET | `/tenants/:id` | Get tenant |
| PATCH | `/tenants/:id` | Update tenant |
| GET | `/agents` | List registered agents |
| GET | `/agents/:name` | Get agent details |
| POST | `/messages` | Submit message to queue |
| GET | `/recipes` | List recipes |
| POST | `/recipes/:name/execute` | Execute recipe |
| GET | `/recipes/executions/:id` | Get execution status |
| DELETE | `/recipes/executions/:id` | Cancel execution |
| GET | `/providers` | List providers |
| GET | `/processes` | Process supervisor status |
| GET | `/browser/sessions` | List all browser sessions |
| GET | `/browser/sessions/:tenantId` | List tenant's browser sessions |
| POST | `/browser/sessions` | Create browser session |
| DELETE | `/browser/sessions/:tenantId/:providerId` | Close browser session |
| GET | `/browser/health` | Browser session health check |
| POST | `/browser/reauth` | Request re-authentication |
| GET | `/browser/scripts` | List available provider scripts |
| GET | `/marketplace/recipes` | Browse marketplace (filter by category, sort, search) |
| GET | `/marketplace/recipes/:id` | Get marketplace recipe details |
| POST | `/marketplace/recipes` | Publish recipe to marketplace |
| POST | `/marketplace/recipes/:id/install` | Install recipe for tenant |
| GET | `/analytics/overview` | System-wide analytics overview |
| GET | `/analytics/usage/:tenantId` | Tenant usage summary |
| GET | `/analytics/costs` | Cost breakdown by provider/tenant |
| GET | `/whitelabel/:tenantId` | Get white-label config |
| PUT | `/whitelabel/:tenantId` | Set white-label config |

WebSocket: `ws://localhost:3000/ws` — real-time events (health, message:routed, message:completed, browser:*, marketplace:*, etc.)

## Provider Priority

Routing follows agent's `provider_priority` array with automatic fallback:
1. Try first available provider
2. If unavailable or fails, try next in list
3. `AdapterManager.sendWithFallback()` handles the chain

Default chain: Ollama (free, local) → DeepSeek → OpenAI → Anthropic

## Browser BYOA (Phase 5)

The agent-browser package automates AI provider web UIs:
- **SessionManager** — persistent Playwright browser contexts per provider per tenant
- **TaskRunner** — sends messages, extracts responses, handles retries
- **ProviderScripts** — UI selectors for ChatGPT, Claude, Gemini, Perplexity, Midjourney, Lovable
- **HealthMonitor** — periodic session health checks, detects expired auth
- **ReauthFlowManager** — coordinates re-authentication via desktop window or secure link

## Recipe Marketplace (Phase 6)

- Publish, discover, install, rate, and fork recipes
- Categories, tags, search, and sorting (popular, rating, newest)
- Versioning with automatic version bumps on update
- Required tools extraction from recipe steps

## Scaling (Phase 6)

- **RateLimiter** — token-bucket per tenant with tier-based limits (free → agency)
- Limits: messages/min, messages/day, recipes/hour, browser sessions, API calls/min, storage
- **CI/CD** — GitHub Actions workflow (lint, test, build, Docker push)
- **Docker** — multi-stage Dockerfile, docker-compose with Redis + Ollama

## Analytics (Phase 7)

- Track all usage events: messages, recipes, browser tasks, integrations, artifacts
- Per-provider cost calculation with known rate tables
- Tenant usage summaries with time-range filtering
- Cost breakdown by provider, tenant, and daily

## White-label (Phase 7)

- Full brand customization: name, logo, colors, fonts
- Custom domain and subdomain support
- CSS variable generation for theming
- Feature toggles: powered-by badge, custom login, hide branding

## Mobile PWA (Phase 7)

- `packages/mobile/public/` — standalone PWA
- Service worker with network-first caching and offline fallback
- Push notification support via Web Push API
- 4-tab layout: Dashboard, Chat, Recipes, Settings

## Desktop App (Phase 8)

- `packages/desktop/` — Tauri v2 native app (HTML + Rust)
- Single-page app with hash-based routing, 17 views, zero JS dependencies
- Role-based UI: User (8 views), Builder (3 views), Admin (5 views)
- Design system: dark theme with CSS custom properties (white-label ready)

### User Panel
- Setup wizard (4-step onboarding: Connect AI → Files → WhatsApp → Ready)
- Dashboard with provider strip, stat cards, activity feed, artifact alerts
- Provider priority chain (drag-to-reorder, context menus)
- File stores browser (local, Obsidian, Google Drive)
- Artifacts table with status tracking and version history
- Installed recipes with run actions, marketplace browser

### Recipe Builder
- 3-column editor: step palette (5 types) → visual canvas with connectors → config panel
- Drag step types from palette to canvas, drag to reorder on canvas
- Config panel adapts to step type (agent, integration, artifact, notification)
- Save, test, and publish to marketplace

### Admin Panel
- Tenant management (CRUD, tier badges, status filters)
- System health dashboard (6 services + Redis queue stats)
- Usage analytics with CSS-only bar charts (provider usage, cost breakdown)
- Revenue dashboard (MRR, marketplace, affiliate, ARPU)
- Marketplace moderation queue (approve/reject)

### Rust Backend (Tauri IPC)
- `list_directory` / `read_text_file` — filesystem access
- `discover_obsidian_vaults` — scan for `.obsidian` dirs (max depth 4)
- `hash_file` — SHA-256 for artifact versioning
- `get_provider_login_config` — BYOA login URLs + success indicators
- `ensure_session_dir` — per-tenant/provider session storage

### Interactive Features
- Context menus: provider, recipe, artifact, tenant
- Drag-and-drop: provider reorder, recipe step builder
- Modal dialogs: send message, create tenant, confirmations
- Toast notifications: action feedback
- API bridge: Tauri IPC with REST API fallback

## Recipe Step Types

| Type | Handler | Description |
|------|---------|-------------|
| `agent` | AgentStepHandler | Send to LLM via adapter manager |
| `integration_read` | IntegrationReadHandler | Read from platform (Drive, Monday, Meta Ads, etc.) |
| `integration_write` | IntegrationWriteHandler | Write to platform |
| `artifact_delivery` | ArtifactDeliveryHandler | Save file → upload to cloud → notify |
| `notification` | NotificationStepHandler | Send via WhatsApp/SMS/app |

## Environment Variables

```
REDIS_HOST=localhost
REDIS_PORT=6379
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
TELNYX_API_KEY=KEY...
DEEPGRAM_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MONDAY_API_KEY=...
NOTION_API_KEY=...
GITHUB_TOKEN=ghp_...
META_APP_ID=...
META_APP_SECRET=...
META_ACCESS_TOKEN=...
API_PORT=3000
API_KEY=... (optional, for admin API auth)
```

## Build & Run

```bash
npm install          # Install all workspace deps
npm run build        # Build all packages
npm test             # Run all tests (138 tests)
npm run dev          # Start API server (dev mode)
npm run clean        # Clean dist/ directories
```

### Docker

```bash
docker compose up -d                    # Start API + Redis
docker compose --profile gpu up -d      # Start with GPU Ollama
docker compose --profile cpu up -d      # Start with CPU Ollama
```

### Desktop (Tauri v2)

```bash
cd packages/desktop/src-tauri
cargo tauri dev                         # Dev mode with hot reload
cargo tauri build                       # Production build
```
