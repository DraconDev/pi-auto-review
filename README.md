# pi-auto-review

Event-driven project review for [Pi](https://pi.dev) — automatically scans for problems after work completes, writes findings to `TODO.md`, and optionally auto-fixes them.

## The Point

This isn't `/review` that you remember to run. It **fires automatically** when work finishes — after a Ralph loop completes, after the agent finishes a long session, or on session start. It finds what's broken and writes it to `TODO.md`. Strictly fixes, not features.

## Install

```bash
pi install /path/to/pi-auto-review
# or publish to npm first:
pi install npm:pi-auto-review
```

## How It Works

```
Ralph loop done → 🔍 auto-review → 📝 TODO.md → 🔧 auto-fix (optional) → ✅ verify (default)
```

1. **Work completes** (Ralph loop done, agent finishes, session starts)
2. **Review triggers automatically** — scans the project for problems
3. **TODO.md gets updated** with prioritized fix items
4. **Optionally auto-fixes** — if `autoFix: true`, the agent fixes the problems
5. **Verification pass** — if `verify: true` (default), confirms the fixes actually worked

### The cycle never loops

```
IDLE → REVIEWING → FIXING → VERIFYING → IDLE
```

Only real work (not review/fix/verify) can start a new cycle. No infinite loops.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `onRalphDone` | `true` | Auto-review when a Ralph loop completes |
| `onAgentEnd` | `false` | Auto-review after any agent finishes (after `minTurns`) |
| `onSessionStart` | `false` | Auto-review when a session starts |
| `/review` | always | Manual trigger anytime |

The primary use case: **`onRalphDone: true`** (the default). After a Ralph loop finishes pushing features, auto-review catches what got broken and writes fix items to `TODO.md`.

## Configuration

Add to `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "autoReview": {
    "todoPath": "TODO.md",
    "autoFix": false,
    "verify": true,
    "onRalphDone": true,
    "onAgentEnd": false,
    "onSessionStart": false,
    "minTurns": 3,
    "cooldownMs": 120000,
    "prompt": null,
    "scope": "full",
    "excludePatterns": ["node_modules", ".git", "dist", "build", "coverage"]
  }
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `todoPath` | `string` | `"TODO.md"` | Path to the todo file |
| `autoFix` | `boolean` | `false` | After building the todo, go fix the problems |
| `verify` | `boolean` | `true` | After auto-fix, run a verification pass |
| `onRalphDone` | `boolean` | `true` | Auto-review when Ralph loop completes |
| `onAgentEnd` | `boolean` | `false` | Auto-review after agent finishes |
| `onSessionStart` | `boolean` | `false` | Auto-review on session start |
| `minTurns` | `number` | `3` | Minimum turns before `onAgentEnd` fires |
| `cooldownMs` | `number` | `120000` | Minimum ms between auto-reviews (prevents spam) |
| `prompt` | `string\|null` | `null` | Custom review prompt (overrides default) |
| `scope` | `"full"\|"staged"\|"diff"` | `"full"` | Review scope |
| `excludePatterns` | `string[]` | `["node_modules", ...]` | Directories to skip |

## Manual Commands

| Command | Description |
|---------|-------------|
| `/review` | Full project review → writes TODO.md |
| `/review staged` | Review only staged changes |
| `/review diff` | Review diff from main branch |
| `/review fix` | Review and then auto-fix the problems |
| `/review verify` | Run verification pass on existing TODO.md fixes |

## Fix-Only Philosophy

Auto-review finds **what's broken**, not what's missing:
- ✅ Build errors, type errors, lint failures
- ✅ Failing tests, missing tests
- ✅ Security vulnerabilities, hardcoded secrets
- ✅ Broken imports, dead code
- ✅ FIXME/HACK markers (bugs, not ideas)
- ✅ Debug leftovers (console.log in prod)
- ❌ Feature requests ("add dark mode")
- ❌ Architecture proposals ("should use microservices")
- ❌ Nice-to-haves ("consider using X pattern")
- ❌ TODOs that are feature ideas, not bugs

## Custom Prompts

Override the default review prompt:

```json
{
  "autoReview": {
    "prompt": "Focus on TypeScript strict mode errors and security issues in the API routes. Update TODO.md with findings."
  }
}
```

## Cooldown

Auto-reviews have a 2-minute cooldown by default (`cooldownMs: 120000`). This prevents review spam when multiple events fire close together (e.g., Ralph completes → agent_end fires right after).

## License

MIT
