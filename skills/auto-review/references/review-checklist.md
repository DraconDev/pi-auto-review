# Review Checklist Reference

Quick-reference for what to check during auto-review.

## Build & Compile
- [ ] Clean build with no errors
- [ ] No type errors (TypeScript: `tsc --noEmit`)
- [ ] No lint errors
- [ ] No lint warnings (or intentional suppressions documented)

## Tests
- [ ] All tests pass
- [ ] No skipped/ignored tests without explanation
- [ ] Test coverage exists (not necessarily high, but exists)
- [ ] No flaky tests (if detectable)

## Code Quality
- [ ] No `console.log` / `print()` in production code
- [ ] No `any` types in TypeScript (or documented exceptions)
- [ ] No dead imports
- [ ] No unreachable code
- [ ] TODO/FIXME/HACK comments are tracked

## Security
- [ ] No hardcoded secrets, keys, or passwords
- [ ] No `eval()` or `Function()` constructor
- [ ] No SQL injection vectors (raw string concatenation)
- [ ] Dependencies audited (`npm audit` or equivalent)
- [ ] `.env` files are gitignored
- [ ] No overly permissive CORS or security headers

## Dependencies
- [ ] No missing dependencies
- [ ] No extraneous dependencies
- [ ] No version conflicts
- [ ] No deprecated dependencies with known vulnerabilities

## Git
- [ ] No large binary files tracked
- [ ] `.gitignore` is comprehensive
- [ ] No stale branches (optional, informational)

## Configuration
- [ ] Config files are consistent (tsconfig, eslint, prettier, etc.)
- [ ] Environment variables are documented
- [ ] CI/CD pipeline config is valid
