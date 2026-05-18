# pi-auto-review Audit Report v2

**Date:** 2026-05-18  
**Version:** 1.7.1 (commit a252df4)  
**Auditor:** Automated full audit

---

## Executive Summary

| Severity | Count | Status |
|----------|-------|--------|
| 🔴 Critical | 0 | — |
| 🟡 Warning | 5 | See below |
| 🔵 Info | 7 | See below |
| ✅ Good | 6 | Noted |

**Verdict:** Project is healthy. No critical issues. Warnings are about dependency cleanup, test coverage depth, and architecture.

---

## Warnings (5)

### W1: Unused/redundant devDependencies

**Location:** `package.json` devDependencies

**Description:** 
- `@eslint/js` is installed but **never imported** in `eslint.config.ts`. The config was simplified during setup and no longer uses `js.configs.recommended`.
- `typescript-eslint` is a meta-package that bundles `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`. Having all three is redundant — `typescript-eslint` alone suffices, OR the individual packages suffice without `typescript-eslint`.

**Fix:**
```bash
# Option A: Remove unused deps
npm uninstall @eslint/js typescript-eslint

# Option B: Use typescript-eslint as the sole source (simpler)
npm uninstall @eslint/js @typescript-eslint/eslint-plugin @typescript-eslint/parser
# Then update eslint.config.ts to import from typescript-eslint only
```

---

### W2: Tests replicate logic inline instead of importing from extension

**Location:** `tests/auto-review.test.ts`

**Description:** The 31 tests copy-paste the logic from the extension (e.g., `countUnfixedItems` regex, `isRalphCompletion` function) rather than importing and testing the actual functions. This means:
- If the extension logic changes, the tests won't catch it
- Tests verify what the code *should* do, not what it *actually* does

**Fix:** Extract pure functions from the extension and import them in tests. Requires either:
1. Making internal functions exportable (e.g., `export function countUnfixedItems(...)`)
2. Or testing through the extension API (mock `ExtensionAPI`)

---

### W3: Event handlers have zero test coverage

**Location:** `extensions/auto-review.ts` — `pi.on("session_start")`, `pi.on("turn_end")`, `pi.on("agent_end")`, `pi.on("before_agent_start")`

**Description:** The 4 event handlers that wire up the entire extension behavior have no tests. The cycleState machine, cooldown, and trigger logic are tested in isolation but not through the actual event handler paths.

**Fix:** Mock `ExtensionAPI` and test event handler flows end-to-end:
```typescript
const mockPi = { on: vi.fn(), sendUserMessage: vi.fn() };
// Call the extension setup, then trigger events via mockPi.on callbacks
```

---

### W4: Exported function is 169 lines — monolithic

**Location:** `extensions/auto-review.ts` — `export default function (pi: ExtensionAPI)`

**Description:** The entire extension is one exported function containing all event handlers, state, and logic. This makes it hard to test individual parts and increases cognitive load.

**Fix:** Extract into modules:
- `settings.ts` — `getSettings()`, `readSettingsJson()`, defaults
- `prompts.ts` — `buildReviewPrompt()`, `buildRereviewPrompt()`
- `parsing.ts` — `countUnfixedItems()`
- `detection.ts` — `isRalphCompletion()`
- `extension.ts` — just the wiring (thin shell)

---

### W5: `.gitignore` missing `coverage/` and `.ralph/`

**Location:** `.gitignore`

**Description:** The `.gitignore` is managed by dracon-warden and doesn't include `coverage/` (vitest output) or `.ralph/` (Ralph loop state files). Both are currently tracked in git.

**Note:** Cannot modify directly — dracon-warden managed block. Add a project-level override or request warden update.

---

## Info (7)

### I1: 8 console statements in production code
**Location:** `extensions/auto-review.ts`  
Appropriate for an extension (debug logging), but consider a `DEBUG` env var to silence them.

### I2: 3 module-level `let` variables for caching
**Location:** `extensions/auto-review.ts` — `_cachedSettings`, `_cachedSettingsPath`, `_cachedMtimeKey`  
Standard pattern for settings caching. Fine as-is.

### I3: No async patterns (0 await, 0 .then)
**Location:** `extensions/auto-review.ts`  
The extension is fully synchronous. This is correct since all operations (fs.readFileSync, string matching) are fast and the Pi event model handles them synchronously.

### I4: tsconfig doesn't include test files
**Location:** `tsconfig.json` — `include: ["extensions/**/*.ts"]`  
Tests have their own TypeScript context via vitest. This is standard — vitest handles test file compilation.

### I5: `.ralph/` state files tracked in git
Two Ralph loop state files (`.ralph/audit-fix-loop.md`, `.ralph/audit-fix-loop.state.json`) are committed. These are ephemeral and shouldn't be tracked.

### I6: `@vitest/ui` installed but never used
**Location:** `package.json` devDependencies  
Only needed for `npm run test:ui`. Not harmful, but unnecessary if no one uses the UI.

### I7: `1` explicit `any` in code (false positive)
**Location:** `extensions/auto-review.ts`  
The `any` match is in the REVIEW_METHODOLOGY prompt string (`"explicit any types (: any, as any)"`), not actual code. No real `any` usage in the TypeScript.

---

## Good (6)

- ✅ No FIXME/HACK/TODO markers in code
- ✅ 5 try/catch blocks for error handling
- ✅ All settings documented in README
- ✅ tsconfig strict mode enabled
- ✅ Test script configured (`vitest run`)
- ✅ Lint script configured (`eslint extensions/**/*.ts`)
- ✅ No security vulnerabilities (`npm audit` clean)
- ✅ TypeScript compiles without errors
- ✅ ESLint passes
- ✅ 31 tests pass

---

## Verification

```
$ npm run check    # ✅ TypeScript: 0 errors
$ npm run lint     # ✅ ESLint: 0 errors, 0 warnings
$ npm test         # ✅ 31 tests pass
$ npm audit        # ✅ 0 vulnerabilities
```

---

## Recommendations (Priority Order)

| # | Priority | Item | Effort |
|---|----------|------|--------|
| 1 | P1 | Remove unused deps (`@eslint/js`, `typescript-eslint` OR individual `@typescript-eslint/*`) | Low |
| 2 | P2 | Extract pure functions from extension for testability | Medium |
| 3 | P2 | Add event handler tests with mocked ExtensionAPI | Medium |
| 4 | P3 | Add `coverage/` and `.ralph/` to .gitignore (or request warden update) | Low |
| 5 | P3 | Remove `.ralph/` state files from git tracking | Low |
| 6 | P4 | Refactor monolithic export into modules | High |
| 7 | P4 | Remove `@vitest/ui` if unused | Low |
