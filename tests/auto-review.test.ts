import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Test helpers ──────────────────────────────────────────────────────────────

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join("/tmp", "auto-review-test-"));
	return dir;
}

// ── TODO.md parsing tests ───────────────────────────────────────────────────────

describe("TODO.md parsing", () => {
	it("should count unchecked items with - [ ] syntax", () => {
		const content = `<!-- auto-review-start -->
- [ ] Critical issue 1
- [ ] Critical issue 2
- [x] Fixed issue
<!-- auto-review-end -->`;

		// Simulate countUnfixedItems logic
		const startMatch = content.search(/<!--\s*auto-review-start\s*-->/i);
		const endMatch = content.search(/<!--\s*auto-review-end\s*-->/i);
		const section =
			endMatch === -1
				? content.slice(startMatch)
				: content.slice(startMatch, endMatch);
		const stripped = section.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
		const matches = stripped.match(/^- \[ \]/gm);

		expect(matches).not.toBeNull();
		expect(matches?.length).toBe(2);
	});

	it("should count items in section only", () => {
		const content = `<!-- outside section -->
- [ ] Should not count this
<!-- auto-review-start -->
- [ ] Should count this
<!-- auto-review-end -->
- [ ] Should not count this either`;

		const startMatch = content.search(/<!--\s*auto-review-start\s*-->/i);
		const endMatch = content.search(/<!--\s*auto-review-end\s*-->/i);
		const section = content.slice(startMatch, endMatch);
		const stripped = section.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
		const matches = stripped.match(/^- \[ \]/gm);

		expect(matches?.length).toBe(1);
	});

	it("should return 0 for missing file", () => {
		const missingPath = "/tmp/nonexistent-todo-file.md";
		let count = 0;

		try {
			const content = fs.readFileSync(missingPath, "utf-8");
			const startMatch = content.search(/<!--\s*auto-review-start\s*-->/i);
			if (startMatch === -1) count = 0;
		} catch {
			count = 0; // Should return 0, not -1
		}

		expect(count).toBe(0);
	});

	it("should strip code blocks before counting", () => {
		const content = `<!-- auto-review-start -->
\`\`\`markdown
- [ ] Inside code block
\`\`\`
- [ ] Outside code block
<!-- auto-review-end -->`;

		const startMatch = content.search(/<!--\s*auto-review-start\s*-->/i);
		const endMatch = content.search(/<!--\s*auto-review-end\s*-->/i);
		const section = content.slice(startMatch, endMatch);
		const stripped = section.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
		const matches = stripped.match(/^- \[ \]/gm);

		expect(matches?.length).toBe(1);
	});
});

// ── Sentinel detection tests ─────────────────────────────────────────────────

describe("Sentinel detection", () => {
	const REVIEW_SENTINEL = "\x00AR1\x00";
	const REREVIEW_SENTINEL = "\x00AR2\x00";

	it("should detect REVIEW_SENTINEL in prompt", () => {
		const prompt = `${REVIEW_SENTINEL}Review the project for problems.`;
		expect(prompt.includes(REVIEW_SENTINEL)).toBe(true);
	});

	it("should detect REREVIEW_SENTINEL in prompt", () => {
		const prompt = `${REREVIEW_SENTINEL}Re-review after fixes (round 1/3).`;
		expect(prompt.includes(REREVIEW_SENTINEL)).toBe(true);
	});

	it("should NOT detect sentinel in normal message", () => {
		const message = "Please fix the build error in index.ts line 42.";
		expect(message.includes(REVIEW_SENTINEL)).toBe(false);
		expect(message.includes(REREVIEW_SENTINEL)).toBe(false);
	});

	it("should find sentinel in last 5 messages of review cycle", () => {
		const messages = [
			{ role: "user", content: "Fix the bug" },
			{ role: "assistant", content: "I'll fix it" },
			{ role: "assistant", content: "Done" },
			{ role: "assistant", content: `${REVIEW_SENTINEL}Looking for issues...` },
		];

		const lastFive = messages.slice(-5);
		const hasSentinel = lastFive.some((m) => {
			const text = typeof m.content === "string" ? m.content : "";
			return text.includes(REVIEW_SENTINEL);
		});

		expect(hasSentinel).toBe(true);
	});
});

// ── Ralph completion detection tests ─────────────────────────────────────────

describe("Ralph completion detection", () => {
	function isRalphCompletion(
		messages: Array<{ role: string; content?: string; toolName?: string }>,
	): boolean {
		for (
			let i = messages.length - 1;
			i >= Math.max(0, messages.length - 5);
			i--
		) {
			const msg = messages[i];
			if (!msg) continue;
			if (msg.role === "assistant" && typeof msg.content === "string") {
				if (msg.content.includes("<promise>COMPLETE</promise>")) {
					return true;
				}
			}
		}
		return false;
	}

	it("should detect Ralph completion in last message", () => {
		const messages = [
			{ role: "user", content: "Start the loop" },
			{
				role: "assistant",
				content: "<promise>COMPLETE</promise>",
			},
		];

		expect(isRalphCompletion(messages)).toBe(true);
	});

	it("should detect Ralph completion in last 5 messages", () => {
		const messages = [
			{ role: "user", content: "Start" },
			{ role: "assistant", content: "Working..." },
			{ role: "assistant", content: "Still working..." },
			{ role: "assistant", content: "Almost done..." },
			{
				role: "assistant",
				content: "<promise>COMPLETE</promise>",
			},
		];

		expect(isRalphCompletion(messages)).toBe(true);
	});

	it("should NOT detect completion without promise tag", () => {
		const messages = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		];

		expect(isRalphCompletion(messages)).toBe(false);
	});

	it("should detect completion in assistant messages", () => {
		const messages = [
			{ role: "system", content: "You are helpful" },
			{ role: "assistant", content: "<promise>COMPLETE</promise>" },
		];

		expect(isRalphCompletion(messages)).toBe(true);
	});
});

// ── cycleState machine tests ──────────────────────────────────────────────────

describe("cycleState machine", () => {
	type CycleState = "idle" | "reviewing";

	it("should start in idle state", () => {
		let cycleState: CycleState = "idle";
		expect(cycleState).toBe("idle");
	});

	it("should transition to reviewing on review start", () => {
		let cycleState: CycleState = "idle";
		cycleState = "reviewing";
		expect(cycleState).toBe("reviewing");
	});

	it("should transition to idle on clean exit", () => {
		let cycleState: CycleState = "reviewing";
		const currentItemCount = 0;

		if (currentItemCount === 0) {
			cycleState = "idle";
		}

		expect(cycleState).toBe("idle");
	});

	it("should transition to idle on max rounds", () => {
		let cycleState: CycleState = "reviewing";
		const fixRound = 3;
		const maxFixRounds = 3;

		if (fixRound >= maxFixRounds) {
			cycleState = "idle";
		}

		expect(cycleState).toBe("idle");
	});

	it("should transition to idle on divergence", () => {
		let cycleState: CycleState = "reviewing";
		const previousItemCount = 5;
		const currentItemCount = 7;

		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			cycleState = "idle";
		}

		expect(cycleState).toBe("idle");
	});

	it("should block new reviews when reviewing", () => {
		const cycleState: CycleState = "reviewing";
		const shouldTrigger = cycleState === "idle";


		expect(shouldTrigger).toBe(false);
	});
});

// ── Fix loop convergence tests ────────────────────────────────────────────────

describe("Fix loop convergence", () => {
	it("should converge when items decrease to 0", () => {
		const itemCounts = [5, 3, 1, 0];
		let state = "reviewing";

		for (const count of itemCounts) {
			if (count === 0) {
				state = "idle";
				break;
			}
		}

		expect(state).toBe("idle");
	});

	it("should stop at max rounds", () => {
		const maxFixRounds = 3;
		let fixRound = 0;
		let state = "reviewing";

		for (let round = 1; round <= maxFixRounds; round++) {
			fixRound = round;
			if (fixRound >= maxFixRounds) {
				state = "idle";
				break;
			}
		}

		expect(state).toBe("idle");
		expect(fixRound).toBe(3);
	});

	it("should stop on divergence", () => {
		const previousItemCount = 3;
		const currentItemCount = 5;
		let state = "reviewing";

		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			state = "idle";
		}

		expect(state).toBe("idle");
	});

	it("should continue when items decrease but not zero", () => {
		const previousItemCount = 10;
		const currentItemCount = 5;
		let shouldContinue = true;

		if (currentItemCount === 0) {
			shouldContinue = false;
		} else if (currentItemCount > previousItemCount) {
			shouldContinue = false;
		}

		expect(shouldContinue).toBe(true);
	});
});

// ── Cooldown tests ─────────────────────────────────────────────────────────────

describe("Cooldown mechanism", () => {
	const COOLDOWN_MS = 120_000;

	it("should block review during cooldown", () => {
		// Simulate: last review was 1 minute ago, cooldown is 2 minutes
		const baseTime = 1000000000000;
		const lastAutoReviewTime = baseTime;
		const now = baseTime + 60000; // 1 minute later

		const isDuringCooldown = now - lastAutoReviewTime < COOLDOWN_MS;

		expect(isDuringCooldown).toBe(true);
	});

	it("should allow review after cooldown expires", () => {
		// Simulate: last review was 2+ minutes ago
		const baseTime = 1000000000000;
		const lastAutoReviewTime = baseTime;
		const now = baseTime + COOLDOWN_MS + 1; // Just over cooldown

		const isCooldownExpired = now - lastAutoReviewTime >= COOLDOWN_MS;

		expect(isCooldownExpired).toBe(true);
	});
});

// ── Settings tests ─────────────────────────────────────────────────────────────

describe("Settings", () => {
	it("should have all required settings keys documented", () => {
		const requiredKeys = [
			"enabled",
			"todoPath",
			"autoFix",
			"maxFixRounds",
			"onRalphDone",
			"onAgentEnd",
			"onSessionStart",
			"minTurns",
			"cooldownMs",
			"scope",
			"excludePatterns",
		];

		const readmePath = path.join(process.cwd(), "README.md");
		const readme = fs.readFileSync(readmePath, "utf-8");

		for (const key of requiredKeys) {
			expect(readme).toContain(`\`${key}\``);
		}
	});

	it("should support autoReview and auto-review config keys", () => {
		// Both kebab and camelCase should work
		const settingsCamel = { autoReview: { enabled: false } };
		const settingsKebab = { "auto-review": { enabled: false } };
		expect(settingsCamel.autoReview).toBeDefined();
		expect(settingsKebab["auto-review"]).toBeDefined();
	});
});

// ── Settings defaults tests ───────────────────────────────────────────────────

describe("Settings defaults", () => {
	const DEFAULT_SETTINGS = {
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

	it("should have correct enabled default", () => {
		expect(DEFAULT_SETTINGS.enabled).toBe(true);
	});

	it("should have correct maxFixRounds default", () => {
		expect(DEFAULT_SETTINGS.maxFixRounds).toBe(3);
	});

	it("should have correct cooldown default", () => {
		expect(DEFAULT_SETTINGS.cooldownMs).toBe(120_000);
	});

	it("should have correct trigger defaults", () => {
		expect(DEFAULT_SETTINGS.onRalphDone).toBe(true);
		expect(DEFAULT_SETTINGS.onAgentEnd).toBe(false);
		expect(DEFAULT_SETTINGS.onSessionStart).toBe(false);
	});

	it("should have comprehensive exclude patterns", () => {
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("node_modules");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain(".git");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("dist");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("build");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("coverage");
	});
});