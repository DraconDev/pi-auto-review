/**
 * Auto Review Extension for Pi
 *
 * Event-driven project review: scans for problems after work completes,
 * writes findings to TODO.md, and optionally auto-fixes them in bounded
 * loops until the project is clean.
 *
 * PRIMARY TRIGGERS (automatic):
 *   - Ralph loop completion  (detects COMPLETE marker in agent_end)
 *   - agent_end              (after any significant agent work, configurable)
 *   - session_start          (optional, for fresh session reviews)
 *
 * MANUAL OVERRIDE:
 *   /review [staged|diff|fix|verify]
 *
 * FIX LOOP (when autoFix is enabled):
 *   review → fix → re-review → fix → re-review (clean) → done
 *   Bounded by maxFixRounds (default 3).
 *   Bails if diverging (new review finds more items than previous).
 *   Stops immediately if review finds 0 items (project is clean).
 *
 * Settings (in .pi/settings.json or ~/.pi/agent/settings.json):
 *   autoReview.todoPath          - path to todo file (default: "TODO.md")
 *   autoReview.autoFix           - after writing todos, go fix them (default: false)
 *   autoReview.maxFixRounds      - max review→fix→re-review loops (default: 3)
 *   autoReview.onRalphDone       - auto-review when Ralph loop completes (default: true)
 *   autoReview.onAgentEnd        - auto-review after any agent_end (default: false)
 *   autoReview.onSessionStart    - auto-review on session start (default: false)
 *   autoReview.minTurns          - minimum turns before agent_end triggers review (default: 3)
 *   autoReview.prompt            - custom review prompt (default: null)
 *   autoReview.scope             - "full" | "staged" | "diff" (default: "full")
 *   autoReview.excludePatterns   - dirs to exclude (default: ["node_modules", ...])
 *   autoReview.cooldownMs       - minimum ms between auto-reviews (default: 120000)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Constants ───────────────────────────────────────────────────────────────

/** Marker in initial and re-review prompts */
const REVIEW_MARKER = "[pi-auto-review]";
/** Marker in re-review prompts (so we know it's a loop iteration, not first pass) */
const REREVIEW_MARKER = "[pi-auto-review-rereview]";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Required<AutoReviewSettings> = {
	todoPath: "TODO.md",
	autoFix: false,
	maxFixRounds: 3,
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
	cooldownMs: 120_000,
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
	prompt?: string | null;
	scope?: "full" | "staged" | "diff";
	excludePatterns?: string[];
	cooldownMs?: number;
}

type ReviewScope = "full" | "staged" | "diff";

/**
 * State machine for the review/fix cycle.
 *
 * IDLE        → normal work, triggers armed
 * REVIEWING   → scan for problems (round 1, or re-review in a fix loop)
 * FIXING      → auto-fix in progress
 *
 * When fixing finishes in a fix loop:
 *   - If round < maxFixRounds → re-review (REVIEWING again)
 *   - If round >= maxFixRounds → IDLE (cap reached)
 *   - If re-review finds 0 items → IDLE (project clean)
 *   - If re-review finds MORE items → IDLE (diverging, bail)
 */
type CycleState = "idle" | "reviewing" | "fixing";

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

// ── Prompt Builders ─────────────────────────────────────────────────────────

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

At the very end of ${settings.todoPath}, add a line: _Items found: N_ where N is the total count of unfixed [ ] items.
Keep each item actionable and specific. Include file paths and line numbers where possible.
Do NOT add feature requests, architecture proposals, or "nice to have" items.${autoFixInstruction}`;
}

function buildRereviewPrompt(
	settings: Required<AutoReviewSettings>,
	round: number,
	maxRounds: number,
	previousItemCount: number,
): string {
	const roundLabel = `round ${round}/${maxRounds}`;

	return `${REREVIEW_MARKER} Re-review after fixes (${roundLabel}). The previous review found ${previousItemCount} items and fixes were applied.

Re-scan the project for remaining problems. This is a FIX-ONLY review just like the first pass.

Use the /skill:auto-review skill for the review methodology.

IMPORTANT:
- Check if the fixes from the previous round actually resolved the claimed issues
- Look for NEW problems that the fixes may have introduced
- If a previous fix didn't work, mark it clearly in ${settings.todoPath}

Write your findings to ${settings.todoPath}. Same format:
- 🔴 Critical / 🟡 Warning / 🟢 Info
- At the very end, add: _Items found: N_ where N is total unfixed [ ] items

If you find ZERO problems, write an empty TODO.md with just a header saying "Project is clean ✅".

Do NOT propose features. Only problems that need fixing.`;
}

// ── Ralph Detection ─────────────────────────────────────────────────────────

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

/**
 * Detect if agent just finished review/fix/rereview work
 * by checking messages for our markers.
 */
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
 * Count unfixed items in TODO.md by reading the file and counting `[ ]` lines.
 * Returns -1 if file doesn't exist or can't be read.
 */
function countUnfixedItems(todoPath: string, cwd: string): number {
	const fullPath = path.resolve(cwd, todoPath);
	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		const matches = content.match(/^- \[ \]/gm);
		return matches ? matches.length : 0;
	} catch {
		return -1;
	}
}

/**
 * Check if TODO.md says "Project is clean" — meaning 0 items found.
 */
function isProjectClean(todoPath: string, cwd: string): boolean {
	const fullPath = path.resolve(cwd, todoPath);
	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		return content.includes("Project is clean") || content.includes("Items found: 0");
	} catch {
		return false;
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Cycle state machine
	let cycleState: CycleState = "idle";
	// Cooldown tracking
	let lastAutoReviewTime = 0;
	// Turn counter for agent_end threshold
	let turnCount = 0;
	// Whether autoFix was requested for the current cycle
	let cycleAutoFix = false;
	// Fix loop tracking: which round we're on
	let fixRound = 0;
	// How many items the previous review found (for convergence check)
	let previousItemCount = -1;

	function shouldTrigger(settings: Required<AutoReviewSettings>): boolean {
		if (cycleState !== "idle") return false;
		const now = Date.now();
		if (now - lastAutoReviewTime < settings.cooldownMs) return false;
		return true;
	}

	function startReview(
		pi: ExtensionAPI,
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

	/**
	 * After a review+fix round completes, decide whether to re-review or stop.
	 */
	function handleFixRoundComplete(pi: ExtensionAPI, settings: Required<AutoReviewSettings>, ctx: { cwd: string; hasUI: boolean }) {
		const currentItemCount = countUnfixedItems(settings.todoPath, ctx.cwd);

		// ── Clean project → done! ────────────────────────────────────
		if (currentItemCount === 0 || isProjectClean(settings.todoPath, ctx.cwd)) {
			cycleState = "idle";
			if (ctx.hasUI) {
				pi.sendUserMessage("🔍 Auto-review: project is clean ✅", { deliverAs: "followUp" });
			}
			return;
		}

		fixRound++;

		// ── Hit max rounds → stop ───────────────────────────────────
		if (fixRound >= settings.maxFixRounds) {
			cycleState = "idle";
			if (ctx.hasUI) {
				pi.sendUserMessage(
					`🔍 Auto-review: reached max fix rounds (${settings.maxFixRounds}). ${currentItemCount} items remain in ${settings.todoPath}.`,
					{ deliverAs: "followUp" },
				);
			}
			return;
		}

		// ── Diverging (more items than before) → bail ────────────────
		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			cycleState = "idle";
			if (ctx.hasUI) {
				pi.sendUserMessage(
					`🔍 Auto-review: diverging (${currentItemCount} items now vs ${previousItemCount} before). Stopping fix loop — fixes may be causing new problems. ${currentItemCount} items remain in ${settings.todoPath}.`,
					{ deliverAs: "followUp" },
				);
			}
			return;
		}

		// ── Converging → re-review ───────────────────────────────────
		previousItemCount = currentItemCount;
		cycleState = "reviewing";

		const rereviewPrompt = buildRereviewPrompt(settings, fixRound, settings.maxFixRounds, currentItemCount);

		// In the fix loop, the re-review also tells the agent to fix
		if (cycleAutoFix) {
			// The rereview prompt doesn't include fix instructions by default,
			// but in a fix loop we want to keep fixing. Append fix instruction.
			const fixAppend = `\n\nAfter updating ${settings.todoPath}, fix the remaining problems. Cross off items as you fix them.`;
			pi.sendUserMessage(rereviewPrompt + fixAppend, { deliverAs: "followUp" });
		} else {
			pi.sendUserMessage(rereviewPrompt, { deliverAs: "followUp" });
		}

		if (ctx.hasUI) {
			pi.sendUserMessage(
				`🔍 Fix loop round ${fixRound}/${settings.maxFixRounds} — ${currentItemCount} items remaining, re-reviewing`,
				{ deliverAs: "followUp" },
			);
		}
	}

	// ── Session Start ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		turnCount = 0;
		cycleState = "idle";
		fixRound = 0;
		previousItemCount = -1;
		const settings = getSettings(ctx.cwd);

		if (settings.onSessionStart && shouldTrigger(settings)) {
			if (ctx.hasUI) {
				ctx.ui.notify("🔍 Auto-review triggered (session start)", "info");
			}
			startReview(pi, settings, settings.scope as ReviewScope, settings.autoFix, "session start");
		}
	});

	// ── Turn Counting ────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, _ctx) => {
		turnCount++;
	});

	// ── Agent End — the primary event-driven trigger ─────────────────────

	pi.on("agent_end", async (event, ctx) => {
		const settings = getSettings(ctx.cwd);
		const messages = event.messages as Array<{
			role: string;
			content?: string;
			toolName?: string;
		}>;

		// ── Review cycle transitions ──────────────────────────────────

		if (cycleState === "reviewing") {
			// Count items found by this review
			const currentItemCount = countUnfixedItems(settings.todoPath, ctx.cwd);
			previousItemCount = currentItemCount;

			if (cycleAutoFix) {
				// The review prompt included fix instructions.
				// The agent did review + fix in one pass.
				// Now decide: re-review or done?
				cycleState = "fixing";
				// handleFixRoundComplete will be called on the NEXT agent_end
				// (the fix work is part of the same agent session, so this
				// agent_end covers both review and fix)
				//
				// Actually: in Pi, a single agent session can span many turns.
				// The review+fix happens within one agent_start→agent_end.
				// So when we get here, both review and fix are done.
				// Decide right now whether to loop.
				handleFixRoundComplete(pi, settings, ctx);
			} else {
				// No autoFix — just a review. Done.
				cycleState = "idle";
				if (ctx.hasUI) {
					ctx.ui.notify("✅ Review complete", "info");
				}
			}
			return;
		}

		if (cycleState === "fixing") {
			// Fix work finished. Decide whether to re-review.
			handleFixRoundComplete(pi, settings, ctx);
			return;
		}

		// ── If idle, check for real-work triggers ──────────────────────

		// Never trigger a new review if the just-completed agent work
		// was itself part of a review cycle (safety net)
		if (isReviewCycleMessage(messages)) return;

		// Check Ralph completion
		if (settings.onRalphDone && isRalphCompletion(messages)) {
			if (ctx.hasUI) {
				ctx.ui.notify("🔍 Ralph loop done — triggering auto-review", "info");
			}
			startReview(pi, settings, settings.scope as ReviewScope, settings.autoFix, "Ralph loop completion");
			return;
		}

		// Check agent_end with minimum turn threshold
		if (settings.onAgentEnd && turnCount >= settings.minTurns) {
			if (ctx.hasUI) {
				ctx.ui.notify(`🔍 Agent finished (${turnCount} turns) — triggering auto-review`, "info");
			}
			startReview(pi, settings, settings.scope as ReviewScope, settings.autoFix, `agent end (${turnCount} turns)`);
		}
	});

	// ── /review command (manual override) ────────────────────────────────

	pi.registerCommand("review", {
		description: "Review project for problems and update TODO.md. Use: /review [staged|diff|fix]",
		getArgumentCompletions(prefix: string) {
			const options = [
				{ value: "staged", label: "staged", description: "Review only staged changes" },
				{ value: "diff", label: "diff", description: "Review diff from main branch" },
				{ value: "fix", label: "fix", description: "Review and auto-fix (loop until clean)" },
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

			// Override state for manual trigger
			cycleState = "reviewing";
			cycleAutoFix = autoFix;
			fixRound = 0;
			previousItemCount = -1;
			lastAutoReviewTime = Date.now();

			if (!ctx.isIdle()) {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("🔍 Review queued (agent is busy)", "info");
				return;
			}

			pi.sendUserMessage(prompt);
			ctx.ui.notify(`🔍 Review started (${scope}${autoFix ? " + auto-fix loop" : ""})`, "info");
		},
	});

	// ── System prompt hints ─────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		const text = event.prompt || "";
		const settings = getSettings(ctx.cwd);

		if (text.includes(REVIEW_MARKER) || text.includes(REREVIEW_MARKER)) {
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\n[auto-review extension] This is a fix-only review — do NOT propose features or improvements. The auto-review skill contains the methodology — load /skill:auto-review if needed. Write findings to: ${settings.todoPath}. Organize as 🔴 Critical / 🟡 Warning / 🟢 Info. At the end of ${settings.todoPath}, include a line: _Items found: N_ with the total count of unfixed [ ] items.`,
			};
		}
	});
}
