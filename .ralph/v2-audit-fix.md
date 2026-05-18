# V2 Audit Fix Loop — pi-auto-review

Address all warnings from the v2 audit in priority order.

## Checklist

### P1 — Low effort, immediate fix
- [x] **W1: Clean up unused/redundant devDependencies** ✅
  - Removed `@eslint/js`, `typescript-eslint`, `@vitest/ui`
  - `npm run lint` passes

### P2 — Medium effort, real bugs
- [x] **W2: Make tests import from extension instead of copy-pasting logic** ✅
  - Extracted pure functions into `extensions/auto-review-lib.ts`
  - Tests import from the real module

- [x] **W3: Add event handler tests with mocked ExtensionAPI** ✅
  - Created `tests/event-handlers.test.ts` with 19 tests
  - session_start, turn_end, agent_end, before_agent_start
  - cooldown blocking, cycleState blocking, disabled extension

### P3 — Low effort, cleanup
- [x] **W5: Add coverage/ and .ralph/ to .gitignore** ✅
  - Added after warden-managed block
  - Removed .ralph/ from git tracking

### P4 — High effort, architecture
- [x] **W4: Refactor monolithic export into modules** ✅
  - Extracted `auto-review-lib.ts` with all pure functions
  - Main file is now thin wiring shell

## Exit Criteria
- [x] All P1 items complete ✅
- [x] All P2 items complete ✅
- [x] All P3 items complete ✅
- [x] `npm run check` passes ✅
- [x] `npm run lint` passes ✅
- [x] `npm test` passes ✅ (79 tests)
- [x] Clean git state ✅

## Status: COMPLETE