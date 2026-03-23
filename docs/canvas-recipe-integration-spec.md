# Canvas ↔ Recipe Node Integration — Technical Spec

> Phase B.5 deliverable. Defines the contract, types, execution model, error handling, and UI for the `recipe` node type in ERP Canvas that bridges to AGENTVBX recipe execution.

---

## 1. Architecture Overview

```
ERP Canvas (DAG)                    Agent Builder                    AGENTVBX
┌──────────────┐                   ┌──────────────┐               ┌──────────────┐
│              │                   │              │               │              │
│  ... nodes   │                   │              │               │              │
│      │       │                   │              │               │              │
│  ┌───▼───┐   │   POST /execute   │   POST /api  │  POST /api/  │              │
│  │recipe │───┼──────────────────→│  /agentvbx/  │──recipes/    │  RecipeEngine│
│  │ node  │   │                   │  recipes/    │  :name/      │  .execute()  │
│  └───┬───┘   │                   │  execute     │  execute     │              │
│      │       │                   │              │               │              │
│  ... nodes   │   Pusher event    │   WS → Push  │  WS event    │              │
│      ▲       │←──────────────────│←─────────────│←─────────────│  completion  │
│      │       │   recipe:done     │   relay      │  recipe:     │  callback    │
│  (resume)    │                   │              │  completed   │              │
│              │                   │              │               │              │
└──────────────┘                   └──────────────┘               └──────────────┘
```

**Key principle**: Canvas owns the *when* and *why* (conditions, branching, business approvals). Recipes own the *what* and *how* (agent chains, artifact delivery, AI quality gates). The recipe node is a thin bridge — it maps context in, fires the recipe, waits, and maps outputs back.

---

## 2. Data Contract

### 2a. Recipe Node Definition (ERP Canvas side)

```typescript
// New node type in ERP's WfCanvas schema
interface RecipeNode {
  type: 'recipe';

  // Which recipe to execute
  recipe_name: string;

  // Map Canvas workflow variables → recipe input keys
  // Keys are recipe input variable names, values are Canvas context expressions
  input_mapping: Record<string, string>;

  // Map recipe output keys → Canvas workflow variables
  // Keys are Canvas context variable names, values are recipe output keys
  output_mapping: Record<string, string>;

  // Max time to wait for recipe completion (ms). Default: 300000 (5 min)
  timeout_ms: number;

  // What to do when the recipe fails
  failure_policy: FailurePolicy;
}

interface FailurePolicy {
  action: 'halt' | 'skip' | 'retry';

  // For 'retry': max attempts before halting. Default: 1 (no retry)
  max_retries?: number;

  // For 'retry': delay between attempts (ms). Default: 5000
  retry_delay_ms?: number;

  // For 'skip': optional fallback value injected into Canvas context
  fallback_outputs?: Record<string, unknown>;
}
```

### 2b. Execution Request (Agent Builder → AGENTVBX)

Agent Builder translates the Canvas recipe node into an AGENTVBX API call:

```typescript
// POST /api/recipes/:name/execute
interface RecipeExecuteRequest {
  tenant_id: string;           // ERP orgId (= AGENTVBX tenant_id)
  number_id: string;           // Default: 'default'
  input: Record<string, unknown>;  // Mapped from Canvas context via input_mapping

  // New fields for Canvas integration:
  callback_url?: string;       // Agent Builder URL to POST completion to
  correlation_id?: string;     // Canvas execution ID + node ID for matching
  triggered_by_canvas?: {
    workflow_id: string;
    workflow_name: string;
    node_id: string;
    execution_id: string;
  };
}
```

### 2c. Execution Response (AGENTVBX → Agent Builder → Canvas)

**Immediate response** (HTTP 202):
```typescript
interface RecipeExecuteResponse {
  execution_id: string;
  message_id?: string;
}
```

**Completion callback** (POST to `callback_url`):
```typescript
interface RecipeCompletionCallback {
  correlation_id: string;
  execution_id: string;
  recipe_name: string;
  status: 'completed' | 'failed' | 'cancelled';

  // Outputs: the recipe execution context (all step outputs)
  outputs: Record<string, unknown>;

  // Artifacts generated during execution
  artifacts: ArtifactSummary[];

  // Timing
  started_at: string;
  completed_at: string;
  duration_ms: number;

  // On failure: which step failed and why
  error?: {
    step_name: string;
    message: string;
    provider_used?: string;
  };

  // Step-level detail (for observability, not required for Canvas flow)
  steps: StepSummary[];
}

interface ArtifactSummary {
  id: string;
  filename: string;
  file_type: string;
  cloud_url?: string;
  preview_url?: string;
  size_bytes: number;
}

interface StepSummary {
  step_name: string;
  status: 'completed' | 'failed' | 'skipped';
  duration_ms: number;
  provider_used?: string;
}
```

### 2d. Canvas Context Mapping Examples

```
Canvas context before recipe node:
{
  client_id: "client-456",
  project_id: "proj-789",
  brief_text: "Write a blog post about sustainable packaging",
  brand_guidelines_url: "https://drive.google.com/..."
}

Recipe node config:
{
  recipe_name: "research-and-deliver",
  input_mapping: {
    "topic": "brief_text",             // recipe sees: topic = "Write a blog post..."
    "brand_url": "brand_guidelines_url" // recipe sees: brand_url = "https://drive..."
  },
  output_mapping: {
    "generated_report": "report",       // Canvas gets: generated_report = recipe's "report" output
    "drive_artifact": "artifact"        // Canvas gets: drive_artifact = recipe's "artifact" output
  }
}

Canvas context after recipe node:
{
  client_id: "client-456",
  project_id: "proj-789",
  brief_text: "Write a blog post about sustainable packaging",
  brand_guidelines_url: "https://drive.google.com/...",
  generated_report: { text: "...", provider: "openrouter", tokens_used: 2400 },
  drive_artifact: { artifact_id: "art-001", cloud_url: "https://drive.google.com/..." }
}
```

---

## 3. Error Handling Across the Boundary

### 3a. Failure Scenarios

| Scenario | Who detects | Canvas behavior |
|----------|------------|-----------------|
| AGENTVBX unreachable | Agent Builder | Apply `failure_policy` (halt/skip/retry) |
| Recipe not found (404) | AGENTVBX | Immediate fail → `failure_policy` |
| Recipe step fails mid-execution | AGENTVBX | Callback with `status: 'failed'` + `error` → `failure_policy` |
| Recipe paused on `human_approval` gate | AGENTVBX | Canvas sees recipe as still running. No timeout until `timeout_ms` expires |
| Timeout exceeded | Agent Builder | Cancel recipe via `DELETE /api/recipes/executions/:id`, mark node as failed → `failure_policy` |
| Callback delivery fails | Agent Builder | Retry callback 3x with backoff. After 3 failures, poll `GET /api/recipes/executions/:id` as fallback |

### 3b. Timeout and Human Gates

A recipe containing `gate: human_approval` may pause for hours waiting for creative review. Canvas must account for this:

```typescript
// Recipe node config for recipes with known human gates
{
  recipe_name: "content-with-review",
  timeout_ms: 86400000,  // 24 hours — recipe has a human gate
  failure_policy: { action: 'halt' }
}
```

**Visibility rule**: While a recipe is paused on a human gate, the Canvas node shows status `waiting` (not `running`). Agent Builder relays the `recipe:paused` WebSocket event via Pusher so the Canvas UI updates.

### 3c. Recipe Execution States → Canvas Node States

| Recipe `status` | Canvas node display | Canvas behavior |
|----------------|--------------------|--------------------|
| `running` | Spinner + "Running recipe..." | Wait |
| `paused` | Pause icon + "Waiting for approval inside recipe" | Wait (separate from Canvas human nodes) |
| `completed` | Green check + duration | Extract outputs via `output_mapping`, resume DAG |
| `failed` | Red X + error message | Apply `failure_policy` |
| `cancelled` | Grey X + "Cancelled" | Apply `failure_policy` (treat as failure) |

---

## 4. Recipe Gate vs Canvas Human Node — Disambiguation

These are two distinct pause mechanisms with different owners and semantics:

| | Recipe `gate: human_approval` | Canvas `human` node |
|---|---|---|
| **Owner** | AGENTVBX (recipe engine) | ERP (Canvas engine) |
| **Pause state lives in** | `RecipeExecution.status = 'paused'` | Canvas execution state (Prisma) |
| **Who approves** | Content reviewer (via AGENTVBX desktop/mobile/WhatsApp) | Business stakeholder (via ERP UI) |
| **Purpose** | Quality gate — "is this AI output good enough?" | Business gate — "should we proceed with this spend/action?" |
| **Canvas visibility** | Canvas only sees recipe node as "waiting" | Canvas shows dedicated approval UI with assignee |
| **Timeout** | Part of recipe node's `timeout_ms` | Part of Canvas workflow's own timeout rules |

**Example workflow combining both**:
```
Canvas:
  [trigger] → [recipe: generate-proposal] → [human: manager-approval] → [recipe: deliver-to-client]
                    │                              │
                    └─ recipe internally has        └─ Canvas human node:
                       gate: human_approval            "Manager, approve this
                       for creative review             $15k proposal?"
```

The creative review happens *inside* the first recipe (invisible to Canvas). The business approval happens *in Canvas* (invisible to the recipe). Neither system knows about the other's pause mechanism — they don't need to.

---

## 5. Tenant Scoping and Security

### 5a. Credential Isolation

Recipes published to the marketplace are **pure logic** — they contain no credentials, no tenant-specific data:

```yaml
# What gets published to marketplace:
name: research-and-deliver
steps:
  - name: research
    type: agent
    agent: researcher          # ← agent name, not API key
    input: topic
    output: research_notes
  - name: save
    type: artifact_delivery
    input: research_notes
    output: artifact
    params:
      destination: google_drive  # ← destination type, not OAuth token
```

**At execution time**, AGENTVBX injects:
- **Provider credentials** from tenant config (API keys, OAuth tokens)
- **Tenant context** (`tenant_id`, `number_id`) from the execution request
- **Integration auth** from `TenantConfig.integrations[]`

Canvas passes `tenant_id` (= ERP `orgId`) in the execution request. AGENTVBX resolves all credentials from that tenant's config. No cross-tenant data leakage is possible because:
1. `RecipeExecution.tenant_id` scopes all adapter calls
2. `TenantManager` enforces tenant isolation on config access
3. Artifact paths are tenant-scoped: `tenants/{tenant_id}/artifacts/`

### 5b. Agent Builder as Auth Boundary

Canvas never calls AGENTVBX directly. Agent Builder mediates:

```
Canvas → Agent Builder (Supabase JWT validated) → AGENTVBX (service Bearer token)
```

- Agent Builder verifies the ERP user has permission to run recipes for that org
- Agent Builder adds `tenant_id` from the authenticated org context
- AGENTVBX trusts Agent Builder's tenant assertion (service-to-service auth)

---

## 6. Canvas UI — Recipe Node Configuration

### 6a. Node Picker

When the user drags a **Recipe** node onto the Canvas:

1. **Recipe selector dropdown** — shows available recipes:
   - Source: Agent Builder calls `GET /api/recipes` on AGENTVBX (filtered by tenant's installed recipes)
   - Groups: "Custom" (tenant-created), "Installed" (from marketplace), "Marketplace" (browse/install inline)
   - Each entry shows: name, description, step count, required tools badges

2. **Input mapping panel** — after selecting a recipe:
   - Left column: recipe's expected input keys (extracted from first step's `input` field and any `params` references)
   - Right column: dropdown of available Canvas context variables (from upstream node outputs)
   - Auto-map by name match (e.g., Canvas var `topic` auto-maps to recipe input `topic`)

3. **Output mapping panel**:
   - Left column: Canvas variable name (user-defined, or auto-suggested from recipe output keys)
   - Right column: recipe step output keys (from each step's `output` field)
   - Artifacts section: checkbox to "capture artifacts as Canvas attachments"

4. **Failure policy selector**:
   - Radio: Halt workflow / Skip this node / Retry
   - If retry: max retries (1-5), delay between retries
   - If skip: optional fallback output values

5. **Timeout setting**:
   - Default: 5 minutes
   - Warning banner if selected recipe contains `gate: human_approval` steps: "This recipe requires human review. Consider increasing the timeout."

### 6b. Runtime Display

While the recipe node is executing:
- **Progress bar** — shows `step N of M` (from `RecipeExecution.steps[]`)
- **Current step name** — e.g., "Running: research" → "Running: write_report"
- **Elapsed time** — live counter
- **Status badge** — Running / Waiting for approval / Completed / Failed

This data comes from AGENTVBX WebSocket events, relayed through Agent Builder → Pusher:
- `recipe:step:started` → update current step display
- `recipe:step:completed` → increment progress
- `recipe:paused` → show "Waiting for approval" badge
- `recipe:completed` → green check, show duration
- `recipe:failed` → red X, show error from failed step

### 6c. Recipe Input Discovery

To populate the input mapping UI, Agent Builder needs to know what inputs a recipe expects. AGENTVBX exposes this via an enriched recipe listing:

```typescript
// GET /api/recipes/:name response (enriched)
interface RecipeDetail {
  name: string;
  description: string;
  trigger?: RecipeTrigger;
  steps: RecipeStep[];

  // New: computed metadata for Canvas integration
  expected_inputs: string[];    // Input keys the recipe needs (from step inputs not produced by earlier steps)
  produced_outputs: string[];   // Output keys from all steps
  has_human_gates: boolean;     // True if any step has gate: human_approval
  estimated_duration_ms?: number; // Average from past executions (if available)
}
```

`expected_inputs` is computed by the recipe engine:
```typescript
function computeExpectedInputs(recipe: Recipe): string[] {
  const produced = new Set<string>();
  const needed = new Set<string>();

  for (const step of recipe.steps) {
    const inputs = Array.isArray(step.input) ? step.input : [step.input];
    for (const inp of inputs) {
      if (!produced.has(inp)) needed.add(inp);
    }
    produced.add(step.output);
  }

  return Array.from(needed);
}
```

---

## 7. WebSocket Events (New)

AGENTVBX broadcasts these events for Canvas observability:

| Event | Payload | When |
|-------|---------|------|
| `recipe:step:started` | `{ execution_id, step_name, step_index, total_steps }` | Step begins execution |
| `recipe:step:completed` | `{ execution_id, step_name, step_index, status, duration_ms, provider_used }` | Step finishes |
| `recipe:paused` | `{ execution_id, step_name, reason: 'human_approval' }` | Recipe hits a gate |
| `recipe:resumed` | `{ execution_id, step_name }` | Gate approved, execution continues |
| `recipe:completed` | `{ execution_id, recipe_name, duration_ms, outputs, artifacts }` | All steps done |
| `recipe:failed` | `{ execution_id, recipe_name, step_name, error }` | Step failed, execution stopped |

Agent Builder subscribes to AGENTVBX WebSocket, filters by `correlation_id` (Canvas execution + node), and re-emits via Pusher to the ERP Canvas UI.

---

## 8. AGENTVBX Changes Required

### 8a. Types (`packages/orchestrator/src/types.ts`)

Add Canvas trigger metadata to `RecipeTrigger`:

```typescript
export interface RecipeTrigger {
  type: 'manual' | 'schedule' | 'platform_event' | 'voice_note' | 'message' | 'canvas';
  // ... existing fields ...
  canvas?: {
    workflow_id: string;
    workflow_name: string;
    node_id: string;
    execution_id: string;
  };
}
```

### 8b. Recipe Engine (`packages/orchestrator/src/recipe/engine.ts`)

1. **Emit step-level WebSocket events** — broadcast `recipe:step:started` and `recipe:step:completed` for each step
2. **Support `callback_url`** — on execution complete/fail, POST `RecipeCompletionCallback` to the provided URL
3. **Expose `computeExpectedInputs()`** — static method for the API to call when returning recipe details
4. **Store `correlation_id`** on `RecipeExecution` for Canvas matching

### 8c. API (`packages/api/src/server.ts`)

1. **Enrich `GET /api/recipes/:name`** — include `expected_inputs`, `produced_outputs`, `has_human_gates`
2. **Accept `callback_url` and `correlation_id`** in `POST /api/recipes/:name/execute`
3. **Broadcast step-level events** — wire engine events to WebSocket broadcast

### 8d. Completion Callback (`packages/orchestrator/src/recipe/callback.ts` — new)

```typescript
export class RecipeCallbackHandler {
  async sendCompletion(
    execution: RecipeExecution,
    callbackUrl: string,
    correlationId: string,
  ): Promise<void> {
    const payload: RecipeCompletionCallback = {
      correlation_id: correlationId,
      execution_id: execution.id,
      recipe_name: execution.recipe_name,
      status: execution.status as 'completed' | 'failed' | 'cancelled',
      outputs: execution.context,
      artifacts: this.extractArtifacts(execution),
      started_at: execution.started_at,
      completed_at: execution.completed_at!,
      duration_ms: /* computed */,
      steps: execution.steps.map(s => ({
        step_name: s.step_name,
        status: s.status as 'completed' | 'failed' | 'skipped',
        duration_ms: s.duration_ms,
        provider_used: s.provider_used,
      })),
    };

    // HMAC-SHA256 signed POST
    await this.signedPost(callbackUrl, payload);
  }
}
```

---

## 9. What This Spec Does NOT Cover

Explicitly out of scope to maintain separation of concerns:

- **Condition/branch logic in recipes** — Canvas owns this
- **Agent step types in Canvas** — recipes own this
- **Recipe visual editor in ERP** — the desktop app already has one
- **Direct ERP → AGENTVBX calls** — always goes through Agent Builder
- **Streaming recipe step outputs** — Phase E work (batch responses for now)
- **Recipe creation from Canvas** — users create recipes in AGENTVBX desktop/mobile, then reference them in Canvas

---

## 10. Verification Checklist

- [ ] Canvas recipe node calls AGENTVBX via Agent Builder, receives `execution_id`
- [ ] Recipe executes all steps, completion callback reaches Agent Builder → Canvas
- [ ] Canvas extracts outputs via `output_mapping`, downstream nodes receive data
- [ ] Recipe failure triggers `failure_policy` (halt/skip/retry all work)
- [ ] Recipe with `gate: human_approval` shows "Waiting for approval" in Canvas UI
- [ ] Timeout cancels recipe and applies `failure_policy`
- [ ] Recipe selector shows installed + marketplace recipes with input/output metadata
- [ ] Input auto-mapping works for matching variable names
- [ ] Step-level progress updates flow: AGENTVBX WS → Agent Builder → Pusher → Canvas UI
- [ ] Tenant credentials are never included in marketplace recipe definitions
- [ ] Cross-tenant recipe execution is blocked by tenant_id scoping
- [ ] `npm test` passes after all changes (existing 138 tests + new tests)
