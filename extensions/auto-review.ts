/**
 * Auto Review Extension for Pi
 *
 * Event-driven project review: scans for problems after work completes,
 * writes findings to TODO.md, and optionally auto-fixes them.
 *
 * PRIMARY TRIGGERS (automatic):
 *   - Ralph loop completion  (detects COMPLETE marker in agent_end)
 *   - agent_end              (after any significant agent work, configurable)
 *   - session_start          (optional, for fresh session reviews)
 *
 * MANUAL OVERRIDE:
 *   /review [staged|diff|fix]
 *
 * Settings (in .pi/settings.json or ~/.pi/agent/settings.json):
 *   autoReview.todoPath          - path to todo file (default: "TODO.md")
 *   autoReview.autoFix           - after writing todos, go fix them (default: false)
 *   autoReview.onRalphDone       - auto-review when Ralph loop completes (default: true)
 *   autoReview.onAgentEnd        - auto-review after any agent_end (default: false)
 *   autoReview.onSessionStart    - auto-review on session start (default: false)
 *   autoReview.minTurns          - minimum turns before agent_end triggers review (default: 3)
 *   autoReview.prompt            - custom review prompt (default: null)
 *   autoReview.scope             - "full" | "staged" | "diff" (default: "full")
 *   autoReview.excludePatterns   - dirs to exclude (default: ["node_modules", ...])
 *   autoReview.cooldownMs       - minimum ms between auto-reviews (default: 120000 = 2 min)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Constants ───────────────────────────────────────────────────────────────

/** Unique marker injected into review prompts for reliable detection */
const REVIEW_MARKER = "[pi-auto-review]";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Required<AutoReviewSettings> = {
	todoPath: "TODO.md",
	autoFix: false,
	onRalphDone: true,
	onAgentEnd: false,
	onSessionStart: false,
	minTurns: 3,
	prompt: null,
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
	cooldownMs: 120_000, // 2 minutes between auto-reviews
};

// ── Types ───────────────────────────────────────────────────────────────────

interface AutoReviewSettings {
	todoPath?: string;
	autoFix?: boolean;
	onRalphDone?: boolean;
	onAgentEnd?: boolean;
	onSessionStart?: boolean;
	minTurns?: number;
	prompt?: string | null;
	scope?: "full" | "staged" | "diff";
	excludePatterns?: string[];
	cooldownMs?: number;
}

type ReviewScope = "full" | "staged" | "diff";

interface ParsedReviewArgs {
	scope: ReviewScope;
	autoFix: boolean;
}

// ── Settings ────────────────────────────────────────────────────────────────

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch (err) {
		if (fs.existsSync(filePath) && err instanceof SyntaxError) {
			console.warn(`[auto-review] Warning: ${filePath} has invalid JSON — using defaults`);
		}
		return null;
	}
}

function getSettings(cwd: string): Required<AutoReviewSettings> {
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");

	for (const settingsPath of [projectSettingsPath, globalSettingsPath]) {
		const data = readSettingsJson(settingsPath);
		if (data) {
			const raw = data.autoReview ?? data["auto-review"];
			if (raw && typeof raw === "object") {
				return { ...DEFAULT_SETTINGS, ...(raw as AutoReviewSettings) };
			}
		}
	}
	return { ...DEFAULT_SETTINGS };
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

function buildReviewPrompt(
	settings: Required<AutoReviewSettings>,
	scope: ReviewScope,
	autoFix: boolean,
	triggerReason: string,
): string {
	if (settings.prompt) {
		let prompt = `${REVIEW_MARKER} ${settings.prompt}`;
		if (autoFix) {
			prompt += "\n\nAfter updating the todo list, go ahead and fix the problems you found. Work through items in priority order.";
		}
		return prompt;
	}

	const scopeInstruction: Record<ReviewScope, string> = {
		full: "Review the entire project for problems.",
		staged: "Review only the staged git changes for problems.",
		diff: "Review the diff from the main branch for problems.",
	};

	const excludeNote = settings.excludePatterns.length > 0
		? `\nExclude these directories: ${settings.excludePatterns.join(", ")}.`
		: "";

	const autoFixInstruction = autoFix
		? `\n\nAfter updating ${settings.todoPath}, go ahead and fix the problems you found. Work through items in priority order. Cross off items in ${settings.todoPath} as you fix them.`
		: "";

	return `${REVIEW_MARKER} Auto-review triggered by: ${triggerReason}. ${scopeInstruction[scope]}${excludeNote}

Use the /skill:auto-review skill for the review methodology.

This is a FIX-ONLY review. Do NOT propose features or improvements. ONLY find problems that need fixing:
- Lint errors, type errors, build failures
- Failing or missing tests
- Security vulnerabilities
- Broken imports or missing dependencies
- Dead code, unreachable branches
- TODO/FIXME/HACK comments that indicate known BUGS (not feature ideas)
- Inconsistencies between code and config
- Performance problems that are bugs (N+1 queries, memory leaks)

Write your findings to ${settings.todoPath}. Organize by priority:
- 🔴 Critical — broken build, security issues, data loss risk
- 🟡 Warning — failing tests, dead code, deprecation issues
- 🟢 Info — minor fixes, cleanup of accidental issues

Keep each item actionable and specific. Include file paths and line numbers where possible.
Do NOT add feature requests, architecture proposals, or "nice to have" items.${autoFixInstruction}`;
}

// ── Ralph Detection ─────────────────────────────────────────────────────────

/**
 * Detect if a Ralph loop just completed by checking agent_end messages
 * for the Ralph COMPLETE marker or ralph_done tool calls.
 */
function isRalphCompletion(messages: Array<{ role: string; content?: string; toolName?: string }>): boolean {
	for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
		const msg = messages[i];
		if (!msg) continue;

		// Check assistant messages for the completion marker
		if (msg.role === "assistant" && typeof msg.content === "string") {
			if (msg.content.includes("<promise>COMPLETE</promise>")) {
				return true;
			}
		}

		// Check tool results for ralph_done
		if (msg.toolName === "ralph_done") {
			return true;
		}
	}
	return false;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Cooldown tracking
	let lastAutoReviewTime = 0;
	// Turn counter for agent_end threshold
	let turnCount = 0;
	// Whether a review is already in-flight (prevent re-triggering)
	let reviewInFlight = false;

	function shouldTrigger(settings: Required<AutoReviewSettings>): boolean {
		if (reviewInFlight) return false;
		const now = Date.now();
		if (now - lastAutoReviewTime < settings.cooldownMs) return false;
		return true;
	}

	function triggerReview(
		pi: ExtensionAPI,
		settings: Required<AutoReviewSettings>,
		scope: ReviewScope,
		autoFix: boolean,
		reason: string,
	) {
		if (!shouldTrigger(settings)) return;

		reviewInFlight = true;
		lastAutoReviewTime = Date.now();

		const prompt = buildReviewPrompt(settings, scope, autoFix, reason);

		// Send as followUp to avoid interrupting any current work
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });

		// Reset the in-flight flag after a generous timeout
		setTimeout(() => {
			reviewInFlight = false;
		}, 60_000);
	}

	// ── Session Start ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		turnCount = 0;
		reviewInFlight = false;
		const settings = getSettings(ctx.cwd);

		if (settings.onSessionStart && shouldTrigger(settings)) {
			lastAutoReviewTime = Date.now();
			reviewInFlight = true;

			const prompt = buildReviewPrompt(
				settings,
				settings.scope as ReviewScope,
				settings.autoFix,
				"session start",
			);

			pi.sendUserMessage(prompt, { deliverAs: "followUp" });

			setTimeout(() => {
				reviewInFlight = false;
			}, 60_000);

			if (ctx.hasUI) {
				ctx.ui.notify("🔍 Auto-review triggered (session start)", "info");
			}
		}
	});

	// ── Turn Counting ────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, _ctx) => {
		turnCount++;
	});

	// ── Agent End — the primary event-driven trigger ─────────────────────
	//
	// This fires after every agent prompt completes. We check:
	//   1. Was this a Ralph loop completion?  → onRalphDone
	//   2. Was this a long enough agent run?   → onAgentEnd (with minTurns)

	pi.on("agent_end", async (event, ctx) => {
		const settings = getSettings(ctx.cwd);

		// Check Ralph completion
		if (settings.onRalphDone) {
			const messages = event.messages as Array<{
				role: string;
				content?: string;
				toolName?: string;
			}>;
			if (isRalphCompletion(messages)) {
				if (ctx.hasUI) {
					ctx.ui.notify("🔍 Ralph loop done — triggering auto-review", "info");
				}
				triggerReview(pi, settings, settings.scope as ReviewScope, settings.autoFix, "Ralph loop completion");
				return; // Don't double-trigger
			}
		}

		// Check agent_end with minimum turn threshold
		if (settings.onAgentEnd && turnCount >= settings.minTurns) {
			if (ctx.hasUI) {
				ctx.ui.notify(`🔍 Agent finished (${turnCount} turns) — triggering auto-review`, "info");
			}
			triggerReview(pi, settings, settings.scope as ReviewScope, settings.autoFix, `agent end (${turnCount} turns)`);
		}
	});

	// ── /review command (manual override) ────────────────────────────────

	pi.registerCommand("review", {
		description: "Review project for problems and update TODO.md. Use: /review [staged|diff|fix]",
		getArgumentCompletions(prefix: string) {
			const options = [
				{ value: "staged", label: "staged", description: "Review only staged changes" },
				{ value: "diff", label: "diff", description: "Review diff from main branch" },
				{ value: "fix", label: "fix", description: "Review and auto-fix problems" },
			];
			const filtered = options.filter((o) => o.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const settings = getSettings(ctx.cwd);
			const normalized = (args || "").trim().toLowerCase();

			let scope: ReviewScope = settings.scope as ReviewScope;
			let autoFix = settings.autoFix;

			if (normalized === "staged") scope = "staged";
			else if (normalized === "diff") scope = "diff";
			else if (normalized === "fix") {
				scope = "full";
				autoFix = true;
			}

			const prompt = buildReviewPrompt(settings, scope, autoFix, "manual /review command");

			if (!ctx.isIdle()) {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("🔍 Review queued (agent is busy)", "info");
				return;
			}

			pi.sendUserMessage(prompt);
			ctx.ui.notify(`🔍 Review started (${scope}${autoFix ? " + auto-fix" : ""})`, "info");
		},
	});

	// ── System prompt hint for review prompts ───────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		const text = event.prompt || "";
		if (!text.includes(REVIEW_MARKER)) return;

		const settings = getSettings(ctx.cwd);
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[auto-review extension] This is a fix-only review — do NOT propose features or improvements. The auto-review skill contains the methodology — load /skill:auto-review if needed. Write findings to: ${settings.todoPath}. Organize as 🔴 Critical / 🟡 Warning / 🟢 Info.`,
		};
	});

	// ── Reset in-flight flag when review agent ends ─────────────────────

	pi.on("agent_end", async (_event, _ctx) => {
		// The review prompt triggers its own agent_end; reset the flag
		// so future auto-reviews can fire
		reviewInFlight = false;
	});
}
