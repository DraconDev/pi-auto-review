/**
 * Auto Review Extension for Pi
 *
 * Scans the project for problems, writes findings to TODO.md,
 * and optionally tells the agent to go fix them.
 *
 * Triggers:
 *   - Manual: /review, /review staged, /review diff, /review fix
 *   - Automatic: onSessionStart, onDirty (configurable)
 *
 * Settings (in .pi/settings.json or ~/.pi/agent/settings.json):
 *   autoReview.todoPath        - path to todo file (default: "TODO.md")
 *   autoReview.autoRun         - after building todo, go fix (default: false)
 *   autoReview.onSessionStart  - auto-review on session start (default: false)
 *   autoReview.onDirty         - auto-review when dirty repo detected (default: false)
 *   autoReview.prompt          - custom review prompt (default: null)
 *   autoReview.scope           - "full" | "staged" | "diff" (default: "full")
 *   autoReview.excludePatterns - dirs to exclude (default: ["node_modules", ...])
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
	autoRun: false,
	onSessionStart: false,
	onDirty: false,
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
};

// ── Types ───────────────────────────────────────────────────────────────────

interface AutoReviewSettings {
	todoPath?: string;
	autoRun?: boolean;
	onSessionStart?: boolean;
	onDirty?: boolean;
	prompt?: string | null;
	scope?: "full" | "staged" | "diff";
	excludePatterns?: string[];
}

/** Scope of files to review */
type ReviewScope = "full" | "staged" | "diff";

/** Parsed result from /review command arguments */
interface ParsedReviewArgs {
	scope: ReviewScope;
	autoRun: boolean;
}

// ── Settings Reader ─────────────────────────────────────────────────────────

function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch (err) {
		// Only log if the file exists but can't be parsed (not missing — that's expected)
		if (fs.existsSync(filePath) && (err instanceof SyntaxError)) {
			console.warn(`[auto-review] Warning: ${filePath} exists but has invalid JSON — using defaults`);
		}
		return null;
	}
}

function getSettings(cwd: string): Required<AutoReviewSettings> {
	// Try project-level settings first, then global
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseReviewArgs(args: string, baseScope: string): ParsedReviewArgs {
	const normalized = args.trim().toLowerCase();
	if (normalized === "staged") return { scope: "staged", autoRun: false };
	if (normalized === "diff") return { scope: "diff", autoRun: false };
	if (normalized === "fix") return { scope: "full", autoRun: true };
	return { scope: baseScope as ReviewScope, autoRun: false };
}

function buildReviewPrompt(settings: Required<AutoReviewSettings>, scope: ReviewScope, autoRun: boolean): string {
	// If the user provided a custom prompt, use it with minimal framing
	if (settings.prompt) {
		let prompt = `${REVIEW_MARKER} ${settings.prompt}`;
		if (autoRun) {
			prompt += "\n\nAfter updating the todo list, go ahead and fix the problems you found. Work through the items in priority order.";
		}
		return prompt;
	}

	// Build the default review prompt
	const scopeInstruction: Record<ReviewScope, string> = {
		full: "Review the entire project for problems.",
		staged: "Review only the staged git changes for problems.",
		diff: "Review the diff from the main branch for problems.",
	};

	const excludeNote = settings.excludePatterns.length > 0
		? `\nExclude these directories: ${settings.excludePatterns.join(", ")}.`
		: "";

	const autoRunInstruction = autoRun
		? `\n\nAfter updating ${settings.todoPath}, go ahead and fix the problems you found. Work through the items in priority order. Cross off items in ${settings.todoPath} as you fix them.`
		: "";

	return `${REVIEW_MARKER} Run an auto-review of this project. ${scopeInstruction[scope]}${excludeNote}

Use the /skill:auto-review skill for the review methodology. Load it now by reading the SKILL.md file.

Focus on finding PROBLEMS that need fixing — not features to add. Look for:
- Lint errors, type errors, build failures
- Failing or missing tests
- Security vulnerabilities
- Broken imports or missing dependencies
- Dead code, unreachable branches
- TODO/FIXME/HACK comments that indicate known issues
- Inconsistencies between code and config
- Performance bottlenecks

Write your findings to ${settings.todoPath}. Organize by priority:
- 🔴 Critical — broken build, security issues, data loss risk
- 🟡 Warning — failing tests, dead code, deprecation issues
- 🟢 Info — TODOs, style issues, minor improvements

Keep each item actionable and specific. Include file paths and line numbers where possible.${autoRunInstruction}`;
}

// ── Dirty Repo Check ────────────────────────────────────────────────────────

async function isDirtyRepo(pi: ExtensionAPI): Promise<boolean> {
	try {
		const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
		if (code !== 0) {
			// Not a git repo or git not available — that's fine, not dirty
			return false;
		}
		return stdout.trim().length > 0;
	} catch {
		// git not installed or other failure — skip dirty check
		return false;
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Track whether we've already triggered an auto-review this session
	let hasAutoReviewed = false;
	// Current settings (refreshed on session start)
	let currentSettings: Required<AutoReviewSettings> = { ...DEFAULT_SETTINGS };

	// ── Session Start: check auto-trigger conditions ─────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentSettings = getSettings(ctx.cwd);
		let shouldReview = false;

		// Check onSessionStart trigger
		if (currentSettings.onSessionStart && !hasAutoReviewed) {
			shouldReview = true;
		}

		// Check onDirty trigger
		if (currentSettings.onDirty && !hasAutoReviewed) {
			const dirty = await isDirtyRepo(pi);
			if (dirty) {
				shouldReview = true;
			}
		}

		if (shouldReview) {
			hasAutoReviewed = true;
			const prompt = buildReviewPrompt(
				currentSettings,
				currentSettings.scope as ReviewScope,
				currentSettings.autoRun,
			);

			if (ctx.hasUI) {
				ctx.ui.notify("🔍 Auto-review triggered", "info");
			}

			// Send as follow-up to ensure session is fully initialized
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}
	});

	// ── /review command ──────────────────────────────────────────────────

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
			const { scope, autoRun: cmdAutoRun } = parseReviewArgs(args || "", settings.scope);
			const effectiveAutoRun = cmdAutoRun || settings.autoRun;

			const prompt = buildReviewPrompt(settings, scope, effectiveAutoRun);

			if (!ctx.isIdle()) {
				// Queue as follow-up if agent is busy
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("🔍 Review queued (agent is busy)", "info");
				return;
			}

			pi.sendUserMessage(prompt);
			ctx.ui.notify(`🔍 Review started (${scope}${effectiveAutoRun ? " + auto-fix" : ""})`, "info");
		},
	});

	// ── System prompt hint when review is active ─────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		// Only inject system prompt hints for our own review prompts (identified by marker)
		const text = event.prompt || "";
		if (!text.includes(REVIEW_MARKER)) return;

		const settings = getSettings(ctx.cwd);
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[auto-review extension] The user wants a project review. The auto-review skill contains the detailed methodology — load it with /skill:auto-review. Write findings to: ${settings.todoPath}. Focus on problems, not features.`,
		};
	});
}
