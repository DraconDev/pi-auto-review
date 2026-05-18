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
 *   /review [staged|diff|fix|verify]
 *
 * CYCLE:
 *   IDLE → REVIEWING → (if autoFix) FIXING → VERIFYING → IDLE
 *   IDLE → REVIEWING → (if no autoFix) IDLE
 *
 *   The review cycle NEVER re-triggers itself. Only real work (non-review
 *   agent_end) can start a new cycle.
 *
 * Settings (in .pi/settings.json or ~/.pi/agent/settings.json):
 *   autoReview.todoPath          - path to todo file (default: "TODO.md")
 *   autoReview.autoFix           - after writing todos, go fix them (default: false)
 *   autoReview.verify            - after auto-fix, run verification pass (default: true)
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
/** Marker for verification prompts (lighter, no re-trigger) */
const VERIFY_MARKER = "[pi-auto-review-verify]";

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Required<AutoReviewSettings> = {
	todoPath: "TODO.md",
	autoFix: false,
	verify: true,
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
	verify?: boolean;
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
 * State machine for the review cycle.
 *
 * IDLE        → normal work happening, triggers are armed
 * REVIEWING   → review prompt sent, waiting for agent to finish scanning
 * FIXING      → auto-fix in progress (agent is working through TODO items)
 * VERIFYING   → post-fix verification pass running
 *
 * Only transitions back to IDLE after the full cycle completes.
 * While in REVIEWING/FIXING/VERIFYING, no new auto-reviews can trigger.
 */
type CycleState = "idle" | "reviewing" | "fixing" | "verifying";

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

Keep each item actionable and specific. Include file paths and line numbers where possible.
Do NOT add feature requests, architecture proposals, or "nice to have" items.${autoFixInstruction}`;
}

function buildVerifyPrompt(settings: Required<AutoReviewSettings>): string {
	return `${VERIFY_MARKER} Post-fix verification: check that the auto-fix changes actually resolved the issues in ${settings.todoPath}.

This is a VERIFICATION pass, not a new full review. Do NOT scan for new problems. ONLY:
1. Read ${settings.todoPath}
2. For each item marked [x] (claimed fixed): verify the fix actually works (run build, run tests, check the code)
3. For each item still [ ] (unfixed): note it remains unfixed
4. If a claimed fix didn't work: change [x] back to [ ] and add a ⚠️ note
5. Remove items that are confirmed fixed and no longer relevant

Update ${settings.todoPath} with the verification results. Add a "Verified: YYYY-MM-DD" line under the header.
Do NOT add new review items. Do NOT fix anything. Just verify.`;
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
 * Detect if the agent just completed a review/fix/verify cycle
 * by checking messages for our markers.
 */
function isReviewCycleMessage(messages: Array<{ role: string; content?: string; toolName?: string }>): boolean {
	for (let i = messages.length - 1; i >= Math.max(0, messages.length - 10); i--) {
		const msg = messages[i];
		if (!msg) continue;
		const text = typeof msg.content === "string" ? msg.content : "";
		if (text.includes(REVIEW_MARKER) || text.includes(VERIFY_MARKER)) return true;
	}
	return false;
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
		lastAutoReviewTime = Date.now();

		const prompt = buildReviewPrompt(settings, scope, autoFix, reason);
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	// ── Session Start ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		turnCount = 0;
		cycleState = "idle";
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
	//
	// Two responsibilities:
	//   1. Detect real work completion (Ralph, long agent run) → start review
	//   2. Detect review cycle completion → advance state machine

	pi.on("agent_end", async (event, ctx) => {
		const settings = getSettings(ctx.cwd);
		const messages = event.messages as Array<{
			role: string;
			content?: string;
			toolName?: string;
		}>;

		// ── If we're in the review cycle, handle state transitions ──────

		if (cycleState === "reviewing") {
			// Review just finished.
			// If autoFix was requested, the review prompt told the agent to fix
			// things. The agent may have done review + fix in one pass, or
			// just the review. Either way, if autoFix was on, transition to
			// fixing state; if verify is on, we'll verify after fixing.
			if (cycleAutoFix) {
				cycleState = "fixing";
				// The fix work is happening within the same agent_end or
				// will be the next agent prompt. We'll detect when fixing
				// is done by the NEXT agent_end that isn't part of the
				// review cycle.
				//
				// Actually: the review prompt with autoFix causes the agent
				// to do review + fix in ONE agent session. When that
				// session ends (this agent_end), both are done. So transition
				// straight to verifying if configured.
				if (settings.verify) {
					cycleState = "verifying";
					const verifyPrompt = buildVerifyPrompt(settings);
					pi.sendUserMessage(verifyPrompt, { deliverAs: "followUp" });
					if (ctx.hasUI) {
						ctx.ui.notify("✅ Fixes applied — running verification pass", "info");
					}
				} else {
					cycleState = "idle";
					if (ctx.hasUI) {
						ctx.ui.notify("✅ Review + fixes complete", "info");
					}
				}
			} else {
				// No autoFix — review is done, back to idle
				cycleState = "idle";
				if (ctx.hasUI) {
					ctx.ui.notify("✅ Review complete", "info");
				}
			}
			return; // Don't process triggers for review-cycle agent_ends
		}

		if (cycleState === "fixing") {
			// Fix work finished. Start verification if configured.
			if (settings.verify) {
				cycleState = "verifying";
				const verifyPrompt = buildVerifyPrompt(settings);
				pi.sendUserMessage(verifyPrompt, { deliverAs: "followUp" });
				if (ctx.hasUI) {
					ctx.ui.notify("✅ Fixes applied — running verification pass", "info");
				}
			} else {
				cycleState = "idle";
				if (ctx.hasUI) {
					ctx.ui.notify("✅ Review + fixes complete", "info");
				}
			}
			return;
		}

		if (cycleState === "verifying") {
			// Verification pass finished. Back to idle.
			cycleState = "idle";
			if (ctx.hasUI) {
				ctx.ui.notify("✅ Review cycle complete (verified)", "info");
			}
			return;
		}

		// ── If we're idle, check for real-work triggers ────────────────

		// Never trigger a new review if the just-completed agent work
		// was itself a review cycle (safety check)
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
		description: "Review project for problems and update TODO.md. Use: /review [staged|diff|fix|verify]",
		getArgumentCompletions(prefix: string) {
			const options = [
				{ value: "staged", label: "staged", description: "Review only staged changes" },
				{ value: "diff", label: "diff", description: "Review diff from main branch" },
				{ value: "fix", label: "fix", description: "Review and auto-fix problems" },
				{ value: "verify", label: "verify", description: "Verify recent fixes worked" },
			];
			const filtered = options.filter((o) => o.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const settings = getSettings(ctx.cwd);
			const normalized = (args || "").trim().toLowerCase();

			// /review verify — manual verification pass
			if (normalized === "verify") {
				const verifyPrompt = buildVerifyPrompt(settings);
				cycleState = "verifying";
				if (!ctx.isIdle()) {
					pi.sendUserMessage(verifyPrompt, { deliverAs: "followUp" });
					ctx.ui.notify("🔍 Verification queued (agent is busy)", "info");
					return;
				}
				pi.sendUserMessage(verifyPrompt);
				ctx.ui.notify("🔍 Verification pass started", "info");
				return;
			}

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
			lastAutoReviewTime = Date.now();

			if (!ctx.isIdle()) {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("🔍 Review queued (agent is busy)", "info");
				return;
			}

			pi.sendUserMessage(prompt);
			ctx.ui.notify(`🔍 Review started (${scope}${autoFix ? " + auto-fix" : ""})`, "info");
		},
	});

	// ── System prompt hints ─────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		const text = event.prompt || "";
		const settings = getSettings(ctx.cwd);

		if (text.includes(REVIEW_MARKER)) {
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\n[auto-review extension] This is a fix-only review — do NOT propose features or improvements. The auto-review skill contains the methodology — load /skill:auto-review if needed. Write findings to: ${settings.todoPath}. Organize as 🔴 Critical / 🟡 Warning / 🟢 Info.`,
			};
		}

		if (text.includes(VERIFY_MARKER)) {
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\n[auto-review extension] This is a VERIFICATION pass — do NOT scan for new problems or fix anything. ONLY verify whether the fixes in ${settings.todoPath} actually resolved the issues. Update checkmarks and add verification notes.`,
			};
		}
	});
}
