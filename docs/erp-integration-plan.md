# ERP (SpokeStack) + AGENTVBX Integration Plan

## Context

SpokeStack ERP (`erp_staging_lmtd`) is a multi-tenant Next.js ERP for professional services agencies — 258 Prisma models, Supabase Postgres, 20 modules (9 functional, 11 stubs). AGENTVBX is a Node.js AI orchestration platform — Redis Streams, 9 packages, 21+ providers, recipe engine, channels (WhatsApp/Voice/SMS), desktop/mobile apps.

**The goal**: AGENTVBX is a **separate capability service** that powers the ERP's **Communicate** category — providing WhatsApp, Voice/SMS, browser BYOA, desktop app, mobile PWA, and AI recipe orchestration. It sits **behind Agent Builder** in the service hierarchy.

**Service hierarchy**:
```
ERP (Next.js)  →  Agent Builder (separate repo)  →  AGENTVBX (separate repo)
     UI &              orchestrates agent              provides channels,
     business          conversations &                 BYOA, voice/SMS,
     logic             streaming                       recipes, desktop/mobile
```

**Deployment**: AGENTVBX runs as a **separate service** (like Agent Builder already does). Rationale:
- AGENTVBX runs Redis Streams, Playwright browsers, Telnyx voice, WWeb.js — long-lived stateful processes incompatible with Next.js serverless
- Independent scaling (voice/browser load ≠ web traffic)
- Failure isolation (Playwright crash doesn't take down ERP)
- You already have the DevOps pattern from Agent Builder

---

## 1. Overlap Map (Shared Concerns)

| Concern | SpokeStack ERP | AGENTVBX | Sync Strategy |
|---------|---------------|----------|---------------|
| **Multi-tenancy** | `orgId`-scoped Prisma queries, Supabase | `tenant_id` directory-based, YAML configs | ERP `orgId` = AGENTVBX `tenant_id`. ERP is source of truth; AGENTVBX mirrors via Agent Builder on org create/update |
| **AI/LLM** | OpenRouter via `OPENROUTER_API_KEY`, Agent Builder service | Anthropic/OpenAI/DeepSeek/Ollama direct APIs + session adapters | **Replace AGENTVBX's 3 API adapters with single OpenRouter adapter** (reuse `OpenAIAdapter` with `baseUrl: https://openrouter.ai/api/v1`). Keep Ollama (free/local) and session adapters (BYOA) |
| **Agent architecture** | External Agent Builder (WS + SSE), `/api/agent-callback` | Internal orchestrator, Redis Streams queue, keyword/channel router | **Agent Builder calls AGENTVBX** for channel capabilities (WhatsApp, Voice, SMS, BYOA). Agent Builder remains the primary agent orchestrator for the ERP |
| **Google Drive** | OAuth callback at `/api/integrations/google/callback` | `GoogleDriveAdapter` + `GoogleAuth` | **Share OAuth tokens**. ERP stores tokens in Postgres; AGENTVBX reads them via Agent Builder or shared secret store |
| **Workflows / Recipes** | WfCanvas — visual DAG builder with branching, conditions, delays, human nodes | Recipe engine — YAML sequential pipeline, 5 AI-centric step types, marketplace | **Align, don't merge**. Canvas handles business orchestration (conditions, branching, approvals). Recipes handle AI pipelines (research → generate → deliver). Canvas gets a `recipe` node type that triggers AGENTVBX recipes via Agent Builder. No duplication of concerns — see §3g |
| **Realtime events** | Pusher (hosted) | WebSocket server (self-hosted) | **Bridge**: AGENTVBX events → Agent Builder → Pusher for ERP UI |
| **Content/artifacts** | Studio, Publisher (multi-platform social) | Artifact pipeline (generate → version → upload → notify) | **AGENTVBX generates via Communicate channels, ERP publishes** |
| **Auth** | Supabase Auth (JWT sessions) | Optional Bearer token (`API_KEY` env var) | Service-to-service: Agent Builder calls AGENTVBX with shared `AGENTVBX_API_KEY`. AGENTVBX trusts Agent Builder (same pattern as ERP → Agent Builder) |

---

## 2. Gap Analysis

### ERP has, AGENTVBX doesn't:
| Capability | ERP Detail | Integration Path |
|-----------|-----------|-----------------|
| **Relational DB** | Prisma + Postgres (258 models) | AGENTVBX stays schemaless (Redis + YAML). Agent Builder passes structured data from ERP when needed |
| **Publisher module** | Multi-platform social publishing | Content generated via AGENTVBX recipes lands as drafts in Publisher via Agent Builder callback |
| **Studio** | Creative production suite | AGENTVBX agents can power Studio's AI features via Agent Builder |
| **CRM / Projects** | Client management, project tracking | Agent Builder passes project context to AGENTVBX for agent grounding |
| **Supabase Auth** | Full auth system | Agent Builder handles auth; AGENTVBX uses service-to-service token |
| **Pusher** | Hosted realtime | Agent Builder relays AGENTVBX events to Pusher |

### AGENTVBX has, ERP doesn't:
| Capability | AGENTVBX Detail | Integration Path |
|-----------|----------------|-----------------|
| **WhatsApp** | WWeb.js bridge, message normalization | Agent Builder routes WhatsApp requests through AGENTVBX. Inbound messages → Agent Builder → ERP |
| **Voice/SMS** | Telnyx Voice AI, call control, transcription | New Communicate channel. Agent Builder dispatches voice/SMS tasks to AGENTVBX |
| **Browser BYOA** | Playwright sessions for ChatGPT/Claude/Gemini/etc | Users connect their own AI subscriptions. Agent Builder can route through BYOA when API is unavailable |
| **Desktop app** | Tauri v2, 17-view SPA | **Embedded ERP client** — connects to ERP API for data, AGENTVBX API for AI/channel features |
| **Mobile PWA** | Service worker, push notifications | **Embedded ERP client** — same dual-API pattern |
| **Recipe marketplace** | Publish, discover, install, rate, fork | ERP orgs browse marketplace via Agent Builder |
| **Rate limiting** | Token-bucket per tenant, tier-based | Enforce AI/channel usage quotas per ERP org |
| **Transcription** | Whisper (local) → Deepgram Nova-3 (cloud) | Voice-to-text for meeting notes, briefs, project updates |
| **Session adapters** | Use consumer AI subscriptions as providers | Reduce API costs by routing through users' existing subscriptions |

---

## 3. Integration Architecture

### 3a. Service Communication (3-tier hierarchy)

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   SpokeStack ERP │       │   Agent Builder   │       │    AGENTVBX      │
│   (Next.js)      │       │   (separate repo) │       │    (Express)     │
├──────────────────┤       ├──────────────────┤       ├──────────────────┤
│                  │       │                  │       │                  │
│  UI / business   │─WS/──→│  Agent orchestr.  │─REST─→│  /api/messages   │
│  logic / Canvas  │ SSE   │  streaming / SSE  │       │  /api/recipes    │
│                  │       │                  │       │                  │
│  /api/agent-     │←─POST─│  Callback relay   │←─POST─│  Completion      │
│  callback        │       │                  │       │  callbacks       │
│                  │       │                  │       │                  │
│  Pusher          │←─EMIT─│  Event relay      │←─WS──│  WebSocket       │
│  (realtime UI)   │       │                  │       │  events          │
│                  │       │                  │       │                  │
└──────────────────┘       └──────────────────┘       └──────────────────┘
                                                              │
                           ┌──────────────────────────────────┤
                           │                │                 │
                     ┌─────▼──┐      ┌──────▼──┐      ┌──────▼──┐
                     │WhatsApp│      │Voice/SMS│      │Browser  │
                     │WWeb.js │      │Telnyx   │      │BYOA     │
                     └────────┘      └─────────┘      └─────────┘
```

**Auth**: Service-to-service Bearer token. Agent Builder calls AGENTVBX with shared `AGENTVBX_API_KEY` — same pattern as ERP → Agent Builder.

**Callback signing**: AGENTVBX signs callback payloads with HMAC-SHA256 using `AGENT_BUILDER_WEBHOOK_SECRET`.

**Streaming gap**: Agent Builder supports SSE streaming to ERP. AGENTVBX adapters currently return batch responses only. Streaming support is Phase E work — for now, Agent Builder streams from its own LLM calls and uses AGENTVBX for non-streaming capabilities (channels, BYOA, recipes).

### 3b. OpenRouter Adapter

AGENTVBX's `OpenAIAdapter` already has a `baseUrl` config. OpenRouter uses the OpenAI-compatible API format.

**File**: `packages/providers/src/adapters/openai.ts`

```typescript
// No new adapter class needed. Instantiate OpenAIAdapter with OpenRouter config:
const openrouter = new OpenAIAdapter({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'anthropic/claude-sonnet-4', // or any OpenRouter model ID
});
```

**Changes needed**:
- Add `openrouter` to provider registry YAML (`config/providers/registry.yaml`)
- Update `AdapterManager` bootstrap to instantiate OpenRouter as the primary API adapter
- Remove or demote `anthropic`, `openai`, `deepseek` adapters (keep as fallback options)
- Keep `ollama` (free/local) and session adapters (BYOA) as-is
- Add OpenRouter-specific headers (`HTTP-Referer`, `X-Title`) for ranking/analytics

**New default provider chain**: `openrouter → ollama → session:chatgpt → session:claude`

### 3c. Tenant ID Mapping

| ERP Field | AGENTVBX Field | Notes |
|-----------|---------------|-------|
| `orgId` (UUID) | `tenant_id` | 1:1 mapping. `TenantManager.create()` accepts optional `id` so ERP `orgId` IS the `tenant_id` |
| `org.plan` (subscription tier) | `tier` (free/starter/pro/business/agency) | Map ERP plan names to AGENTVBX tiers |
| `org.name` | `TenantConfig.name` | Sync on create/update via Agent Builder |
| `userId` | `Message.from` | Track which ERP user initiated the request |

### 3d. Communicate Flow (WhatsApp / Voice / SMS)

This is the primary integration — AGENTVBX powers the ERP's Communicate category:

```
Inbound (customer → ERP):
──────────────────────────
Customer sends WhatsApp msg / calls / texts
  → AGENTVBX receives via WWeb.js / Telnyx
    → Normalizes to Message format
      → Routes to appropriate agent (or passes to Agent Builder)
        → Agent Builder processes (with ERP context)
          → Response sent back through AGENTVBX channel

Outbound (ERP → customer):
──────────────────────────
ERP user triggers communication
  → Agent Builder calls AGENTVBX API
    → POST /api/messages (channel: 'whatsapp' | 'voice' | 'sms')
      → AGENTVBX sends via appropriate channel adapter
        → Delivery confirmation → Agent Builder → ERP
```

### 3e. Desktop & Mobile (Embedded ERP Clients)

**Desktop (Tauri v2)** — integrated ERP client with AGENTVBX capabilities:
- **ERP API**: fetch projects, clients, briefs, publisher status, CRM data
- **AGENTVBX API**: manage provider connections, execute recipes, WhatsApp/voice controls
- ERP-specific views: project dashboard, client briefs, communication hub
- White-label per org via AGENTVBX white-label config
- BYOA onboarding: desktop app guides users through connecting ChatGPT/Claude/Gemini

**Mobile PWA** — same integrated pattern:
- Dashboard: ERP project stats + AGENTVBX AI usage + communication activity
- Chat: WhatsApp/SMS conversations through AGENTVBX channels
- Recipes: browse/run from marketplace
- Settings: provider connections, notification preferences

### 3f. Telnyx Voice/SMS for ERP Communicate

New capability the ERP currently lacks:
- **Provision numbers** per ERP org via AGENTVBX tenant config
- **Voice notes → briefs**: client calls → Telnyx → transcription → recipe → ERP brief creation via Agent Builder
- **SMS notifications**: recipe completion, approval requests, delivery confirmations
- **Voice AI assistant**: answer project status queries by phone, routed through AGENTVBX agents with ERP context from Agent Builder

### 3g. Canvas ↔ Recipe Alignment Strategy

**Problem**: Both Canvas (ERP) and Recipes (AGENTVBX) are "run steps in sequence." Without clear boundaries, they'll duplicate features and confuse users.

**Solution**: Each system owns a distinct concern. No feature duplication.

| Concern | Owned by Canvas (ERP) | Owned by Recipe (AGENTVBX) |
|---------|----------------------|---------------------------|
| **Branching / conditions** | Yes — `condition` nodes, if/else paths | No — recipes are strictly sequential |
| **Delays / scheduling** | Yes — `delay` nodes, wait N hours/days | Trigger-level only (`cron` schedule) |
| **Business approvals** | Yes — `human` nodes in approval chains | No (recipe `gate: human_approval` is for AI quality review, not business approval) |
| **Parallel execution** | Yes — DAG branches run concurrently | No — steps run sequentially |
| **AI agent calls** | No — delegates to Agent Builder / AGENTVBX | Yes — `agent` step type with provider fallback |
| **Integration I/O** | No — delegates to AGENTVBX | Yes — `integration_read` / `integration_write` steps |
| **Artifact generation** | No — delegates to AGENTVBX | Yes — `artifact_delivery` step with versioning |
| **Channel notifications** | No — delegates to AGENTVBX | Yes — `notification` step (WhatsApp, SMS, app) |
| **Marketplace** | No | Yes — publish/install/fork/rate recipes |
| **Visual editing** | Canvas UI (DAG builder) | Desktop app recipe editor (palette → canvas → config) |

**The bridge**: Canvas gets a `recipe` node type that calls AGENTVBX:

```
Canvas `recipe` node:
├── recipe_name: string        (which AGENTVBX recipe to run)
├── input_mapping: object      (Canvas context → recipe input variables)
├── output_mapping: object     (recipe output variables → Canvas context)
├── timeout: number            (max wait for recipe completion)
└── on_failure: 'stop' | 'skip' | 'fallback'

Execution:
  Canvas reaches `recipe` node
    → Agent Builder calls AGENTVBX POST /api/recipes/:name/execute
    → AGENTVBX runs all recipe steps internally
    → Completion callback → Agent Builder → Canvas resumes with recipe outputs
```

**What NOT to do**:
- Don't add `condition`, `delay`, `loop`, or `branch` step types to AGENTVBX recipes
- Don't add `agent`, `artifact_delivery`, or `notification` node types to Canvas
- Don't duplicate approval semantics — Canvas `human` nodes = business approval (manager signs off), Recipe `gate: human_approval` = quality gate (creative director reviews AI output)
- Don't build a recipe visual editor in the ERP — the desktop app already has one

**Naming alignment**: Consider renaming one or both to avoid confusion:
- Option A: Canvas calls them "workflows", AGENTVBX calls them "recipes" (current state, good enough)
- Option B: Canvas calls them "automations", AGENTVBX calls them "recipes"
- Recommendation: **Keep current naming** — "workflow" and "recipe" are distinct enough. Just ensure UI and docs never use the terms interchangeably

---

## 4. Concrete Wiring Checklist

### Phase A: Foundation (Week 1-2)

- [ ] **OpenRouter adapter** — instantiate `OpenAIAdapter` with OpenRouter `baseUrl` + `OPENROUTER_API_KEY`, add to registry, set as default provider
- [ ] **OpenRouter cost rates** — add OpenRouter model pricing to `COST_RATES` in `packages/orchestrator/src/analytics/engine.ts`
- [ ] **Shared env config** — create `.env` template with `OPENROUTER_API_KEY`, `AGENT_BUILDER_URL`, `AGENT_BUILDER_WEBHOOK_SECRET`, `AGENTVBX_API_KEY`
- [ ] **Service auth middleware** — add Bearer token validation to AGENTVBX Express API for Agent Builder calls
- [ ] **Tenant sync** — Agent Builder POST to AGENTVBX `/api/tenants` on ERP org create/update. Modify `TenantManager.create()` to accept optional `id` param so ERP `orgId` IS the `tenant_id`
- [ ] **Callback endpoint** — wire AGENTVBX recipe/message completion to POST back to Agent Builder. Sign with HMAC-SHA256 using `AGENT_BUILDER_WEBHOOK_SECRET`

### Phase B: Communicate Channels (Week 2-3)

- [ ] **WhatsApp via Agent Builder** — Agent Builder calls AGENTVBX `/api/messages` with `channel: 'whatsapp'` for outbound. AGENTVBX POSTs inbound WhatsApp messages to Agent Builder callback
- [ ] **SMS notifications** — recipe step for SMS alerts via Telnyx (approval requests, delivery confirmations)
- [ ] **Voice → brief recipe** — voice note → transcription → extract requirements → Agent Builder → ERP brief creation
- [ ] **WhatsApp ↔ ERP sync** — wire AGENTVBX WhatsApp events to populate ERP's `WhatsAppConversation` and `WhatsAppMessage` Prisma models via Agent Builder

### Phase B.5: Canvas ↔ Recipe Alignment (Week 2-3)

- [ ] **Canvas `recipe` node type** — new node in ERP Canvas that calls AGENTVBX recipes via Agent Builder. Input/output mapping between Canvas context and recipe variables
- [ ] **Recipe execution status in Canvas** — Canvas `recipe` node shows progress (running/completed/failed) via Agent Builder → Pusher events
- [ ] **Guard rails** — ensure no `condition`/`delay`/`branch` step types get added to AGENTVBX recipes; ensure no `agent`/`artifact` node types get added to Canvas

### Phase C: Content Pipeline (Week 3-4)

- [ ] **Content generation recipe** — YAML recipe: research → write multi-platform posts → generate assets
- [ ] **ERP Publisher adapter** — implement `IntegrationAdapter` that POSTs draft content to ERP's Publisher API via Agent Builder callback
- [ ] **Artifact → Publisher bridge** — artifact delivery step creates Publisher drafts with platform-specific content (captions, hashtags, media)
- [ ] **WhatsApp notification** — notify content creators when drafts are ready for review

### Phase D: Desktop & Mobile (Week 4-5)

- [ ] **Desktop dual-API config** — add ERP API connection alongside AGENTVBX API in Tauri app
- [ ] **ERP views in desktop** — project dashboard, client list, communication hub views
- [ ] **Mobile PWA dual-API** — same pattern, ERP data + AGENTVBX channels in unified mobile interface
- [ ] **White-label per org** — apply ERP org branding via AGENTVBX white-label config
- [ ] **BYOA onboarding** — desktop app guides users through connecting ChatGPT/Claude/Gemini subscriptions

### Phase E: Deep Integration (Week 5-6)

- [ ] **Agent Builder → AGENTVBX recipe bridge** — Agent Builder dispatches recipe executions to AGENTVBX, receives results via callback
- [ ] **Realtime relay** — AGENTVBX WebSocket events → Agent Builder → Pusher for ERP UI updates
- [ ] **Streaming support** — add SSE streaming to AGENTVBX adapters so Agent Builder can stream AGENTVBX responses to ERP
- [ ] **Shared Google OAuth** — ERP stores tokens, AGENTVBX reads them via Agent Builder to access Drive/Calendar
- [ ] **Analytics rollup** — AGENTVBX usage data surfaced in ERP's analytics module via Agent Builder

### Phase F: Production Hardening (Week 6+)

- [ ] **Rate limiting** — sync tier limits with ERP subscription plans via Agent Builder
- [ ] **Analytics persistence** — SQLite or Postgres for AGENTVBX event storage
- [ ] **Error handling** — retry logic, circuit breakers on cross-service calls (AGENTVBX ↔ Agent Builder)
- [ ] **Monitoring** — health checks for all 3 services, alerting on failures
- [ ] **Security audit** — service-to-service auth, webhook signatures, encrypted credentials, CORS
- [ ] **JWT passthrough** — optional Supabase JWT validation for direct ERP → AGENTVBX calls (bypassing Agent Builder for latency-sensitive ops)

---

## 5. Key Files to Modify

### AGENTVBX
| File | Change |
|------|--------|
| `packages/providers/src/adapters/openai.ts` | Add OpenRouter headers (`HTTP-Referer`, `X-Title`) |
| `config/providers/registry.yaml` | Add `openrouter` provider entry |
| `packages/api/src/server.ts` | Add service auth middleware, Agent Builder callback route |
| `packages/orchestrator/src/tenant/manager.ts` | Accept optional `id` param in `create()` |
| `packages/orchestrator/src/types.ts` | Add `'erp'` to Channel type, add Agent Builder metadata |
| `packages/orchestrator/src/analytics/engine.ts` | Add OpenRouter cost rates |
| `packages/integrations/src/` | New `spokestack-publisher.ts` adapter |
| `config/recipes/` | New content-generation recipes |
| `packages/desktop/index.html` | Add ERP views, dual-API config |
| `packages/mobile/public/app.js` | Add ERP API connection |

### Agent Builder (separate repo — changes needed there)
| Change | Description |
|--------|-------------|
| AGENTVBX client module | Typed client for AGENTVBX REST API |
| Channel dispatch logic | Route WhatsApp/Voice/SMS requests to AGENTVBX |
| Callback handler | Receive AGENTVBX completion callbacks, relay to ERP |
| Event relay | Subscribe to AGENTVBX WebSocket, forward to Pusher |

### ERP (erp_staging_lmtd)
| File | Change |
|------|--------|
| `spokestack/src/app/api/agent-callback/route.ts` | Handle AGENTVBX results relayed through Agent Builder |
| `config/resources/integrations.resource.ts` | Add AGENTVBX as an integration (via Agent Builder) |
| Communicate module (stub → functional) | Wire UI to Agent Builder → AGENTVBX channel capabilities |

---

## 6. Verification

- [ ] OpenRouter adapter sends requests and gets responses (test with `anthropic/claude-sonnet-4`)
- [ ] ERP org creation → Agent Builder → AGENTVBX tenant auto-created
- [ ] Agent Builder dispatches WhatsApp message → AGENTVBX sends → delivery confirmed
- [ ] Voice call → AGENTVBX transcription → Agent Builder → ERP brief created
- [ ] Content recipe → artifacts → Agent Builder callback → ERP Publisher drafts
- [ ] Desktop app shows both ERP data and AGENTVBX channel/recipe features
- [ ] `npm test` passes (138 tests in AGENTVBX)
