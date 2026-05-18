/**
 * Auto Review Extension for Pi
 *
 * Event-driven project review: scans for problems after work completes,
 * writes findings to TODO.md, and optionally auto-fixes them in bounded
 * loops until the project is clean.
 *
 * Invisible to the agent — no commands, no skills, no markers, no branding.
 * Reviews trigger automatically when configured conditions are met.
 * The agent just receives a follow-up message and does the work.
 *
 * Settings (in .pi/settings.json or ~/.pi/agent/settings.json):
 *   autoReview.enabled          - master toggle (default: true)
 *   autoReview.todoPath         - path to todo file (default: "TODO.md")
 *   autoReview.autoFix          - after writing todos, go fix them (default: false)
 *   autoReview.maxFixRounds     - max review→fix→re-review loops (default: 3)
 *   autoReview.onRalphDone      - auto-review when Ralph loop completes (default: true)
 *   autoReview.onAgentEnd       - auto-review after any agent_end (default: false)
 *   autoReview.onSessionStart   - auto-review on session start (default: false)
 *   autoReview.minTurns         - minimum turns before agent_end triggers review (default: 3)
 *   autoReview.scope            - "full" | "staged" | "diff" (default: "full")
 *   autoReview.excludePatterns  - dirs to exclude (default: ["node_modules", ...])
 *   autoReview.cooldownMs       - minimum ms between auto-reviews (default: 120000)
 *
 *   Custom prompts (all optional, override defaults):
 *   autoReview.prompt            - custom first-review prompt
 *   autoReview.rereviewPrompt    - custom re-review prompt (in fix loop)
 *   autoReview.fixInstruction    - custom instruction appended when autoFix is on
 *   autoReview.focusAreas        - override the default list of things to look for
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Internal sentinels (never shown to agent) ──────────────────────────────

const _REVIEW_SENTINEL = "\x00AR1\x00";
const _REREVIEW_SENTINEL = "\x00AR2\x00";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_FOCUS_AREAS = [
	"Lint errors, type errors, build failures",
	"Failing or missing tests",
	"Security vulnerabilities",
	"Broken imports or missing dependencies",
	"Dead code, unreachable branches",
	"TODO/FIXME/HACK comments that indicate known BUGS (not feature ideas)",
	"Inconsistencies between code and config",
	"Performance problems that are bugs (N+1 queries, memory leaks)",
];

const DEFAULT_SETTINGS: Required<AutoReviewSettings> = {
	enabled: true,
	todoPath: "TODO.md",
	autoFix: false,
	maxFixRounds: 3,
	onRalphDone: true,
	onAgentEnd: false,
	onSessionStart: false,
	minTurns: 3,
	scope: "full",
	excludePatterns: [
		"node_modules",
		".git",
		"dist",
		"build",
		"coverage",
		".next",
		".nuxt",
		"vendor",
		"__pycache__",
		".venv",
		"target",
	],
	cooldownMs: 120_000,
	prompt: null,
	rereviewPrompt: null,
	fixInstruction: null,
	focusAreas: null,
};

// ── Types ───────────────────────────────────────────────────────────────────

interface AutoReviewSettings {
	enabled?: boolean;
	todoPath?: string;
	autoFix?: boolean;
	maxFixRounds?: number;
	onRalphDone?: boolean;
	onAgentEnd?: boolean;
	onSessionStart?: boolean;
	minTurns?: number;
	scope?: "full" | "staged" | "diff";
	excludePatterns?: string[];
	cooldownMs?: number;
	prompt?: string | null;
	rereviewPrompt?: string | null;
	fixInstruction?: string | null;
	focusAreas?: string[] | null;
}

type ReviewScope = "full" | "staged" | "diff";
type CycleState = "idle" | "reviewing";

// ── Settings (cached per session, safe mtime) ──────────────────────────────

let _cachedSettings: Required<AutoReviewSettings> | null = null;
let _cachedSettingsPath = "";
let _cachedMtimeKey = "";

function safeStatMtime(filePath: string): string {
	try {
		return `${fs.statSync(filePath).mtimeMs}`;
	} catch {
		return "none";
	}
}

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.warn(`[auto-review] Warning: ${filePath} can't be read — ${detail}`);
		return null;
	}
}

function getSettings(cwd: string): Required<AutoReviewSettings> {
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const globalSettingsPath = path.join(homedir(), ".pi", "agent", "settings.json");

	const mtimeKey = [projectSettingsPath, globalSettingsPath]
		.map((p) => `${p}:${safeStatMtime(p)}`)
		.join("|");

	if (_cachedSettings && _cachedSettingsPath === cwd && mtimeKey === _cachedMtimeKey) {
		return _cachedSettings;
	}

	for (const settingsPath of [projectSettingsPath, globalSettingsPath]) {
		const data = readSettingsJson(settingsPath);
		if (data) {
			const raw = data.autoReview ?? data["auto-review"];
			if (raw && typeof raw === "object") {
				_cachedSettings = { ...DEFAULT_SETTINGS, ...(raw as AutoReviewSettings) };
				_cachedSettingsPath = cwd;
				_cachedMtimeKey = mtimeKey;
				return _cachedSettings;
			}
		}
	}
	_cachedSettings = { ...DEFAULT_SETTINGS };
	_cachedSettingsPath = cwd;
	_cachedMtimeKey = mtimeKey;
	return _cachedSettings;
}

// ── Review methodology (inline, language-agnostic) ─────────────────────────

const REVIEW_METHODOLOGY = `Use this FIX-ONLY review methodology:
1. **Build check** — run the project's build command and type checker (e.g., npm run build / cargo check / go build)
2. **Test suite** — run the project's test command (e.g., npm test / cargo test / go test)
3. **Bug markers** — grep for FIXME, HACK, XXX, console.log, print(), explicit any types (: any, as any) in source files
4. **Security** — grep for hardcoded secrets (password=, api_key=, secret=), eval(), unsafe patterns
5. **Dependency health** — check for missing or broken dependencies (npm ls / cargo check / go mod verify)`;

const FORMAT_INSTRUCTION = (todoPath: string) => `
Write your findings to ${todoPath}. Organize by priority:
- 🔴 Critical — broken build, security issues, data loss risk
- 🟡 Warning — failing tests, dead code, deprecation issues
- 🟢 Info — minor fixes, cleanup of accidental issues

Wrap the auto-generated section with <!-- auto-review-start --> and <!-- auto-review-end --> HTML comments.
At the very end of ${todoPath}, add a line: _Items found: N_ where N is the total count of unfixed [ ] items.
Keep each item actionable and specific. Include file paths and line numbers where possible.
Do NOT add feature requests, architecture proposals, or "nice to have" items.`;

// ── Prompt Builders ─────────────────────────────────────────────────────────

function getFocusList(settings: Required<AutoReviewSettings>): string {
	const areas = settings.focusAreas ?? DEFAULT_FOCUS_AREAS;
	return areas.map((a) => `- ${a}`).join("\n");
}

function getDefaultFixInstruction(todoPath: string): string {
	return `After updating ${todoPath}, go ahead and fix the problems you found. Work through items in priority order. Cross off items in ${todoPath} as you fix them.`;
}

function buildReviewPrompt(
	settings: Required<AutoReviewSettings>,
	scope: ReviewScope,
	autoFix: boolean,
	_triggerReason: string,
): string {
	// Custom prompt: prepend sentinel, always append format instruction
	if (settings.prompt) {
		let prompt = `${_REVIEW_SENTINEL}${settings.prompt}`;
		prompt += FORMAT_INSTRUCTION(settings.todoPath);
		if (autoFix) {
			prompt += `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`;
		}
		return prompt;
	}

	const scopeInstruction: Record<ReviewScope, string> = {
		full: "Review the entire project for problems.",
		staged: "Review only the staged git changes for problems.",
		diff: "Review the diff from the main branch (or trunk/develop if main doesn't exist) for problems.",
	};

	const excludeNote = settings.excludePatterns.length > 0
		? `\nExclude these directories: ${settings.excludePatterns.join(", ")}.`
		: "";

	const fixInstruction = autoFix
		? `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`
		: "";

	return `${_REVIEW_SENTINEL}${scopeInstruction[scope]}${excludeNote}

${REVIEW_METHODOLOGY}

This is a FIX-ONLY review. Do NOT propose features or improvements. ONLY find problems that need fixing:
${getFocusList(settings)}
${FORMAT_INSTRUCTION(settings.todoPath)}${fixInstruction}`;
}

function buildRereviewPrompt(
	settings: Required<AutoReviewSettings>,
	round: number,
	maxRounds: number,
	previousItemCount: number,
	autoFix: boolean,
): string {
	const roundLabel = `round ${round}/${maxRounds}`;

	if (settings.rereviewPrompt) {
		let prompt = `${_REREVIEW_SENTINEL}${settings.rereviewPrompt}`
			.replaceAll("{round}", String(round))
			.replaceAll("{maxRounds}", String(maxRounds))
			.replaceAll("{previousItems}", String(previousItemCount));
		if (prompt.includes("{focusAreas}")) {
			prompt = prompt.replaceAll("{focusAreas}", getFocusList(settings));
		}
		prompt += FORMAT_INSTRUCTION(settings.todoPath);
		if (autoFix) {
			prompt += `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`;
		}
		return prompt;
	}

	const fixAppend = autoFix
		? `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`
		: "";

	return `${_REREVIEW_SENTINEL}Re-review after fixes (${roundLabel}). The previous review found ${previousItemCount} items and fixes were applied.

Re-scan the project for remaining problems.

${REVIEW_METHODOLOGY}

ONLY find problems that need fixing:
${getFocusList(settings)}

IMPORTANT:
- Check if the fixes from the previous round actually resolved the claimed issues
- Look for NEW problems that the fixes may have introduced
- If a previous fix didn't work, mark it clearly in ${settings.todoPath}
${FORMAT_INSTRUCTION(settings.todoPath)}

If you find ZERO problems, write an empty ${settings.todoPath} with just a header saying "Project is clean ✅".

Do NOT propose features. Only problems that need fixing.${fixAppend}`;
}

// ── Detection helpers ───────────────────────────────────────────────────────

/**
 * Detects Ralph loop completion by looking for <promise>COMPLETE</promise>
 * in the last 5 messages (assistant role with string content).
 *
 * @param messages - The message history array
 * @returns true if Ralph loop completion is detected
 * @requires Ralph loop output format: <promise>COMPLETE</promise>
 */
function isRalphCompletion(messages: Array<{ role: string; content?: string; toolName?: string }>): boolean {
	for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant" && typeof msg.content === "string") {
			if (msg.content.includes("<promise>COMPLETE</promise>")) return true;
		}
	}
	return false;
}

/**
 * Count unfixed [ ] items ONLY within the auto-generated section.
 * Returns 0 for missing files (not an error — just means no items yet).
 *
 * @param todoPath - Path to the TODO.md file
 * @param cwd - Current working directory for path resolution
 * @returns Count of unchecked items in the auto-review section
 * @note Supports only `- [ ]` syntax (GitHub Flavored Markdown)
 */
function countUnfixedItems(todoPath: string, cwd: string): number {
	const fullPath = path.resolve(cwd, todoPath);
	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		const startMatch = content.search(/<!--\s*auto-review-start\s*-->/i);
		if (startMatch === -1) return 0;
		const endMatch = content.search(/<!--\s*auto-review-end\s*-->/i);
		const section = endMatch === -1
			? content.slice(startMatch)
			: content.slice(startMatch, endMatch);
		const stripped = section.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
		const matches = stripped.match(/^- \[ \]/gm);
		return matches ? matches.length : 0;
	} catch {
		return 0;
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let cycleState: CycleState = "idle";
	let lastAutoReviewTime = 0;
	let turnCount = 0;
	let cycleAutoFix = false;
	let fixRound = 0;
	let previousItemCount = -1;

	function shouldTrigger(settings: Required<AutoReviewSettings>): boolean {
		if (!settings.enabled) return false;
		if (cycleState !== "idle") return false;
		const now = Date.now();
		if (now - lastAutoReviewTime < settings.cooldownMs) return false;
		return true;
	}

	function startReview(
		settings: Required<AutoReviewSettings>,
		scope: ReviewScope,
		autoFix: boolean,
		reason: string,
	) {
		if (!shouldTrigger(settings)) return;

		cycleState = "reviewing";
		cycleAutoFix = autoFix;
		fixRound = 0;
		previousItemCount = -1;
		lastAutoReviewTime = Date.now();

		const prompt = buildReviewPrompt(settings, scope, autoFix, reason);
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (err) {
			console.warn(`[auto-review] sendUserMessage failed: ${err instanceof Error ? err.message : err}`);
			cycleState = "idle";
		}
	}

	function handleFixRoundComplete(
		settings: Required<AutoReviewSettings>,
		cwd: string,
		_hasUI: boolean,
	) {
		const currentItemCount = countUnfixedItems(settings.todoPath, cwd);

		if (currentItemCount === 0) {
			cycleState = "idle";
			console.log("[auto-review] project is clean");
			return;
		}

		fixRound++;

		if (fixRound >= settings.maxFixRounds) {
			cycleState = "idle";
			console.log(`[auto-review] max fix rounds reached (${settings.maxFixRounds}), ${currentItemCount} items remain`);
			return;
		}

		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			cycleState = "idle";
			console.log(`[auto-review] diverging (${currentItemCount} items now vs ${previousItemCount} before), stopping`);
			return;
		}

		previousItemCount = currentItemCount;
		cycleState = "reviewing";

		const rereviewPrompt = buildRereviewPrompt(settings, fixRound, settings.maxFixRounds, currentItemCount, cycleAutoFix);
		try {
			pi.sendUserMessage(rereviewPrompt, { deliverAs: "followUp" });
		} catch (err) {
			console.warn(`[auto-review] sendUserMessage failed: ${err instanceof Error ? err.message : err}`);
			cycleState = "idle";
		}

		console.log(`[auto-review] fix loop round ${fixRound}/${settings.maxFixRounds} — ${currentItemCount} items remaining`);
	}

	// ── Session Start ────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		turnCount = 0;
		cycleState = "idle";
		cycleAutoFix = false;
		fixRound = 0;
		previousItemCount = -1;
		_cachedSettings = null;
		_cachedSettingsPath = "";
		_cachedMtimeKey = "";
		const settings = getSettings(ctx.cwd);

		if (settings.onSessionStart && shouldTrigger(settings)) {
			if (ctx.hasUI) {
				ctx.ui.notify("Review triggered (session start)", "info");
			}
			startReview(settings, settings.scope as ReviewScope, settings.autoFix, "session start");
		}
	});

	// ── Turn Counting ────────────────────────────────────────────────────

	pi.on("turn_end", () => {
		turnCount++;
	});

	// ── Agent End ────────────────────────────────────────────────────────

	pi.on("agent_end", (event, ctx) => {
		const settings = getSettings(ctx.cwd);
		const messages = event.messages as Array<{
			role: string;
			content?: string;
			toolName?: string;
		}>;

		// If we're in a review cycle, handle completion
		if (cycleState === "reviewing") {
			const currentItemCount = countUnfixedItems(settings.todoPath, ctx.cwd);
			previousItemCount = currentItemCount;

			if (cycleAutoFix) {
				handleFixRoundComplete(settings, ctx.cwd, ctx.hasUI);
			} else {
				cycleState = "idle";
				console.log("[auto-review] review complete");
			}
			return;
		}

		// Skip if any recent message is from our review cycle
		const isOurCycle = messages.slice(-10).some((m) => {
			const text = typeof m.content === "string" ? m.content : "";
			return text.includes(_REVIEW_SENTINEL) || text.includes(_REREVIEW_SENTINEL);
		});
		if (isOurCycle) return;

		// Real work triggers
		if (settings.onRalphDone && isRalphCompletion(messages)) {
			if (ctx.hasUI) {
				ctx.ui.notify("Review triggered (Ralph loop done)", "info");
			}
			startReview(settings, settings.scope as ReviewScope, settings.autoFix, "Ralph loop completion");
			return;
		}

		if (settings.onAgentEnd && turnCount >= settings.minTurns) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Review triggered (agent finished, ${turnCount} turns)`, "info");
			}
			startReview(settings, settings.scope as ReviewScope, settings.autoFix, `agent end (${turnCount} turns)`);
		}
	});

	// ── System prompt hints (sentinel-detected, no branding) ────────────

	pi.on("before_agent_start", (event, ctx) => {
		const text = event.prompt || "";
		if (!text.includes(_REVIEW_SENTINEL) && !text.includes(_REREVIEW_SENTINEL)) return;

		const settings = getSettings(ctx.cwd);
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nThis is a fix-only review — do NOT propose features or improvements. Methodology: build check, test suite, grep for FIXME/HACK/console.log/explicit any types, security scan (hardcoded secrets, eval), check dependency health. Write findings to: ${settings.todoPath}. Use <!-- auto-review-start --> and <!-- auto-review-end --> markers. Organize as 🔴 Critical / 🟡 Warning / 🟢 Info. At the end of ${settings.todoPath}, include: _Items found: N_ with the total count of unfixed [ ] items.`,
		};
	});
}