/**
 * pi-harness — apply harness engineering from
 * https://github.com/walkinglabs/learn-harness-engineering inside Pi.
 *
 * Commands:
 *   /ha-init [name]      scaffold <PI_HARNESS_ROOT>/<name> and make it active
 *                        (init.sh is optional: pass --no-init to skip it)
 *   /ha-use [name]       switch the active harness
 *   /ha-list             list every harness workspace
 *   /ha-status           show the active harness and feature state
 *   /ha-learn [name]     scan the source code and seed the harness docs/features
 *   /ha-edit [name]      rename a harness and/or change its path or project root
 *   /ha-validate [name]  score the harness across the five subsystems
 *   /ha-disable          turn pi-harness off (no harness injection)
 *   /ha-enable           turn pi-harness back on
 *
 * The active harness is injected into the system prompt on every turn, so the
 * agent looks in the harness folder for the index, feature list, progress, and
 * handoff files without being told each time.
 */

import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	FEATURE_STATUSES,
	type Feature,
	type FeatureSummary,
	HARNESS_ROOT,
	type HarnessState,
	type LearnResult,
	type ProjectRecord,
	type ValidationResult,
	detectProjectForCwd,
	detectRepoName,
	findProjectByName,
	getProject,
	listProjects,
	loadState,
	learnProject,
	editProject,
	pathExists,
	projectDir,
	readFeatureList,
	readText,
	resolveHarnessFile,
	resolveProject,
	sanitizeName,
	saveState,
	scaffoldProject,
	setActive,
	setEnabled,
	summarizeFeatures,
	updateFeature,
	validateProject,
} from "./lib.ts";

const STATUS_LABEL: Record<string, string> = {
	"not-started": "not started",
	"in-progress": "in progress",
	blocked: "blocked",
	done: "done",
};

function parseCommandArgs(args: string): { positional: string[]; flags: Record<string, string | boolean> } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (const token of tokens) {
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq >= 0) flags[token.slice(2, eq)] = token.slice(eq + 1);
			else flags[token.slice(2)] = true;
		} else {
			positional.push(token);
		}
	}
	return { positional, flags };
}

function flag(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = flags[name];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function isTruthy(value: string | boolean | undefined): boolean {
	return value === true || value === "true" || value === "1" || value === "yes";
}

function formatFeatureLine(feature: Feature): string {
	const deps = feature.dependencies?.length ? ` (deps: ${feature.dependencies.join(", ")})` : "";
	return `${feature.id} [${STATUS_LABEL[feature.status] ?? feature.status}] ${feature.name}${deps}`;
}

function formatSummary(summary: FeatureSummary): string {
	const lines = [
		`Features: ${summary.done}/${summary.total} done, ${summary.inProgress} in progress, ${summary.blocked} blocked, ${summary.notStarted} not started`,
	];
	if (summary.active) lines.push(`Active: ${formatFeatureLine(summary.active)}`);
	if (summary.next) lines.push(`Next: ${formatFeatureLine(summary.next)}`);
	return lines.join("\n");
}

function buildHarnessSection(record: ProjectRecord, summary: FeatureSummary | undefined): string {
	const lines = [
		`## Harness (active)`,
		``,
		`Active harness project: ${record.name}`,
		`Harness root: ${record.path}`,
		`Project root (code): ${record.projectRoot}`,
		``,
		`Default lookup: when asked for the harness index, feature list, progress log,`,
		`session handoff, roadmap, architecture/product docs, or verification commands,`,
		`read them from the harness root above first. Do not guess or read from an`,
		`unrelated cwd unless the harness lacks the file.`,
		``,
		`Key files: index.md, AGENTS.md, feature_list.json, progress.md, session-handoff.md, init.sh`,
	];
	if (summary) {
		lines.push(``);
		lines.push(`Feature state: ${summary.done}/${summary.total} done, ${summary.inProgress} in progress, ${summary.blocked} blocked`);
		if (summary.active) lines.push(`Active feature: ${formatFeatureLine(summary.active)}`);
		if (summary.next) lines.push(`Next feature: ${formatFeatureLine(summary.next)}`);
	}
	lines.push(`Rules: one feature at a time; run ./init.sh before claiming done; record evidence before status done.`);
	return lines.join("\n");
}

function formatValidation(result: ValidationResult, name: string): string {
	const lines = [`Harness validation: ${name}`, `Overall: ${result.overall}/100`, `Bottleneck: ${result.bottleneck ?? "none"}`];
	for (const [subsystem, data] of Object.entries(result.subsystems)) {
		lines.push(`- ${subsystem}: ${data.score}/5 (${data.passed}/${data.total})`);
	}
	return lines.join("\n");
}

function truncate(text: string, limit = 20000): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[truncated: ${text.length - limit} more characters. Read the file directly for the rest.]`;
}

function buildLearnPrompt(record: ProjectRecord, result: LearnResult): string {
	return `/ha-learn seeded the harness at ${record.path} from a scan of ${result.root}.

Scan summary: ${result.files} files, ${result.lines} lines, ${result.featuresAdded} candidate feature(s) added, ${result.todos} debt marker(s). Files written: ${result.written.join(", ")}.

Do a deep learning pass now, working only inside the harness and the source root:

1. Read the seeded artifacts: docs/ARCHITECTURE.md, docs/SOURCE-MAP.md, docs/PRODUCT.md, feature_list.json, quality-document.md, index.md.
2. Study the real source at ${result.root} (read, grep, find) to verify every claim.
3. Rewrite docs/ARCHITECTURE.md with the confirmed architecture: components, responsibilities, boundaries, data flow, and key files.
4. Rewrite docs/PRODUCT.md with confirmed product intent and user-visible behavior.
5. Refine feature_list.json with the harness tool: correct names/descriptions, add dependencies, prioritize, and set status/evidence only when verified.
6. Update progress.md and session-handoff.md so the next session can resume.

Do not mark any feature done without recorded evidence. Report what you changed.`;
}

async function loadSummary(record: ProjectRecord): Promise<FeatureSummary | undefined> {
	try {
		return summarizeFeatures(await readFeatureList(record));
	} catch {
		return undefined;
	}
}

async function requireProject(ctx: ExtensionContext, state: HarnessState, name?: string): Promise<ProjectRecord | undefined> {
	const record = resolveProject(state, name);
	if (record) return record;
	const detected = detectProjectForCwd(state, ctx.cwd);
	if (detected) return detected;
	ctx.ui.notify(
		listProjects(state).length
			? "No active harness. Use /ha-use <name> or /ha-init <name>."
			: "No harness yet. Create one with /ha-init <project-name>.",
		"warning",
	);
	return undefined;
}

interface HarnessToolDetails {
	action: string;
	project?: string;
	path?: string;
	error?: string;
	text?: string;
	summary?: FeatureSummary;
	features?: Feature[];
	projects?: string[];
	validation?: ValidationResult;
}

const HarnessParams = Type.Object({
	action: StringEnum(["info", "list", "read", "features", "update-feature", "validate", "learn", "edit", "enable", "disable"] as const),
	project: Type.Optional(Type.String({ description: "Harness project name (defaults to the active one)" })),
	newName: Type.Optional(Type.String({ description: "New harness name (for action=edit; renames the workspace folder)" })),
	path: Type.Optional(Type.String({ description: "New harness workspace directory (for action=edit)" })),
	projectRoot: Type.Optional(Type.String({ description: "New source project root (for action=edit)" })),
	file: Type.Optional(Type.String({ description: "Harness-relative file to read (for action=read)" })),
	featureId: Type.Optional(Type.String({ description: "Feature id, e.g. feat-002 (for action=update-feature)" })),
	status: Type.Optional(StringEnum(FEATURE_STATUSES)),
	root: Type.Optional(Type.String({ description: "Source root to scan (for action=learn; defaults to the project root)" })),
	evidence: Type.Optional(Type.String({ description: "Verification evidence (required before status=done)" })),
});

export default function piHarness(pi: ExtensionAPI) {
	// One-off disable for a single run: `pi --no-harness`.
	pi.registerFlag("no-harness", {
		description: "Disable pi-harness for this run (no harness injection)",
		type: "boolean",
	});

	// Persistent toggle, shared by the hooks, the tool, and the /ha-* commands.
	const isDisabled = async (): Promise<boolean> => {
		if (pi.getFlag("no-harness") === true) return true;
		return (await loadState()).enabled === false;
	};

	// Per-session switch: set when this repo has no matching harness.
	let sessionDisabled = false;

	// Refresh the footer status whenever a session starts.
	// Default: adopt the harness whose name matches the active git repo; if none
	// exists, pi-harness stays off for the session.
	pi.on("session_start", async (_event, ctx) => {
		const state = await loadState();
		sessionDisabled = false;
		if (state.enabled === false || pi.getFlag("no-harness") === true) {
			sessionDisabled = true;
			ctx.ui.setStatus("pi-harness", "pi-harness: off");
			return;
		}

		// 1. cwd inside a harness workspace wins outright.
		const inside = detectProjectForCwd(state, ctx.cwd);
		if (inside) {
			if (state.active !== inside.name) {
				state.active = inside.name;
				await saveState(state);
			}
			ctx.ui.setStatus("pi-harness", `harness: ${inside.name}`);
			return;
		}

		// 2. Otherwise match the active repo name to a harness project.
		const repoName = await detectRepoName(ctx.cwd);
		const matched = repoName ? findProjectByName(state, repoName) : undefined;
		if (matched) {
			if (state.active !== matched.name) {
				state.active = matched.name;
				await saveState(state);
			}
			ctx.ui.setStatus("pi-harness", `harness: ${matched.name}`);
			return;
		}

		// 3. No harness for this repo → off for this session.
		sessionDisabled = true;
		ctx.ui.setStatus(
			"pi-harness",
			repoName ? `pi-harness: off (no harness '${repoName}')` : "pi-harness: off",
		);
	});

	// The core mechanism: tell the agent where the harness lives every turn.
	pi.on("before_agent_start", async (event, ctx) => {
		if (sessionDisabled || (await isDisabled())) return;
		const state = await loadState();
		const record = resolveProject(state) ?? detectProjectForCwd(state, ctx.cwd);
		if (!record) return;
		const summary = await loadSummary(record);
		event.systemPromptOptions.sections.harness_state = buildHarnessSection(record, summary);
	});

	// ---------------------------------------------------------------------
	// Tool: harness
	// ---------------------------------------------------------------------
	pi.registerTool({
		name: "harness",
		label: "Harness",
		description:
			"Inspect or update the active harness workspace: info, list, read a harness file, features, update a feature status with evidence, learn (scan source code into the harness), edit (rename/move a harness), validate the harness, or toggle pi-harness on/off. Use this to find the harness index, feature_list.json, progress.md, and session-handoff.md.",
		promptSnippet: "Inspect or update the active harness workspace",
		parameters: HarnessParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = await loadState();
			const action = params.action;

			if (action === "enable" || action === "disable") {
				const enabled = action === "enable";
				await setEnabled(enabled);
				ctx.ui.setStatus("pi-harness", enabled ? "pi-harness: on" : "pi-harness: off");
				return {
					content: [{ type: "text", text: `pi-harness ${enabled ? "enabled" : "disabled"}.` }],
					details: { action } as HarnessToolDetails,
				};
			}

			if (action === "list") {
				const projects = listProjects(state);
				const text = projects.length
					? projects.map((p) => `${p.name === state.active ? "* " : "  "}${p.name} — ${p.path}`).join("\n")
					: "No harness projects yet. Use /ha-init <name>.";
				return {
					content: [{ type: "text", text }],
					details: { action, projects: projects.map((p) => p.name) } as HarnessToolDetails,
				};
			}

			const record = resolveProject(state, params.project) ?? detectProjectForCwd(state, ctx.cwd);
			if (!record) {
				return {
					content: [{ type: "text", text: "No active harness. Use /ha-init <project-name> first." }],
					details: { action, error: "no-active-harness" } as HarnessToolDetails,
					isError: true,
				};
			}

			if (action === "info") {
				const summary = await loadSummary(record);
				const text = [
					`Harness: ${record.name}`,
					`Path: ${record.path}`,
					`Project root: ${record.projectRoot}`,
					`Created: ${record.createdAt}`,
					`pi-harness: ${state.enabled === false ? "disabled" : "enabled"}`,
					summary ? formatSummary(summary) : "Feature list unavailable.",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { action, project: record.name, path: record.path, summary } as HarnessToolDetails,
				};
			}

			if (action === "read") {
				if (!params.file) {
					return {
						content: [{ type: "text", text: "action=read requires `file`." }],
						details: { action, error: "missing-file" } as HarnessToolDetails,
						isError: true,
					};
				}
				const full = resolveHarnessFile(record, params.file);
				if (!full) {
					return {
						content: [{ type: "text", text: `Refusing to read outside the harness: ${params.file}` }],
						details: { action, error: "path-outside-harness" } as HarnessToolDetails,
						isError: true,
					};
				}
				if (!(await pathExists(full))) {
					return {
						content: [{ type: "text", text: `File not found in harness: ${params.file}` }],
						details: { action, error: "not-found" } as HarnessToolDetails,
						isError: true,
					};
				}
				const content = truncate(await readText(full));
				return {
					content: [{ type: "text", text: content }],
					details: { action, project: record.name, path: full } as HarnessToolDetails,
				};
			}

			if (action === "learn") {
				try {
					const result = await learnProject(record, { root: params.root });
					const text = [
						`Learned ${result.root}`,
						`Scanned: ${result.files} files, ${result.lines} lines`,
						`Languages: ${result.languages.slice(0, 5).map((lang) => lang.name).join(", ") || "none"}`,
						`Candidate features added: ${result.featuresAdded}`,
						`Debt markers: ${result.todos}`,
						`Wrote: ${result.written.join(", ")}`,
					].join("\n");
					return {
						content: [{ type: "text", text }],
						details: { action, project: record.name, path: result.root } as HarnessToolDetails,
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Learn failed: ${(error as Error).message}` }],
						details: { action, project: record.name, error: (error as Error).message } as HarnessToolDetails,
						isError: true,
					};
				}
			}

			if (action === "edit") {
				if (!params.newName && !params.path && !params.projectRoot) {
					return {
						content: [{ type: "text", text: "Nothing to change: pass newName, path, and/or projectRoot." }],
						details: { action, error: "nothing-to-change" } as HarnessToolDetails,
						isError: true,
					};
				}
				try {
					const result = await editProject(record.name, {
						newName: params.newName,
						newPath: params.path,
						projectRoot: params.projectRoot,
					});
					const changed = [result.renamed ? "renamed" : "", result.moved ? "moved" : ""].filter(Boolean).join(", ") || "metadata";
					const text = [
						`Updated harness (${changed})`,
						`Name: ${result.previousName}${result.renamed ? ` -> ${result.record.name}` : ` (${result.record.name})`}`,
						`Path: ${result.previousPath}${result.moved ? ` -> ${result.record.path}` : ""}`,
						`Project root: ${result.record.projectRoot}`,
					].join("\n");
					return {
						content: [{ type: "text", text }],
						details: { action, project: result.record.name, path: result.record.path } as HarnessToolDetails,
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Edit failed: ${(error as Error).message}` }],
						details: { action, project: record.name, error: (error as Error).message } as HarnessToolDetails,
						isError: true,
					};
				}
			}

			if (action === "features") {
				const list = await readFeatureList(record);
				const summary = summarizeFeatures(list);
				return {
					content: [{ type: "text", text: summary.features.map(formatFeatureLine).join("\n") || "No features." }],
					details: { action, project: record.name, summary, features: summary.features } as HarnessToolDetails,
				};
			}

			if (action === "update-feature") {
				if (!params.featureId) {
					return {
						content: [{ type: "text", text: "action=update-feature requires `featureId`." }],
						details: { action, error: "missing-feature-id" } as HarnessToolDetails,
						isError: true,
					};
				}
				try {
					const feature = await updateFeature(record, params.featureId, {
						status: params.status,
						evidence: params.evidence,
					});
					return {
						content: [
							{
								type: "text",
								text: `Updated ${feature.id}: ${feature.status}${feature.evidence ? ` — ${feature.evidence}` : ""}`,
							},
						],
						details: { action, project: record.name } as HarnessToolDetails,
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Update failed: ${(error as Error).message}` }],
						details: { action, project: record.name, error: (error as Error).message } as HarnessToolDetails,
						isError: true,
					};
				}
			}

			if (action === "validate") {
				const validation = await validateProject(record);
				return {
					content: [{ type: "text", text: formatValidation(validation, record.name) }],
					details: { action, project: record.name, validation } as HarnessToolDetails,
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: { action, error: "unknown-action" } as HarnessToolDetails,
				isError: true,
			};
		},
	});

	// ---------------------------------------------------------------------
	// /ha-init
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-init", {
		description: "Scaffold a harness workspace in <PI_HARNESS_ROOT>/<project> (init.sh optional via --no-init)",
		getArgumentCompletions: (prefix) => {
			return [
				{ value: "--force", label: "--force (overwrite existing files)" },
				{ value: "--no-init", label: "--no-init (skip the init.sh verification script)" },
				{ value: "--agent-file=", label: "--agent-file=CLAUDE.md (rename the instruction file)" },
				{ value: "--project-root=", label: "--project-root=/path (code repo root)" },
			].filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const { positional, flags } = parseCommandArgs(args);
			let name = positional[0];
			if (!name && ctx.hasUI) {
				name = await ctx.ui.input("Harness project name", "my-project");
			}
			if (!name) {
				ctx.ui.notify(
					"Usage: /ha-init <project-name> [--force] [--no-init] [--agent-file=CLAUDE.md] [--project-root=/path]",
					"error",
				);
				return;
			}
			const clean = sanitizeName(name);
			if (!clean) {
				ctx.ui.notify(`Invalid project name "${name}". Use letters, digits, dot, dash, underscore.`, "error");
				return;
			}

			const target = projectDir(clean);
			let force = isTruthy(flags.force);
			const includeInit =
				!isTruthy(flags["no-init"]) &&
				flags["no-init"] !== "true" &&
				!["false", "no", "0", "off"].includes(String(flags.init ?? "").toLowerCase());
			const alreadyExists =
				(await pathExists(join(target, "AGENTS.md"))) || (await pathExists(join(target, "feature_list.json")));
			if (alreadyExists && !force) {
				if (ctx.hasUI) {
					const overwrite = await ctx.ui.confirm(
						"Harness already exists",
						`${target} already exists. Overwrite its harness files?`,
					);
					if (!overwrite) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					force = true;
				} else {
					ctx.ui.notify(`${target} already exists. Re-run with --force to overwrite.`, "error");
					return;
				}
			}

			try {
				const result = await scaffoldProject({
					name: clean,
					projectRoot: flag(flags, "project-root", "projectRoot") ?? ctx.cwd,
					agentFile: flag(flags, "agent-file", "agentFile"),
					force,
					includeInit,
				});
				ctx.ui.setStatus("pi-harness", `harness: ${clean}`);
				ctx.ui.notify(
					[
						`Harness created: ${result.path}`,
						`Files: ${result.written.length} written${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`,
						`init.sh: ${result.includeInit ? "included" : "skipped (--no-init)"}`,
						`Project root: ${result.projectRoot}`,
						`Next: edit feature_list.json, then ask me to read the harness index.`,
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Failed to create harness: ${(error as Error).message}`, "error");
			}
		},
	});

	// ---------------------------------------------------------------------
	// /ha-use
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-use", {
		description: "Switch the active harness workspace",
		getArgumentCompletions: async (prefix) => {
			const state = await loadState();
			return listProjects(state)
				.map((p) => p.name)
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const { positional } = parseCommandArgs(args);
			let name = positional[0];
			const state = await loadState();
			if (!name) {
				const names = listProjects(state).map((p) => p.name);
				if (!names.length) {
					ctx.ui.notify("No harness projects yet. Use /ha-init <name>.", "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(`Usage: /ha-use <name>. Available: ${names.join(", ")}`, "error");
					return;
				}
				name = await ctx.ui.select("Activate harness", names);
			}
			if (!name) return;
			const clean = sanitizeName(name);
			if (!clean || !getProject(state, clean)) {
				ctx.ui.notify(`Unknown harness project: ${name}`, "error");
				return;
			}
			await setActive(clean);
			ctx.ui.setStatus("pi-harness", `harness: ${clean}`);
			ctx.ui.notify(`Active harness: ${clean}`, "info");
		},
	});

	// ---------------------------------------------------------------------
	// /ha-list
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-list", {
		description: "List every harness workspace",
		handler: async (_args, ctx) => {
			const state = await loadState();
			const projects = listProjects(state);
			if (!projects.length) {
				ctx.ui.notify(`No harness projects in ${HARNESS_ROOT}. Use /ha-init <name>.`, "info");
				return;
			}
			const text = projects
				.map((p) => `${p.name === state.active ? "* " : "  "}${p.name} — ${p.path}`)
				.join("\n");
			ctx.ui.notify(`Harnesses in ${HARNESS_ROOT}\n${text}`, "info");
		},
	});

	// ---------------------------------------------------------------------
	// /ha-status
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-status", {
		description: "Show the active harness and its feature state",
		handler: async (args, ctx) => {
			const { positional } = parseCommandArgs(args);
			const state = await loadState();
			const record = await requireProject(ctx, state, positional[0]);
			if (!record) return;
			const summary = await loadSummary(record);
			const text = [
				`Harness: ${record.name}`,
				`Path: ${record.path}`,
				`Project root: ${record.projectRoot}`,
				`pi-harness: ${state.enabled === false ? "disabled" : "enabled"}`,
				summary ? formatSummary(summary) : "Feature list unavailable.",
			].join("\n");
			ctx.ui.notify(text, "info");
		},
	});

	// ---------------------------------------------------------------------
	// /ha-validate
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-validate", {
		description: "Score the harness across the five subsystems",
		getArgumentCompletions: async (prefix) => {
			const state = await loadState();
			return listProjects(state)
				.map((p) => p.name)
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const { positional } = parseCommandArgs(args);
			const state = await loadState();
			const record = await requireProject(ctx, state, positional[0]);
			if (!record) return;
			const validation = await validateProject(record);
			ctx.ui.notify(formatValidation(validation, record.name), validation.overall >= 80 ? "info" : "warning");
		},
	});

	// ---------------------------------------------------------------------
	// /ha-learn
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-learn", {
		description: "Scan the project source code and seed the harness (architecture, product, source map, features)",
		getArgumentCompletions: async (prefix) => {
			const state = await loadState();
			return [
				...listProjects(state).map((p) => ({ value: p.name, label: p.name })),
				{ value: "--root=", label: "--root=/path/to/source" },
				{ value: "--scan-only", label: "--scan-only (do not trigger the agent deep pass)" },
				{ value: "--max-files=", label: "--max-files=4000" },
			].filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const { positional, flags } = parseCommandArgs(args);
			const state = await loadState();
			const record = await requireProject(ctx, state, positional[0]);
			if (!record) return;

			const root = flag(flags, "root") ?? record.projectRoot;
			const maxFiles = Number(flag(flags, "max-files")) || undefined;
			ctx.ui.notify(`Scanning ${root} …`, "info");

			try {
				const result = await learnProject(record, { root, maxFiles });
				ctx.ui.notify(
					[
						`Learned: ${result.root}`,
						`Scanned ${result.files} files, ${result.lines} lines`,
						`Languages: ${result.languages.slice(0, 5).map((lang) => lang.name).join(", ") || "none"}`,
						`Candidate features added: ${result.featuresAdded}`,
						`Debt markers: ${result.todos}`,
						`Wrote: ${result.written.join(", ")}`,
					],
					"info",
				);
				if (!isTruthy(flags["scan-only"])) {
					pi.sendUserMessage(buildLearnPrompt(record, result));
				}
			} catch (error) {
				ctx.ui.notify(`Learn failed: ${(error as Error).message}`, "error");
			}
		},
	});

	// ---------------------------------------------------------------------
	// /ha-edit
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-edit", {
		description: "Edit a harness: rename it and/or change its workspace path or source project root",
		getArgumentCompletions: async (prefix) => {
			const state = await loadState();
			return [
				...listProjects(state).map((p) => ({ value: p.name, label: p.name })),
				{ value: "--name=", label: "--name=NEW-NAME (rename)" },
				{ value: "--path=", label: "--path=/new/harness/dir (move)" },
				{ value: "--project-root=", label: "--project-root=/source/path" },
			].filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const { positional, flags } = parseCommandArgs(args);
			const state = await loadState();
			const record = await requireProject(ctx, state, positional[0]);
			if (!record) return;

			const newName = flag(flags, "name");
			const newPath = flag(flags, "path");
			const projectRoot = flag(flags, "project-root");
			if (!newName && !newPath && !projectRoot) {
				ctx.ui.notify("Nothing to change. Use --name=NEW, --path=/new/dir, or --project-root=/src.", "warning");
				return;
			}

			try {
				const result = await editProject(record.name, { newName, newPath, projectRoot });
				const changed = [result.renamed ? "renamed" : "", result.moved ? "moved" : ""].filter(Boolean).join(", ") || "metadata";
				ctx.ui.notify(
					[
						`Updated harness (${changed})`,
						`Name: ${result.previousName}${result.renamed ? ` -> ${result.record.name}` : ` (${result.record.name})`}`,
						`Path: ${result.previousPath}${result.moved ? ` -> ${result.record.path}` : ""}`,
						`Project root: ${result.record.projectRoot}`,
					],
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Edit failed: ${(error as Error).message}`, "error");
			}
		},
	});

	// ---------------------------------------------------------------------
	// /ha-disable and /ha-enable
	// ---------------------------------------------------------------------
	pi.registerCommand("ha-disable", {
		description: "Turn pi-harness off (stop injecting the active harness into the agent)",
		handler: async (_args, ctx) => {
			await setEnabled(false);
			ctx.ui.setStatus("pi-harness", "pi-harness: off");
			ctx.ui.notify(
				"pi-harness disabled. The agent will no longer auto-read the harness. Re-enable with /ha-enable.",
				"info",
			);
		},
	});

	pi.registerCommand("ha-enable", {
		description: "Turn pi-harness back on",
		handler: async (_args, ctx) => {
			const state = await setEnabled(true);
			const record = resolveProject(state);
			ctx.ui.setStatus("pi-harness", record ? `harness: ${record.name}` : "pi-harness: on");
			ctx.ui.notify(
				record
					? `pi-harness enabled. Active harness: ${record.name}`
					: "pi-harness enabled. No active harness — run /ha-init <name>.",
				"info",
			);
		},
	});
}
