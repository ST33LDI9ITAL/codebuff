# Standalone Codebuff Fork — Implementation Plan

> **Goal:** Strip the Codebuff CLI of all backend dependencies so it runs fully offline with DeepSeek routing using only your own API key.

**Architecture:** The CLI is a thin TUI wrapper around the SDK. The SDK does all the real work (agent reasoning, tool calls, file editing, LLM routing). The backend handles auth, usage tracking, analytics, agent publishing, and run storage — all non-essential. We stub the backend calls, keep the SDK and TUI fully intact, and compile a standalone binary.

**Tech Stack:** Bun, TypeScript, TypeScript source (no build step needed — `bun build --compile`)

**Key constraint:** Every change is in `cli/src/`. SDK and common packages stay untouched — they already work standalone with `DEEPSEEK_API_KEY`.

---

## File Surgery Map

The Critical Path (files that must be modified):

| # | File | What Changes | Why |
|---|------|-------------|-----|
| 1 | `cli/src/utils/auth.ts` | Replace `getConfigDir()` to use `~/.config/codebuff-local/`, add `getOrCreateLocalApiKey()` | Removes dependency on `NEXT_PUBLIC_CB_ENVIRONMENT` env var, provides a stable local-only creds path |
| 2 | `cli/src/utils/codebuff-api.ts` | Replace the `request()` function body with a local-only stub | All 7 endpoint methods return plausible fake data instead of hitting the network |
| 3 | `cli/src/utils/codebuff-client.ts` | Change API key resolution to use `DEEPSEEK_API_KEY` as the SDK apiKey | SDK's `CodebuffClient(apiKey)` needs a non-null string to construct, but never actually sends it when DeepSeek routing is active |
| 4 | `cli/src/utils/analytics.ts` | No-op the entire module | PostHog calls are non-critical, silently fail in dev anyway |
| 5 | `cli/src/hooks/use-auth-query.ts` | Bypass the backend validation, always return "valid" | Auth validation hits `GET /api/v1/me` — pointless when we don't have a backend |
| 6 | `cli/src/hooks/use-usage-query.ts` | Return canned data (infinite credits) | Usage polling hits `POST /api/v1/usage` |
| 7 | `cli/src/hooks/use-subscription-query.ts` | Return canned data (subscribed) | Subscription polling hits `GET /api/user/subscription` |
| 8 | `cli/src/init/init-app.ts` | Remove analytics initialization | Calls `initAnalytics()` which needs PostHog env vars |
| 9 | `cli/src/hooks/use-connection-status.ts` | Always return connected | Pings the backend health endpoint |
| 10 | `cli/src/index.tsx` | Remove `login` command handler, skip auth token setup | Entry point — the login escape hatch is dead code now |
| 11 | `cli/src/app.tsx` | Render directly to chat instead of login modal | The `App` component conditionally shows login or chat |
| 12 | SDk: `sdk/src/impl/model-provider.ts` | Already done — DeepSeek routing via `DEEPSEEK_API_KEY` | No changes needed, the code already exists |

Files that can be left alone (the SDK doesn't care about backend):
- `sdk/src/impl/run.ts` — agent runtime
- `sdk/src/impl/llm.ts` — LLM prompt/stream handling
- `sdk/src/agents/load-agents.ts` — local agent loading
- All TUI components in `cli/src/components/`
- All utility modules with no backend deps (listed in analysis)

---

## Implementation Steps

### Phase 1: Auth Bypass (the critical one)

The CLI's entry point (`index.tsx`) calls `getAuthToken()` from `auth.ts`. If it returns undefined, the TUI shows the login modal. If it returns a value, the TUI validates it against the backend. Both paths need surgery.

**Step 1:** In `auth.ts`, add a `getOrCreateLocalApiKey()` function that:
- Reads `DEEPSEEK_API_KEY` env var
- If not set, generates a random UUID and stores it at `~/.config/codebuff-local/api-key`
- Returns this as the auth token

This gives the SDK a stable, non-null apiKey for construction while never hitting the backend.

**Step 2:** Change `getAuthToken()` to call `getOrCreateLocalApiKey()` instead of reading `credentials.json`. Remove `getConfigDir()` dependency on `NEXT_PUBLIC_CB_ENVIRONMENT`.

### Phase 2: API Client Stub

**Step 3:** In `codebuff-api.ts`, replace the `request()` function body. The interface stays the same but instead of HTTP calls, return canned responses:

```typescript
// me endpoint — return a fake user so auth validation passes
{ ok: true, status: 200, data: { id: 'local', email: 'local@dev', name: 'Local User' } }

// usage endpoint — infinite credits
{ ok: true, status: 200, data: { usage: 0, remainingBalance: 999999, ... } }

// subscription endpoint — active subscription
{ ok: true, status: 200, data: { active: true, plan: 'pro' } }

// login endpoints — deprecated, shouldn't be called
{ ok: false, status: 404, error: 'Login not available in offline mode' }

// logout endpoint — no-op
{ ok: true, status: 200 }

// publish endpoint — no-op
{ ok: true, status: 200, data: { published: [] } }

// feedback endpoint — no-op
{ ok: true, status: 200 }
```

### Phase 3: Hook Bypasses

**Step 4:** In `use-auth-query.ts`, gut the `useAuthQuery` hook. Instead of polling `GET /api/v1/me`, immediately return a hardcoded valid user state. This prevents the login modal from rendering.

**Step 5:** In `use-usage-query.ts`, return canned data with infinite credits.

**Step 6:** In `use-subscription-query.ts`, return canned data indicating an active subscription.

**Step 7:** In `use-connection-status.ts`, always return `connected`.

### Phase 4: Entry Point Cleanup

**Step 8:** In `init-app.ts`, remove the `initAnalytics()` call and the analytics-related setup.

**Step 9:** In `index.tsx`, remove the `login` command handler and the `setApiClientAuthToken()` call. The CLI should skip auth setup entirely and go straight to the chat view.

**Step 10:** In `app.tsx`, remove the `if (!user) return <LoginModal>` conditional. Always render the chat view. The `user` state should be pre-populated from the stub.

### Phase 5: Build and Test

**Step 11:** Compile standalone binary:

```bash
cd cli && bun build --compile --target=bun-linux-arm64 ./src/index.tsx --outfile=codebuff-local
```

Or for macOS:
```bash
cd cli && bun build --compile --target=bun-darwin-arm64 ./src/index.tsx --outfile=codebuff-local
```

**Step 12:** Test with:
```bash
DEEPSEEK_API_KEY=sk-your-key ./codebuff-local --cwd /some/test-project
```

---

## Risk Areas

1. **DeepSeek routing must be active** for the SDK to work without a backend. If `DEEPSEEK_API_KEY` is not set, `getModelForRequest()` falls through to `createCodebuffBackendModel()` which tries to hit the backend API. **The binary is unusable without `DEEPSEEK_API_KEY`.**

2. **Agent runtime writes to backend** in `sdk/src/impl/database.ts` — `startAgentRun()`, `finishAgentRun()`, `addAgentStep()` are called during every agent run. These will throw network errors if the backend is unreachable. These need to be stubbed too, but they're in the SDK (not the CLI). Surgery options:
   a. Wrap each call in try/catch (minimal, errors are swallowed)
   b. Replace the `database` module implementation (cleaner but more invasive)
   
3. **The `WEBSITE_URL` constant** in `sdk/src/constants.ts` reads from `@codebuff/common/env`. The env module validates `NEXT_PUBLIC_CB_ENVIRONMENT` at import time. The `.env.local` file handles this, but the binary needs to either bundle the env or skip the validation.

4. **Login flow dead code** — the `login-modal.tsx` component and login-flows are still compiled in but never reached. They won't cause errors if the `user` state is always pre-populated.

---

## Files Modified

| File | Changes |
|------|---------|
| `cli/src/utils/auth.ts` | ~10 lines — add `getOrCreateLocalApiKey()`, change `getAuthToken()`, remove `getConfigDir()` env dependency |
| `cli/src/utils/codebuff-api.ts` | ~15 lines — stub `request()` body |
| `cli/src/utils/codebuff-client.ts` | ~2 lines — change apiKey resolution |
| `cli/src/utils/analytics.ts` | ~5 lines — no-op `initAnalytics()`, `trackEvent()` |
| `cli/src/hooks/use-auth-query.ts` | ~10 lines — return hardcoded valid user |
| `cli/src/hooks/use-usage-query.ts` | ~8 lines — return canned unlimited credits |
| `cli/src/hooks/use-subscription-query.ts` | ~8 lines — return active subscription |
| `cli/src/hooks/use-connection-status.ts` | ~3 lines — always connected |
| `cli/src/init/init-app.ts` | ~2 lines — remove analytics init |
| `cli/src/index.tsx` | ~5 lines — remove login command handler, skip auth setup |
| `cli/src/app.tsx` | ~3 lines — skip login modal, always render chat |
| `sdk/src/impl/database.ts` | ~15 lines — wrap run start/finish/step in try/catch |

**Total: ~86 lines changed across 12 files.**
