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
Ralph loop done → 🔍 review → 📝 TODO.md → 🔧 fix → 🔍 re-review → 🔧 fix → 🔍 re-review (clean) → ✅
```

1. **Work completes** (Ralph loop done, agent finishes, session starts)
2. **Review triggers automatically** — scans for problems, writes TODO.md
3. **If `autoFix: true`** — agent fixes items, then re-reviews
4. **Fix loop continues** until project is clean or max rounds hit
5. **Convergence check** — if fixes cause MORE problems, bail immediately

### The fix loop is bounded

```
round 1: 8 items found → fix → round 2: 3 items → fix → round 3: 0 items → ✅ clean
round 1: 5 items → fix → round 2: 7 items → ⚠️ diverging, bail
```

- **maxFixRounds** (default 3) — hard cap
- **Divergence detection** — if a re-review finds MORE items than before, stops immediately
- **Clean exit** — 0 items → done right away

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
    "maxFixRounds": 3,
    "onRalphDone": true,
    "onAgentEnd": false,
    "onSessionStart": false,
    "minTurns": 3,
    "cooldownMs": 120000,
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
| `maxFixRounds` | `number` | `3` | Max review→fix→re-review loops |
| `onRalphDone` | `boolean` | `true` | Auto-review when Ralph loop completes |
| `onAgentEnd` | `boolean` | `false` | Auto-review after agent finishes |
| `onSessionStart` | `boolean` | `false` | Auto-review on session start |
| `minTurns` | `number` | `3` | Minimum turns before `onAgentEnd` fires |
| `cooldownMs` | `number` | `120000` | Minimum ms between auto-reviews (prevents spam) |
| `scope` | `"full"\|"staged"\|"diff"` | `"full"` | Review scope |
| `excludePatterns` | `string[]` | `["node_modules", ...]` | Directories to skip |
| `prompt` | `string\|null` | `null` | Custom first-review prompt (replaces default) |
| `rereviewPrompt` | `string\|null` | `null` | Custom re-review prompt in fix loop. Supports `{round}`, `{maxRounds}`, `{previousItems}`, `{focusAreas}` placeholders |
| `fixInstruction` | `string\|null` | `null` | Custom instruction appended when autoFix is on |
| `focusAreas` | `string[]\|null` | `null` | Override default list of things to look for |

## Manual Commands

| Command | Description |
|---------|-------------|
| `/review` | Full project review → writes TODO.md |
| `/review staged` | Review only staged changes |
| `/review diff` | Review diff from main branch |
| `/review fix` | Review and auto-fix in a loop until clean |
| `/review stop` | Stop any in-progress fix loop |

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

All prompts are customizable. Use `null` or omit to keep defaults.

```json
{
  "autoReview": {
    "prompt": "Focus on TypeScript strict mode errors and security issues in the API routes. Update TODO.md with findings.",
    "rereviewPrompt": "Check round {round}/{maxRounds}. Previously found {previousItems} issues. Re-scan for remaining problems.",
    "fixInstruction": "Fix each item, then run the test suite to verify.",
    "focusAreas": [
      "Type errors in src/api/",
      "Security issues (hardcoded secrets, eval usage)",
      "Failing tests"
    ]
  }
}
```

### rereviewPrompt placeholders

| Placeholder | Replaced with |
|-------------|-------------|
| `{round}` | Current fix loop round (1, 2, 3...) |
| `{maxRounds}` | `maxFixRounds` setting |
| `{previousItems}` | Items found in previous round |
| `{focusAreas}` | Resolved focus areas list (only if custom `focusAreas` is set) |

## Customizing Focus Areas

The default focus areas (when `focusAreas` is not set):

- Lint errors, type errors, build failures
- Failing or missing tests
- Security vulnerabilities
- Broken imports or missing dependencies
- Dead code, unreachable branches
- TODO/FIXME/HACK comments that indicate known BUGS (not feature ideas)
- Inconsistencies between code and config
- Performance problems that are bugs (N+1 queries, memory leaks)

Override with `focusAreas: [...]` in settings.

## Cooldown

Auto-reviews have a 2-minute cooldown by default (`cooldownMs: 120000`). This prevents review spam when multiple events fire close together (e.g., Ralph completes → agent_end fires right after).

## `.pi/settings.json` — Git Strategy

The `.pi/settings.json` file contains review configuration. It can be committed to share team settings, or kept local-only. If you want it local-only, add to `.gitignore`:

```
TODO.md
.pi/settings.json
```

## License

MIT