---
name: auto-review
description: Automated fix-only project review. Triggers automatically after Ralph loop completion, agent work, or session start. Scans for problems (NOT features), writes prioritized findings to TODO.md, and optionally auto-fixes.
---

# Auto Review

## Overview

You are performing a **fix-only** project review triggered automatically after work completes. Your goal is to find **problems that need fixing** — broken things, not missing things. Do NOT propose features, architectural changes, or improvements.

**What goes in TODO.md:** Bugs, errors, security issues, broken code.
**What does NOT go in TODO.md:** Feature ideas, "nice to have" refactors, architecture proposals.

## Step 1: Quick Reconnaissance

Get the lay of the land before diving in:

```bash
# Project type
cat package.json 2>/dev/null || cat Cargo.toml 2>/dev/null || cat pyproject.toml 2>/dev/null || cat go.mod 2>/dev/null

# File structure (respect exclude patterns)
find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/coverage/*' -not -path '*/vendor/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' -not -path '*/target/*' | head -200
```

Identify: language, framework, test suite presence, CI config, linting setup.

## Step 2: Build & Type Check

Run whatever the project supports:

```bash
# Node/TypeScript
npm run build 2>&1 | tail -50
npx tsc --noEmit 2>&1 | tail -50
npm run lint 2>&1 | tail -50

# Python
ruff check . 2>&1 | tail -50

# Rust
cargo check 2>&1 | tail -50
cargo clippy 2>&1 | tail -50

# Go
go build ./... 2>&1 | tail -50
go vet ./... 2>&1 | tail -50
```

**Build errors and type errors are 🔴 items.** Lint warnings are 🟡.

## Step 3: Test Suite

```bash
npm test 2>&1 | tail -50
# or: pytest, cargo test, go test ./...
```

**Failing tests are 🔴.** No tests at all is 🟡.

## Step 4: Bug-Marker Scan

Search for markers that indicate known problems (NOT feature requests):

```bash
# FIXME and HACK are bugs — TODO might or might not be
grep -rn "FIXME\|HACK\|XXX\|WORKAROUND\|TEMP" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.rs' --include='*.go' . 2>/dev/null | grep -v node_modules | head -50

# Deprecated APIs (these are bugs waiting to happen)
grep -rn "@deprecated" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | head -30

# Debug leftovers (console.log in production code is a bug)
grep -rn "console\.log\|print()\|println!\|dbg!" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' --include='*.rs' . 2>/dev/null | grep -v node_modules | grep -v test | grep -v spec | head -30

# TypeScript: `any` is a bug in disguise
grep -rn ": any\|as any" --include='*.ts' --include='*.tsx' . 2>/dev/null | grep -v node_modules | head -30
```

FIXME/HACK → 🟡. Debug leftovers → 🟢. `any` types → 🟡.

## Step 5: Security Scan

```bash
# Hardcoded secrets
grep -rn "password\s*=\s*['\"]\|api_key\s*=\s*['\"]\|secret\s*=\s*['\"]" --include='*.ts' --include='*.js' --include='*.py' --include='*.env' . 2>/dev/null | grep -v node_modules | grep -v ".env.example" | head -20

# eval is always a bug
grep -rn "\beval(\|Function(" --include='*.ts' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | grep -v test | head -20

# Known vulnerabilities
npm audit 2>&1 | tail -30
```

Hardcoded secrets → 🔴. eval → 🔴. npm audit high/critical → 🔴.

## Step 6: Dependency Health

```bash
npm ls 2>&1 | grep -i "ERR\|missing\|invalid\|extraneous" | head -20
```

Missing deps → 🟡.

## Step 7: Scope-Specific

### If scope is "staged"
```bash
git diff --cached --name-only
git diff --cached
```

### If scope is "diff"
```bash
git diff main --name-only 2>/dev/null || git diff master --name-only 2>/dev/null
git diff main 2>/dev/null || git diff master 2>/dev/null
```

### If scope is "full"
Steps 1-6 above cover the full scan.

## Step 8: Write TODO.md

Write to the configured todo file (default: `TODO.md`).

**If the file already exists:** Merge with it. Keep manually written items. Replace only the auto-generated section (marked with `<!-- auto-review -->` comments).

### Format

```markdown
# TODO — Project Review

> Auto-generated review on YYYY-MM-DD
> Scope: full | staged | diff
> Trigger: Ralph loop completion | agent end | session start | manual

<!-- auto-review-start -->

## 🔴 Critical

- [ ] **[file:line]** Description of the broken thing
  — Impact or context

## 🟡 Warning

- [ ] **[file:line]** Description of the problem
  — Why this matters

## 🟢 Info

- [ ] **[file:line]** Minor fix description
  — Optional note

<!-- auto-review-end -->

<!-- manual-items -->
(Any manually added items below this line are preserved across reviews)

---

_Found: X critical, Y warnings, Z info items_
_Reviewed by: pi-auto-review_
```

### Rules

1. **Fixes only.** No features, no refactors, no "should consider."
2. **Every item must be actionable** — what to change, where.
3. **Include file:line** whenever possible.
4. **Deduplicate** — one root cause, one item.
5. **Preserve manual items** — never delete user-written TODO items.
6. **Use HTML comment markers** so auto-generated content can be replaced without touching manual items.

## Step 9: Auto-Fix (if enabled)

If `autoFix: true` or `/review fix` was used:

1. Work through 🔴 items first, then 🟡, then 🟢
2. After fixing each item: update `[ ]` → `[x]` in TODO.md
3. Run relevant tests after each fix
4. If a fix is risky or needs human judgment → leave it, mark with ⚠️

### Do NOT auto-fix
- Security issues needing key rotation
- Changes to public APIs
- Anything you're not confident about

## Review Checklist

Quick reference: [references/review-checklist.md](references/review-checklist.md)
