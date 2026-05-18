# pi-auto-review

Automated project review for [Pi](https://pi.dev) — scans your codebase for problems, writes findings to `TODO.md`, and optionally auto-executes fixes.

## What It Does

1. **Scans** your project for issues: lint errors, type errors, failing tests, dead code, security problems, broken imports, TODO/FIXME comments, and more
2. **Writes** a prioritized `TODO.md` with clear, actionable items
3. **Optionally auto-fixes** — after building the todo list, tells the agent to go fix the problems

This is **not** for feature development. It's for finding and fixing what's broken.

## Install

```bash
pi install npm:pi-auto-review
# or from source
pi install /path/to/pi-auto-review
```

## Configuration

Add to `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "autoReview": {
    "todoPath": "TODO.md",
    "autoRun": false,
    "onSessionStart": false,
    "onDirty": false,
    "prompt": null,
    "scope": "full",
    "excludePatterns": ["node_modules", ".git", "dist", "build", "coverage"]
  }
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `todoPath` | `string` | `"TODO.md"` | Path to the todo file (relative to project root) |
| `autoRun` | `boolean` | `false` | After building the todo, tell the agent to go fix the problems |
| `onSessionStart` | `boolean` | `false` | Automatically run review when a session starts |
| `onDirty` | `boolean` | `false` | Automatically run review when uncommitted changes are detected |
| `prompt` | `string\|null` | `null` | Custom review prompt (overrides the default) |
| `scope` | `"full"\|"staged"\|"diff"` | `"full"` | Review scope — full project, staged changes only, or diff from main |
| `excludePatterns` | `string[]` | `["node_modules", ...]` | Directories to exclude from review |

## Commands

| Command | Description |
|---------|-------------|
| `/review` | Run a manual review now |
| `/review staged` | Review only staged changes |
| `/review diff` | Review diff from main branch |
| `/review fix` | Review and then auto-fix |

## How It Works

1. The extension checks configured trigger conditions
2. When triggered, it builds a review prompt and sends it as a user message
3. The agent loads the `auto-review` skill, which provides a detailed methodology
4. The agent scans the project, identifies problems, and writes/updates `TODO.md`
5. If `autoRun` is enabled, the agent then works through the todo items

## Custom Prompts

Set `autoReview.prompt` to override the default review message:

```json
{
  "autoReview": {
    "prompt": "Focus on TypeScript strict mode errors and security issues in the API routes. Update TODO.md with findings."
  }
}
```

## License

MIT
