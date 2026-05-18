---
name: auto-review
description: Automated project review methodology. Scans for problems (not features), writes prioritized findings to TODO.md. Triggers on /review command, session start, or dirty repo conditions.
---

# Auto Review

## Overview

You are performing an automated project review. Your goal is to **find and document problems** — not to propose new features or architectural changes. The output is a prioritized `TODO.md` file with actionable items.

## Step 1: Project Reconnaissance

Gather a quick picture of the project before diving in:

```bash
# What kind of project is this?
cat package.json 2>/dev/null || cat Cargo.toml 2>/dev/null || cat pyproject.toml 2>/dev/null || cat go.mod 2>/dev/null

# What's the file structure?
find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/coverage/*' -not -path '*/vendor/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' -not -path '*/target/*' | head -200
```

Identify:
- Language(s) and framework(s)
- Package manager and dependency count
- Whether there's a test suite
- Whether there's a CI/CD config
- Whether there's linting/formatting configured

## Quick Reference

For a condensed checklist, see [review-checklist.md](references/review-checklist.md).

## Step 2: Build & Type Check

Run whatever build/check commands the project supports:

```bash
# Node/TypeScript
npm run build 2>&1 | tail -50
npx tsc --noEmit 2>&1 | tail -50
npm run lint 2>&1 | tail -50

# Python
python -m py_compile . 2>&1 || ruff check . 2>&1 | tail -50

# Rust
cargo check 2>&1 | tail -50
cargo clippy 2>&1 | tail -50

# Go
go build ./... 2>&1 | tail -50
go vet ./... 2>&1 | tail -50
```

**Record all errors and warnings.** These are automatic 🔴 or 🟡 items.

If the project has no build system, note that as a 🟡 finding.

## Step 3: Test Suite

```bash
# Node
npm test 2>&1 | tail -50

# Python
pytest 2>&1 | tail -50

# Rust
cargo test 2>&1 | tail -50

# Go
go test ./... 2>&1 | tail -50
```

**Record failing tests as 🔴 items.** If no tests exist, that's a 🟡 finding.

## Step 4: Static Analysis & Code Quality

Search for common problem markers:

```bash
# TODO/FIXME/HACK comments
grep -rn "TODO\|FIXME\|HACK\|XXX\|TEMP" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.rs' --include='*.go' . 2>/dev/null | grep -v node_modules | head -50

# Deprecated APIs
grep -rn "deprecated\|@deprecated\|DEPRECATED" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | head -30

# Console.log left in production code
grep -rn "console\.log\|print()\|println!" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' --include='*.rs' . 2>/dev/null | grep -v node_modules | grep -v test | head -30

# Any/unknown types in TypeScript
grep -rn ": any\|as any" --include='*.ts' --include='*.tsx' . 2>/dev/null | grep -v node_modules | head -30
```

Record these as 🟢 (TODOs, style) or 🟡 (deprecated APIs, `any` types).

## Step 5: Security Scan

Quick security checks:

```bash
# Check for common secrets patterns
grep -rn "password\s*=\s*['\"]\|api_key\s*=\s*['\"]\|secret\s*=\s*['\"]\|token\s*=\s*['\"]" --include='*.ts' --include='*.js' --include='*.py' --include='*.env' . 2>/dev/null | grep -v node_modules | grep -v ".env.example" | head -20

# Check for eval usage
grep -rn "\beval(\|Function(\|exec\(" --include='*.ts' --include='*.js' --include='*.py' . 2>/dev/null | grep -v node_modules | grep -v test | head -20

# Check dependency vulnerabilities (Node)
npm audit 2>&1 | tail -30

# Check for outdated dependencies with known issues
npm outdated 2>&1 | head -20
```

**Hardcoded secrets and eval usage are 🔴.** Vulnerabilities are 🟡 or 🔴 depending on severity.

## Step 6: Dependency Health

```bash
# Node
npm ls 2>&1 | grep -i "ERR\|missing\|invalid\|extraneous" | head -20

# Python
pip check 2>&1 | head -20
```

Missing or mismatched dependencies are 🟡 items.

## Step 7: Scope-Specific Review

### If scope is "staged"
```bash
git diff --cached --name-only
git diff --cached
```
Review only the staged changes for problems.

### If scope is "diff"
```bash
git diff main --name-only 2>/dev/null || git diff master --name-only 2>/dev/null
git diff main 2>/dev/null || git diff master 2>/dev/null
```
Review only the diff from the main branch.

### If scope is "full"
Continue with Steps 1-6 above, then additionally scan the full codebase.

## Step 8: Write TODO.md

Write the findings to the configured todo file (default: `TODO.md`).

### Format

```markdown
# TODO — Project Review

> Auto-generated review on YYYY-MM-DD
> Scope: full | staged | diff

## 🔴 Critical

- [ ] **[file:line]** Description of the critical problem
  — Context or impact explanation

## 🟡 Warning

- [ ] **[file:line]** Description of the warning
  — Why this matters

## 🟢 Info

- [ ] **[file:line]** Description of the improvement
  — Optional note

---

_Found: X critical, Y warnings, Z info items_
_Reviewed by: pi-auto-review_
```

### Rules

1. **Every item must be actionable** — no vague "improve X" items
2. **Include file paths and line numbers** whenever possible
3. **No feature requests** — only problems that exist now
4. **Deduplicate** — if the same root cause causes 10 type errors, one item with the root cause is enough
5. **Preserve existing content** — if the TODO.md already exists, merge with it. Keep manually written items. Replace the auto-review section only.
6. **Cross off completed items** — when fixing, update the checkbox `[x]` and note the fix

## Step 9: Auto-Fix (if enabled)

If the review was triggered with `autoRun: true` or `/review fix`:

1. Work through items in priority order (🔴 first, then 🟡, then 🟢)
2. After fixing each item, update the checkbox in TODO.md: `[ ]` → `[x]`
3. Add a brief note about what was done
4. Run relevant tests after each fix to confirm it worked
5. If a fix is risky or unclear, skip it and leave a note

### What NOT to auto-fix
- Items that require architectural decisions
- Security issues that need human review (e.g., key rotation)
- Changes that affect public APIs
- Anything you're not confident about

Mark these with a `⚠️` instead of checking them off.

## Review Checklist

For a quick at-a-glance checklist, see [references/review-checklist.md](references/review-checklist.md).
