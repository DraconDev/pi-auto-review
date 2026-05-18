# V2 Audit Fix Loop — pi-auto-review

Address all warnings from the v2 audit in priority order.

## Checklist

### P1 — Low effort, immediate fix
- [ ] **W1: Clean up unused/redundant devDependencies**
  - Remove `@eslint/js` (not imported in eslint.config.ts)
  - Remove `typescript-eslint` (redundant with individual `@typescript-eslint/*` packages)
  - Remove `@vitest/ui` (unused)
  - Verify `npm run lint` still passes after cleanup

### P2 — Medium effort, real bugs
- [ ] **W2: Make tests import from extension instead of copy-pasting logic**
  - Export pure functions from extension: `countUnfixedItems`, `isRalphCompletion`, `getSettings`, `buildReviewPrompt`, `buildRereviewPrompt`
  - Update tests to import and call the actual functions
  - Verify all 31+ tests still pass

- [ ] **W3: Add event handler tests with mocked ExtensionAPI**
  - Create mock `ExtensionAPI` (pi.on, pi.sendUserMessage)
  - Test session_start trigger
  - Test agent_end trigger with Ralph completion
  - Test agent_end trigger without Ralph completion
  - Test before_agent_start system prompt injection
  - Test cooldown blocking
  - Test cycleState blocking

### P3 — Low effort, cleanup
- [ ] **W5: Add coverage/ and .ralph/ to .gitignore**
  - Add after the dracon-warden managed block (don't modify the block itself)
  - Remove tracked .ralph/ files from git

### P4 — High effort, architecture
- [ ] **W4: Refactor monolithic export into modules** (SKIP if time-constrained)
  - Extract settings logic to `extensions/settings.ts`
  - Extract prompt builders to `extensions/prompts.ts`
  - Extract parsing to `extensions/parsing.ts`
  - Extract detection to `extensions/detection.ts`
  - Keep `extensions/auto-review.ts` as thin wiring shell

## Exit Criteria
- All P1 items complete
- All P2 items complete
- All P3 items complete
- `npm run check` passes
- `npm run lint` passes
- `npm test` passes (all tests, including new ones)
- Clean git state