/**
 * Auto Review Extension for Pi
 *
 * Event-driven project review: scans for problems after work completes,
 * writes findings to TODO.md, and optionally auto-fixes them in bounded
 * loops until the project is clean.
 *
 * This extension is purely event-driven — there is no /review command.
 * Reviews trigger automatically when configured conditions are met.
 *
 * Settings (in .pi/settings.json or ~/.pi/agent/settings.json):
 *   autoReview.todoPath          - path to todo file (default: "TODO.md")
 *   autoReview.autoFix           - after writing todos, go fix them (default: false)
 *   autoReview.maxFixRounds      - max review→fix→re-review loops (default: 3)
 *   autoReview.onRalphDone       - auto-review when Ralph loop completes (default: true)
 *   autoReview.onAgentEnd        - auto-review after any agent_end (default: false)
 *   autoReview.onSessionStart    - auto-review on session start (default: false)
 *   autoReview.minTurns          - minimum turns before agent_end triggers review (default: 3)
 *   autoReview.scope             - "full" | "staged" | "diff" (default: "full")
 *   autoReview.excludePatterns   - dirs to exclude (default: ["node_modules", ...])
 *   autoReview.cooldownMs        - minimum ms between auto-reviews (default: 120000)
 *
 *   Custom prompts (all optional, override defaults):
 *   autoReview.prompt             - custom first-review prompt
 *   autoReview.rereviewPrompt     - custom re-review prompt (in fix loop)
 *   autoReview.fixInstruction     - custom instruction appended when autoFix is on
 *   autoReview.focusAreas         - override the default list of things to look for
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Constants ───────────────────────────────────────────────────────────────

const REVIEW_MARKER = "[pi-auto-review]";
const REREVIEW_MARKER = "[pi-auto-review-rereview]";

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

// ── Settings (cached per session) ─────────────────────────────────────────

let _cachedSettings: Required<AutoReviewSettings> | null = null;
let _cachedSettingsPath = "";
let _cachedMtimeKey = "";

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch (err) {
		if (fs.existsSync(filePath)) {
			const detail = err instanceof Error ? err.message : String(err);
			console.warn(`[auto-review] Warning: ${filePath} can't be read — ${detail}`);
		}
		return null;
	}
}

function getSettings(cwd: string): Required<AutoReviewSettings> {
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const globalSettingsPath = path.join(homedir(), ".pi", "agent", "settings.json");

	const mtimeKey = [projectSettingsPath, globalSettingsPath]
		.filter(fs.existsSync)
		.map((p) => `${p}:${fs.statSync(p).mtimeMs}`)
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

// ── Review methodology (inline) ───────────────────────────────────────────

const REVIEW_METHODOLOGY = `Use this FIX-ONLY review methodology:
1. **Build check** — run the project's build command and type checker (e.g., npm run build && npx tsc --noEmit)
2. **Test suite** — run the project's test command (e.g., npm test)
3. **Bug markers** — grep for FIXME, HACK, XXX, console.log, : any, as any in source files
4. **Security** — grep for hardcoded secrets (password=, api_key=, secret=), eval(), unsafe patterns
5. **Dependency health** — run npm ls to check for missing/broken deps`;

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
	triggerReason: string,
): string {
	if (settings.prompt) {
		let prompt = `${REVIEW_MARKER} ${settings.prompt}`;
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

	return `${REVIEW_MARKER} Auto-review triggered by: ${triggerReason}. ${scopeInstruction[scope]}${excludeNote}

${REVIEW_METHODOLOGY}

This is a FIX-ONLY review. Do NOT propose features or improvements. ONLY find problems that need fixing:
${getFocusList(settings)}

Write your findings to ${settings.todoPath}. Organize by priority:
- 🔴 Critical — broken build, security issues, data loss risk
- 🟡 Warning — failing tests, dead code, deprecation issues
- 🟢 Info — minor fixes, cleanup of accidental issues

At the very end of ${settings.todoPath}, add a line: _Items found: N_ where N is the total count of unfixed [ ] items.
Keep each item actionable and specific. Include file paths and line numbers where possible.
Do NOT add feature requests, architecture proposals, or "nice to have" items.${fixInstruction}`;
}

function buildRereviewPrompt(
	settings: Required<AutoReviewSettings>,
	round: number,
	maxRounds: number,
	previousItemCount: number,
	autoFix: boolean,
): string {
	if (settings.rereviewPrompt) {
		let prompt = `${REREVIEW_MARKER} ${settings.rereviewPrompt}`
			.replaceAll("{round}", String(round))
			.replaceAll("{maxRounds}", String(maxRounds))
			.replaceAll("{previousItems}", String(previousItemCount));
		if (prompt.includes("{focusAreas}")) {
			prompt = prompt.replaceAll("{focusAreas}", getFocusList(settings));
		}
		if (autoFix) {
			prompt += `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`;
		}
		return prompt;
	}

	const roundLabel = `round ${round}/${maxRounds}`;

	const fixAppend = autoFix
		? `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`
		: "";

	return `${REREVIEW_MARKER} Re-review after fixes (${roundLabel}). The previous review found ${previousItemCount} items and fixes were applied.

Re-scan the project for remaining problems.

${REVIEW_METHODOLOGY}

ONLY find problems that need fixing:
${getFocusList(settings)}

IMPORTANT:
- Check if the fixes from the previous round actually resolved the claimed issues
- Look for NEW problems that the fixes may have introduced
- If a previous fix didn't work, mark it clearly in ${settings.todoPath}

Write your findings to ${settings.todoPath}. Same format:
- 🔴 Critical / 🟡 Warning / 🟢 Info
- At the very end, add: _Items found: N_ where N is total unfixed [ ] items

If you find ZERO problems, write an empty ${settings.todoPath} with just a header saying "Project is clean ✅".

Do NOT propose features. Only problems that need fixing.${fixAppend}`;
}

// ── Detection helpers ───────────────────────────────────────────────────────

function isRalphCompletion(messages: Array<{ role: string; content?: string; toolName?: string }>): boolean {
	for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant" && typeof msg.content === "string") {
			if (msg.content.includes("<promise>COMPLETE</promise>")) return true;
		}
		if (msg.toolName === "ralph_done") return true;
	}
	return false;
}

function isReviewCycleMessage(messages: Array<{ role: string; content?: string; toolName?: string }>): boolean {
	for (let i = messages.length - 1; i >= Math.max(0, messages.length - 10); i--) {
		const msg = messages[i];
		if (!msg) continue;
		const text = typeof msg.content === "string" ? msg.content : "";
		if (text.includes(REVIEW_MARKER) || text.includes(REREVIEW_MARKER)) return true;
	}
	return false;
}

/**
 * Count unfixed [ ] items ONLY within the auto-generated section.
 * Avoids false positives from code blocks and examples.
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
		return -1;
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
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	function handleFixRoundComplete(
		settings: Required<AutoReviewSettings>,
		cwd: string,
		hasUI: boolean,
	) {
		const currentItemCount = countUnfixedItems(settings.todoPath, cwd);

		if (currentItemCount === 0) {
			cycleState = "idle";
			if (hasUI) {
				pi.sendUserMessage("🔍 Auto-review: project is clean ✅", { deliverAs: "followUp" });
			}
			return;
		}

		fixRound++;

		if (fixRound >= settings.maxFixRounds) {
			cycleState = "idle";
			if (hasUI) {
				pi.sendUserMessage(
					`🔍 Auto-review: reached max fix rounds (${settings.maxFixRounds}). ${currentItemCount} items remain in ${settings.todoPath}.`,
					{ deliverAs: "followUp" },
				);
			}
			return;
		}

		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			cycleState = "idle";
			if (hasUI) {
				pi.sendUserMessage(
					`🔍 Auto-review: diverging (${currentItemCount} items now vs ${previousItemCount} before). Stopping fix loop. ${currentItemCount} items remain in ${settings.todoPath}.`,
					{ deliverAs: "followUp" },
				);
			}
			return;
		}

		previousItemCount = currentItemCount;
		cycleState = "reviewing";

		const rereviewPrompt = buildRereviewPrompt(settings, fixRound, settings.maxFixRounds, currentItemCount, cycleAutoFix);
		pi.sendUserMessage(rereviewPrompt, { deliverAs: "followUp" });

		if (hasUI) {
			pi.sendUserMessage(
				`🔍 Fix loop round ${fixRound}/${settings.maxFixRounds} — ${currentItemCount} items remaining, re-reviewing`,
				{ deliverAs: "followUp" },
			);
		}
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
				ctx.ui.notify("🔍 Auto-review triggered (session start)", "info");
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

		if (cycleState === "reviewing") {
			const currentItemCount = countUnfixedItems(settings.todoPath, ctx.cwd);
			previousItemCount = currentItemCount;

			if (cycleAutoFix) {
				handleFixRoundComplete(settings, ctx.cwd, ctx.hasUI);
			} else {
				cycleState = "idle";
				if (ctx.hasUI) {
					ctx.ui.notify("✅ Review complete", "info");
				}
			}
			return;
		}

		if (isReviewCycleMessage(messages)) return;

		if (settings.onRalphDone && isRalphCompletion(messages)) {
			if (ctx.hasUI) {
				ctx.ui.notify("🔍 Ralph loop done — triggering auto-review", "info");
			}
			startReview(settings, settings.scope as ReviewScope, settings.autoFix, "Ralph loop completion");
			return;
		}

		if (settings.onAgentEnd && turnCount >= settings.minTurns) {
			if (ctx.hasUI) {
				ctx.ui.notify(`🔍 Agent finished (${turnCount} turns) — triggering auto-review`, "info");
			}
			startReview(settings, settings.scope as ReviewScope, settings.autoFix, `agent end (${turnCount} turns)`);
		}
	});

	// ── System prompt hints ─────────────────────────────────────────────

	pi.on("before_agent_start", (event, ctx) => {
		const text = event.prompt || "";
		const settings = getSettings(ctx.cwd);

		if (text.includes(REVIEW_MARKER) || text.includes(REREVIEW_MARKER)) {
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\nThis is a fix-only review — do NOT propose features or improvements. Methodology: build check (tsc --noEmit), test suite, grep for FIXME/HACK/console.log/: any, security scan (hardcoded secrets, eval), npm ls for dep health. Write findings to: ${settings.todoPath}. Organize as 🔴 Critical / 🟡 Warning / 🟢 Info. At the end of ${settings.todoPath}, include a line: _Items found: N_ with the total count of unfixed [ ] items.`,
			};
		}
	});
}