# pi-auto-review Audit Report

**Date:** 2026-05-18  
**Version:** 1.6.0 (commit b426978 v1.7.0)  
**Auditor:** Automated audit

---

## Executive Summary

| Category | Count |
|----------|-------|
| Critical | 2 |
| Warnings | 4 |
| Info | 5 |
| Fixed in v1.7.0 | 4 |
| Good Practices | 9 |

**Verdict:** Production-ready with 2 critical gaps (tests, linting). All v1.7.0 fixes are solid.

---

## Critical Issues

### C1: No Test Coverage

**Severity:** Critical  
**Location:** `package.json` scripts.test  
**Description:** `"test": "echo 'No tests yet'"` — no actual tests exist

**Impact:** No way to verify:
- Event handler behavior (session_start, agent_end, before_agent_start)
- Settings merging and defaults
- cycleState machine transitions
- TODO.md parsing logic
- Sentinel detection
- Fix loop convergence

**Recommendation:** Add vitest with the following test suites:

```typescript
// tests/auto-review.test.ts
describe('Settings', () => {
  test('merges user settings over defaults')
  test('reads from project settings.json')
  test('reads from global settings.json')
  test('invalidates cache on mtime change')
})

describe('cycleState Machine', () => {
  test('starts idle')
  test('transitions to reviewing on shouldTrigger')
  test('blocks new reviews when reviewing')
  test('resets to idle on clean exit')
})

describe('TODO.md Parsing', () => {
  test('counts unchecked items in section')
  test('returns 0 for missing file')
  test('strips code blocks before counting')
})
```

---

### C2: No Lint Configuration

**Severity:** Critical  
**Location:** `package.json` scripts.lint  
**Description:** `"lint": "echo 'No linter configured yet'"` — no ESLint/TypeScript-ESLint

**Impact:** No enforcement of:
- Consistent code style
- No unused variables/imports
- No type safety violations
- No security anti-patterns

**Recommendation:** Add ESLint + TypeScript-ESLint:

```bash
npm init @eslint/config@latest -- --typescript
```

Baseline config with `@typescript-eslint/strict` enabled.

---

## Warnings

### W1: cycleState Race Condition Potential

**Severity:** Warning  
**Location:** `extensions/auto-review.ts` ~line 250

**Description:** `cycleState` is a single variable checked/set without atomic operations or locking. Multiple events firing rapidly could cause the state machine to miss legitimate triggers.

**Risk Assessment:** Low given Pi's event model, but not impossible.

**Recommendation:** Document as known limitation, OR add a simple mutex:

```typescript
let reviewInProgress: Promise<void> | null = null;

async function startReview(...) {
  if (reviewInProgress) return; // Queue or skip
  reviewInProgress = doReview(...).finally(() => {
    reviewInProgress = null;
  });
}
```

---

### W2: Ralph Completion Detection is Fragile

**Severity:** Warning  
**Location:** `extensions/auto-review.ts` ~line 180

**Description:** `isRalphCompletion()` looks for `<promise>COMPLETE</promise>` in last 5 messages. This is string-based and will break if Ralph loop output format changes.

**Recommendation:** 
1. Document the dependency on `<promise>COMPLETE</promise>`
2. Add a fallback detection method
3. Add debug logging when sentinel is NOT found in expected places

---

### W3: Sentinel Approach is Opaque

**Severity:** Warning  
**Location:** `extensions/auto-review.ts` ~line 50

**Description:** Null-byte sentinels (`\x00AR1\x00`) are used for cycle detection. Risk if:
- Prompt API strips null bytes
- String encoding changes
- Content gets modified by upstream

**Recommendation:** Add debug logging to catch sentinel detection failures:

```typescript
if (!text.includes(_REVIEW_SENTINEL) && !text.includes(_REREVIEW_SENTINEL)) {
  console.debug('[auto-review] No sentinel found in message');
}
```

---

### W4: TODO.md Parsing Relies on Specific Syntax

**Severity:** Warning  
**Location:** `extensions/auto-review.ts` ~line 185

**Description:** `countUnfixedItems()` uses `/^- \[ \]/gm`. Won't count:
- Unicode checkboxes: `☐`, `☑`
- Different spacing: `- [ ]`, `- [  ]`, `-[ ]`
- Asterisks: `* [ ]`
- Numbered lists: `1. [ ]`

**Recommendation:** 
1. Document the required syntax in README
2. Consider more flexible regex:

```typescript
const checkboxRegex = /^[*\-+]?\s*\[\s*\]\s*$/m;
```

---

## Info

### I1: Version/Commit Message Mismatch
v1.7.0 commit but package.json says 1.6.0. Commit says "Package version synced to 1.6.0" — intentional per the commit message, but confusing.

**Recommendation:** Use semantic versioning with git tags for releases.

---

### I2: No Git Tags
No annotated tags exist. Releases identified only by commit messages.

**Recommendation:** Add tags: `git tag -a v1.6.0 -m "Release v1.6.0" b426978`

---

### I3: Console.log/warn Statements
10 debug statements in production code.

**Recommendation:** Consider grouping with a `[auto-review]` prefix consistently (most have it).

---

### I4: No JSDoc on Exported Function
Module-level comments exist but not on the `export default function`.

**Recommendation:** Add JSDoc for IDE tooling:

```typescript
/**
 * Auto Review Extension for Pi
 * @param pi - ExtensionAPI instance from @earendil-works/pi-coding-agent
 */
export default function (pi: ExtensionAPI) { ... }
```

---

### I5: Settings Cache Staleness
`_cachedSettings` persists until session_start. Could be stale if settings.json changes during a long session.

**Recommendation:** Document this behavior or add `fs.watch` for real-time invalidation.

---

## Fixed in v1.7.0 (commit b426978)

| ID | Issue | Resolution |
|----|-------|------------|
| F1 | Agent-visible `[pi-auto-review]` markers | Replaced with null-byte sentinels |
| F2 | Status messages in prompts | Removed; only console.log and ctx.ui.notify remain |
| F3 | countUnfixedItems returning -1 on missing file | Now returns 0 |
| F4 | No error handling on sendUserMessage | try/catch with state rollback |

---

## Good Practices Observed

- ✅ TypeScript strict mode enabled
- ✅ `tsconfig.json` with `skipLibCheck: true` (avoids peer dep issues)
- ✅ Settings caching with mtime invalidation
- ✅ Safe file operations with try/catch throughout
- ✅ Cooldown mechanism prevents review spam
- ✅ Divergence detection in fix loop (stops if problems increase)
- ✅ Max fix rounds bounded (prevents infinite loops)
- ✅ Clean separation of concerns (prompt builders, settings, event handlers)
- ✅ Comprehensive README with configuration examples

---

## Recommendations Priority

1. **P0 (Critical):** Add test coverage — without tests, no confidence in fixes
2. **P0 (Critical):** Add ESLint + TypeScript-ESLint — without lint, style degrades
3. **P1 (High):** Document Ralph completion detection dependency
4. **P1 (High):** Add flexible TODO.md checkbox syntax
5. **P2 (Medium):** Add git tags for releases
6. **P3 (Low):** JSDoc on export, log level organization

---

## Test Plan (if tests added)

### Unit Tests
```typescript
// Settings
- reads project settings.json
- reads global settings.json  
- falls back to defaults
- caches until mtime changes

// cycleState
- idle → reviewing on review start
- reviewing → idle on clean exit
- reviewing → idle on divergence
- reviewing → idle on max rounds

// TODO.md parsing
- counts /^- \[ \]/ lines in section
- returns 0 for missing file
- returns 0 if no auto-review section
- strips code blocks before counting

// Sentinel detection
- finds _REVIEW_SENTINEL in prompt
- finds _REREVIEW_SENTINEL in re-review prompt
- does NOT detect sentinel in normal messages

// Fix loop
- stops at max rounds
- stops on divergence
- continues until clean
```

### Integration Tests
```typescript
// Full cycle
- session_start triggers review when configured
- agent_end triggers review when configured
- review → fix → re-review loop
- clean exit when 0 items
```