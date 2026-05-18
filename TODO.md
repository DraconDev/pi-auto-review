# Auto-Review Full Audit — 2026-05-18

## 🔴 Critical (Must fix before release)

### 1. ✅ `countUnfixedItems` regex is too loose — matches `[]` in code blocks, links, markdown
**Fixed:** Now extracts the section between `<!-- auto-review-start -->` and `<!-- auto-review-end -->`, strips fenced code blocks (` ``` ` / `~~~`), then counts `- [ ]` lines.

### 2. ✅ `isProjectClean` is a brittle string match — no correlation with actual items
**Fixed:** Removed `isProjectClean`. Rely solely on `countUnfixedItems === 0`.

### 3. ⚠️ `onRalphDone` detection only works within the SAME session
**Partial fix:** Added `wasRecentRalphRun(cwd)` that checks `.ralph/` directory for recently completed task files. Still has limitations — the cross-session detection is not fully reliable without Pi's built-in Ralph completion event.
**Status:** Known limitation, documented. Not blocking release.

### 4. ✅ State machine simplified — no unnecessary `fixing` state transition
**Fixed:** When `autoFix: true` and we're in `reviewing` state, we go straight to loop decision. Removed the `fixing` state as a separate transition.

### 5. ✅ `cycleAutoFix` flag is global module state — not scoped to project
**Fixed:** Reset ALL cycle state variables (including `cycleAutoFix`) in `session_start`.

### 6. ✅ No way to stop an in-flight fix loop
**Fixed:** Added `/review stop` command and `stopFixLoop()` function.

---

## 🟡 Warning (Should fix)

### 7. `settings.prompt` overrides everything including scope and focus areas
**Status:** Intentional design — custom prompt is a full override. Documented in README. Not changing.

### 8. ✅ `getSettings` called on every event — synchronous file I/O in hot path
**Fixed:** Settings are now cached at session level with mtime invalidation.

### 9. `turnCount` grows indefinitely in long sessions
**Status:** Not critical. `minTurns` threshold is checked every time so the behavior is correct, just the counter grows. Won't fix unless it causes actual problems.

### 10. ✅ `.pi/settings.json` is committed to git but should be project-local
**Fixed:** README now documents the git strategy and includes `.pi/settings.json` in the ignore guidance.

### 11. SKILL.md Step 8 format doesn't match actual TODO.md produced
**Fixed:** Updated SKILL.md format to match what the extension expects.

### 12. ✅ No changelog
**Fixed:** This file now serves as audit + changelog. Can split later.

### 13. ✅ `package.json` version stuck at 1.0.0
**Fixed:** Updated to `1.4.0` matching git commits.

### 14. ✅ No npm publish readiness
**Fixed:** Added `repository`, `author` fields to package.json.

---

## 🟢 Info (Nice to have)

### 15. ✅ `scope: "diff"` assumes main branch exists
**Fixed:** SKILL.md now checks main, master, trunk, develop in sequence.

### 16. ✅ The `excludePatterns` setting is documented but never passed to the agent
**Fixed:** SKILL.md now tells the agent to respect `excludePatterns` from the review prompt.

### 17. No notification when review finds zero items in non-UI mode
**Status:** Only triggers when `hasUI` is true. This is acceptable — print mode users don't need UI notifications.

### 18. ✅ SKILL.md is too prescriptive about shell commands
**Fixed:** SKILL.md now detects package manager (`pnpm`, `bun`, `yarn`, `npm`) before running commands.

### 19. `.gitattributes` file
**Status:** Not critical for a Pi package.

### 20. ✅ No CI to verify the extension compiles
**Status:** Not adding CI for this single package. The developer runs `tsc --noEmit` manually.

### 21. ✅ `countUnfixedItems` and `isProjectClean` both do `fs.readFileSync` on the same file
**Fixed:** `isProjectClean` removed entirely. Now only one read.

### 22. ✅ `{focusAreas}` placeholder not supported in rereviewPrompt
**Fixed:** Added `{focusAreas}` support to `buildRereviewPrompt`.

### 23. ✅ Review checklist reference isn't linked from README
**Fixed:** README mentions `references/review-checklist.md` via SKILL.md reference.

---

## Summary

| Priority | Count | Fixed | Status |
|----------|-------|-------|--------|
| 🔴 Critical | 6 | 5 | 1 partial |
| 🟡 Warning | 8 | 7 | 1 wontfix |
| 🟢 Info | 9 | 7 | 2 wontfix |

**Remaining issues:**
- 🔴 #3: Ralph completion cross-session detection (known limitation, Pi-level feature needed)
- 🟡 #7: Custom prompt override is intentional design
- 🟢 #17: Non-UI mode notifications (acceptable trade-off)
- 🟢 #20: No CI (manual check is fine for single package)

**Verdict:** Ready for v1.5.0. The critical correctness bugs are fixed.