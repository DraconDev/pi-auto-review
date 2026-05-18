# Audit Fix Loop — pi-auto-review

Work through the audit findings in priority order until the project is clean.

## Priority Checklist

### P0 — Critical

- [ ] **C1: Add vitest test suite**
  - Tests for settings merging and caching
  - Tests for cycleState machine transitions
  - Tests for TODO.md parsing (countUnfixedItems)
  - Tests for sentinel detection
  - Tests for fix loop convergence/divergence
  
- [ ] **C2: Add ESLint + TypeScript-ESLint**
  - Initialize ESLint with TypeScript support
  - Enable strict rules
  - Fix any lint errors

### P1 — High

- [ ] **W2: Document Ralph detection dependency**
  - Add JSDoc to isRalphCompletion()
  - Add console.debug when detection fails silently
  
- [ ] **W4: Support flexible checkbox syntax**
  - Update countUnfixedItems() regex
  - Support: `* [ ]`, `- [ ]`, `☐`, numbered lists

### P2 — Medium

- [ ] **I2: Add git tags for releases**
  - Tag v1.6.0 and v1.7.0

### P3 — Low

- [ ] **I4: Add JSDoc on exported function**
  - Add proper JSDoc for IDE tooling

## Exit Criteria

- All P0 items complete (tests + lint)
- All P1 items complete
- `npm test` passes
- `npm run lint` passes
- `npm run check` passes (TypeScript)
- Clean git state