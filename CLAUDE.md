# AGENTVBX

> Project conventions and architecture reference for AI-assisted development.

## Architecture

Monorepo (npm workspaces, Node 20+) with 7 packages:

| Package | Purpose |
|---------|---------|
| `packages/orchestrator` | Core brain — Redis Streams queue, message router, recipe engine, tenant manager, artifact pipeline |
| `packages/providers` | Provider registry (21+), Model Genie recommendation engine, adapters (Ollama, Anthropic, OpenAI, DeepSeek) |
| `packages/api` | Express REST API + WebSocket server for admin operations and real-time events |
| `packages/whatsapp` | WhatsApp channel via WWeb.js + House Channel broadcasts |
| `packages/voice` | Telnyx Voice AI, call control, SMS, transcription routing (Whisper/Deepgram) |
| `packages/agent-browser` | Playwright browser sessions for BYOA provider automation |
| `packages/integrations` | Platform adapters — Google Drive, Monday.com, Notion, GitHub |

Supporting directories:
- `config/agents/` — Agent blueprint YAML files (7 agents)
- `config/recipes/` — Recipe workflow YAML files
- `recipes/` — Community/example recipes
- `packages/desktop/` — Tauri v2 desktop app (HTML + Rust)

## Message Flow

```
Channel (WhatsApp/Voice/SMS/App)
  → Bridge (normalize to Message format)
    → Redis Streams (3 priority queues: voice > chat > background)
      → Router (keyword + channel + tool scoring → agent selection)
        → Provider Adapter (with fallback chain)
          → Response → Channel Sender → back to user
```

## Key Types

All in `packages/orchestrator/src/types.ts`:
- `Message` — channel-agnostic message with attachments, call metadata, artifacts
- `AgentBlueprint` — agent config: providers, tools, channels, keywords, system prompt
- `Recipe` / `RecipeStep` — multi-step workflows with gates and integration I/O
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
- 45+ tests across orchestrator (config, routing, recipes) and providers (registry, genie)
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
| POST | `/messages` | Submit message to queue |
| GET | `/recipes` | List recipes |
| POST | `/recipes/:name/execute` | Execute recipe |
| GET | `/recipes/executions/:id` | Get execution status |
| DELETE | `/recipes/executions/:id` | Cancel execution |
| GET | `/providers` | List providers |
| GET | `/processes` | Process supervisor status |

WebSocket: `ws://localhost:3000/ws` — real-time events (health, message:routed, message:completed, etc.)

## Provider Priority

Routing follows agent's `provider_priority` array with automatic fallback:
1. Try first available provider
2. If unavailable or fails, try next in list
3. `AdapterManager.sendWithFallback()` handles the chain

Default chain: Ollama (free, local) → DeepSeek → OpenAI → Anthropic

## Recipe Step Types

| Type | Handler | Description |
|------|---------|-------------|
| `agent` | AgentStepHandler | Send to LLM via adapter manager |
| `integration_read` | IntegrationReadHandler | Read from platform (Drive, Monday, etc.) |
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
API_PORT=3000
API_KEY=... (optional, for admin API auth)
```

## Build & Run

```bash
npm install          # Install all workspace deps
npm run build        # Build all packages
npm test             # Run all tests
npm run dev          # Start API server (dev mode)
npm run clean        # Clean dist/ directories
```
