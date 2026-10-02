/**
 * pi-harness — harness engineering for Pi.
 *
 * Shared library: paths, state, scaffolding, feature tracking, and the
 * five-subsystem validation ported from walkinglabs/learn-harness-engineering.
 */

import { execFile } from "node:child_process";
import { access, chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = join(EXTENSION_DIR, "templates");

/** Root folder that holds every harness workspace. Override with PI_HARNESS_ROOT. */
export const HARNESS_ROOT = process.env.PI_HARNESS_ROOT
	? resolve(process.env.PI_HARNESS_ROOT)
	: join(homedir(), "pi-harness");

/** Where the active-project pointer and project registry are persisted. */
export const STATE_FILE = join(homedir(), ".pi", "agent", "pi-harness-state.json");

export const KNOWN_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"index.md",
	"feature_list.json",
	"feature-list.schema.json",
	"progress.md",
	"session-handoff.md",
	"init.sh",
	"clean-state-checklist.md",
	"evaluator-rubric.md",
	"quality-document.md",
	"docs/ARCHITECTURE.md",
	"docs/PRODUCT.md",
	"docs/SOURCE-MAP.md",
	"docs/CODE-STYLE.md",
	"docs/PLACEMENT.md",
] as const;

export const FEATURE_STATUSES = ["not-started", "in-progress", "blocked", "done"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface Feature {
	id: string;
	name: string;
	description: string;
	dependencies?: string[];
	status: FeatureStatus;
	evidence?: string;
}

export interface FeatureList {
	project?: string;
	features: Feature[];
}

export interface ProjectRecord {
	name: string;
	path: string;
	projectRoot: string;
	createdAt: string;
	updatedAt: string;
}

export interface HarnessState {
	active: string | null;
	/** When false, pi-harness stops injecting the active harness into the agent. */
	enabled: boolean;
	projects: Record<string, ProjectRecord>;
}

export interface FeatureSummary {
	total: number;
	done: number;
	inProgress: number;
	blocked: number;
	notStarted: number;
	active?: Feature;
	next?: Feature;
	features: Feature[];
}

export interface ValidationResult {
	overall: number;
	bottleneck: string | null;
	subsystems: Record<string, { score: number; passed: number; total: number; checks: Array<{ pass: boolean; message: string }> }>;
}

// ---------------------------------------------------------------------------
// Paths & state
// ---------------------------------------------------------------------------

export function projectDir(name: string): string {
	return join(HARNESS_ROOT, name);
}

export function sanitizeName(input: string): string | undefined {
	const name = input.trim();
	if (!name || name.length > 64) return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
	if (name === "." || name === "..") return undefined;
	return name;
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function readText(filePath: string): Promise<string> {
	return readFile(filePath, "utf8");
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readText(filePath)) as T;
	} catch {
		return fallback;
	}
}

export async function writeText(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
}

export async function loadState(): Promise<HarnessState> {
	const state = await readJson<HarnessState>(STATE_FILE, { active: null, enabled: true, projects: {} });
	if (!state.projects || typeof state.projects !== "object") state.projects = {};
	if (typeof state.active !== "string") state.active = null;
	if (typeof state.enabled !== "boolean") state.enabled = true;
	return state;
}

export async function saveState(state: HarnessState): Promise<void> {
	await writeText(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function listProjects(state: HarnessState): ProjectRecord[] {
	return Object.values(state.projects).sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(state: HarnessState, name: string): ProjectRecord | undefined {
	return state.projects[name];
}

export function resolveProject(state: HarnessState, name?: string): ProjectRecord | undefined {
	const target = name?.trim() || state.active;
	if (!target) return undefined;
	return state.projects[target];
}

export async function setActive(name: string): Promise<HarnessState> {
	const state = await loadState();
	if (!state.projects[name]) throw new Error(`Unknown harness project: ${name}`);
	state.active = name;
	state.projects[name].updatedAt = new Date().toISOString();
	await saveState(state);
	return state;
}

/** Turn the whole extension on or off (persisted). */
export async function setEnabled(enabled: boolean): Promise<HarnessState> {
	const state = await loadState();
	state.enabled = enabled;
	await saveState(state);
	return state;
}

export interface EditProjectOptions {
	/** New harness name (renames the workspace folder). */
	newName?: string;
	/** New harness workspace directory (absolute, or relative to the current location). */
	newPath?: string;
	/** New source project root that `/ha-learn` scans. */
	projectRoot?: string;
}

export interface EditProjectResult {
	record: ProjectRecord;
	renamed: boolean;
	moved: boolean;
	previousName: string;
	previousPath: string;
}

/** Rename a harness and/or move its folder, and/or repoint its project root. */
export async function editProject(currentName: string, options: EditProjectOptions): Promise<EditProjectResult> {
	const state = await loadState();
	const record = state.projects[currentName];
	if (!record) throw new Error(`Unknown harness project: ${currentName}`);

	const trimmedName = options.newName?.trim();
	const targetName = trimmedName ? sanitizeName(trimmedName) : record.name;
	if (!targetName) throw new Error(`Invalid harness name: ${options.newName}`);
	if (targetName !== record.name && state.projects[targetName]) {
		throw new Error(`A harness named ${targetName} already exists`);
	}

	const previousPath = record.path;
	let targetPath = resolve(record.path);
	if (options.newPath?.trim()) {
		targetPath = resolve(options.newPath.trim());
	} else if (targetName !== record.name) {
		targetPath = join(dirname(record.path), targetName);
	}

	const renamed = targetName !== record.name;
	const moved = targetPath !== previousPath;

	if (moved) {
		if (targetPath === resolve(record.path)) {
			// no-op
		} else if (await pathExists(targetPath)) {
			throw new Error(`Target path already exists: ${targetPath}`);
		}
		if (!(await pathExists(record.path))) throw new Error(`Harness folder is missing: ${record.path}`);
		await mkdir(dirname(targetPath), { recursive: true });
		await rename(record.path, targetPath);
	}

	if (renamed) delete state.projects[currentName];
	record.name = targetName;
	record.path = targetPath;
	if (options.projectRoot?.trim()) record.projectRoot = resolve(options.projectRoot.trim());
	record.updatedAt = new Date().toISOString();
	state.projects[targetName] = record;
	if (state.active === currentName) state.active = targetName;
	await saveState(state);

	return { record, renamed, moved, previousName: currentName, previousPath };
}

export function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** If cwd is inside HARNESS_ROOT/<name>, return that project record. */
export function detectProjectForCwd(state: HarnessState, cwd: string): ProjectRecord | undefined {
	const resolved = resolve(cwd);
	for (const record of listProjects(state)) {
		const rel = relative(record.path, resolved);
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return record;
	}
	return undefined;
}

/**
 * Derive the active repository's name from cwd: the basename of the enclosing
 * git repository, falling back to the basename of cwd.
 */
export async function detectRepoName(cwd: string): Promise<string | undefined> {
	let dir = resolve(cwd);
	while (true) {
		if (await pathExists(join(dir, ".git"))) return basename(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const base = basename(resolve(cwd));
	if (!base || base === sep || base === "/") return undefined;
	return base;
}

/** Find a project by name (exact, case-insensitive, or sanitized form). */
export function findProjectByName(state: HarnessState, name: string): ProjectRecord | undefined {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return undefined;
	const sanitized = sanitizeName(name)?.toLowerCase();
	for (const record of listProjects(state)) {
		const key = record.name.toLowerCase();
		if (key === wanted || (sanitized && key === sanitized)) return record;
	}
	return undefined;
}

/** Resolve a harness-relative file, rejecting paths outside the harness root. */
export function resolveHarnessFile(record: ProjectRecord, file: string): string | undefined {
	const clean = file.trim().replace(/^\.\//, "");
	if (!clean || isAbsolute(clean)) return undefined;
	const full = resolve(record.path, clean);
	const rel = relative(record.path, full);
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return full;
}

/** Candidate instruction-file names inside a harness, in precedence order. */
export const INSTRUCTION_FILE_NAMES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

/** Read the harness instruction file (AGENTS.md / CLAUDE.md), if one exists. */
export async function readInstructionFile(
	record: ProjectRecord,
): Promise<{ path: string; name: string; content: string } | undefined> {
	for (const name of INSTRUCTION_FILE_NAMES) {
		const full = join(record.path, name);
		if (await pathExists(full)) {
			return { path: full, name, content: await readText(full) };
		}
	}
	return undefined;
}

/** True when `child` is the same path as `parent` or lives inside it. */
export function isPathInside(parent: string, child: string): boolean {
	if (!parent) return false;
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Put the harness instruction file at the front of the project context files and
 * drop the active code repo's own AGENTS.md/CLAUDE.md so the harness one wins.
 * User-level instructions outside the project and harness roots are preserved.
 */
export function applyHarnessInstructions(
	contextFiles: Array<{ path: string; content: string }>,
	record: ProjectRecord,
	instructions: { path: string; content: string },
	options: { keepProjectAgents?: boolean } = {},
): Array<{ path: string; content: string }> {
	const harnessInstructionPath = resolve(instructions.path);
	const isAgentFile = (filePath: string) => /^(agents|claude)(\.override)?\.md$/i.test(basename(filePath));
	const kept = contextFiles.filter((file) => {
		const resolved = resolve(file.path);
		if (resolved === harnessInstructionPath) return false;
		if (!isAgentFile(file.path)) return true;
		if (options.keepProjectAgents) return true;
		return !isPathInside(record.path, resolved) && !isPathInside(record.projectRoot, resolved);
	});
	return [{ path: harnessInstructionPath, content: instructions.content }, ...kept];
}

// ---------------------------------------------------------------------------
// Feature tracking
// ---------------------------------------------------------------------------

export async function readFeatureList(record: ProjectRecord): Promise<FeatureList> {
	const raw = await readJson<FeatureList>(join(record.path, "feature_list.json"), { features: [] });
	if (!Array.isArray(raw.features)) raw.features = [];
	return raw;
}

export function summarizeFeatures(list: FeatureList): FeatureSummary {
	const features = list.features ?? [];
	const done = features.filter((f) => f.status === "done");
	const inProgress = features.filter((f) => f.status === "in-progress");
	const blocked = features.filter((f) => f.status === "blocked");
	const notStarted = features.filter((f) => f.status === "not-started");
	const doneIds = new Set(done.map((f) => f.id));
	const next = notStarted.find((f) => (f.dependencies ?? []).every((dep) => doneIds.has(dep)));
	return {
		total: features.length,
		done: done.length,
		inProgress: inProgress.length,
		blocked: blocked.length,
		notStarted: notStarted.length,
		active: inProgress[0],
		next: next ?? notStarted[0],
		features,
	};
}

export interface FeatureUpdate {
	status?: FeatureStatus;
	evidence?: string;
}

export async function updateFeature(record: ProjectRecord, featureId: string, update: FeatureUpdate): Promise<Feature> {
	const file = join(record.path, "feature_list.json");
	return withFileMutationQueue(file, async () => {
		const list = await readFeatureList(record);
		const feature = list.features.find((f) => f.id === featureId);
		if (!feature) throw new Error(`Unknown feature: ${featureId}`);
		if (update.status) feature.status = update.status;
		if (update.evidence !== undefined) feature.evidence = update.evidence;
		if (feature.status === "done" && !feature.evidence?.trim()) {
			throw new Error(`Feature ${featureId} cannot be marked done without evidence`);
		}
		await writeText(file, `${JSON.stringify(list, null, 2)}\n`);
		return feature;
	});
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
	name: string;
	projectRoot?: string;
	agentFile?: string;
	force?: boolean;
	/** Include init.sh (the verification entrypoint). Defaults to true. */
	includeInit?: boolean;
}

export interface ScaffoldResult {
	path: string;
	written: string[];
	skipped: string[];
	projectRoot: string;
	includeInit: boolean;
}

function replacementsFor(options: ScaffoldOptions, targetDir: string, createdAt: string): Record<string, string> {
	const agentFile = options.agentFile || "AGENTS.md";
	const includeInit = options.includeInit !== false;
	return {
		PROJECT_NAME: options.name,
		PROJECT_PURPOSE: `Agent harness for reliable agent-assisted development on ${options.name}.`,
		CREATED_AT: createdAt,
		HARNESS_ROOT: targetDir,
		PROJECT_ROOT: options.projectRoot || targetDir,
		AGENT_FILE_NAME: agentFile,
		PRIMARY_VERIFICATION_COMMAND: includeInit ? "./init.sh" : "(add your project verification command)",
		VERIFICATION_COMMANDS: includeInit
			? "- `./init.sh`"
			: "- Add your build/test command here and reference it from the agent instructions",
		VERIFY_COMMAND_REF: includeInit ? "`./init.sh`" : "the documented verification command",
		INIT_ENTRY_ROW: includeInit
			? "| `init.sh` | Verification | Standard startup and verification entrypoint |"
			: "",
		INIT_ARTIFACT_LINE: includeInit
			? "- `init.sh` — Standard startup and verification path"
			: "- Verification command — documented in the agent instruction file (no standalone script yet)",
	};
}

function applyTemplate(contents: string, replacements: Record<string, string>): string {
	let out = contents;
	for (const [key, value] of Object.entries(replacements)) {
		out = out.split(`{{${key}}}`).join(value);
	}
	return out;
}

export async function scaffoldProject(options: ScaffoldOptions): Promise<ScaffoldResult> {
	const name = sanitizeName(options.name);
	if (!name) throw new Error(`Invalid project name: ${options.name}`);
	const targetDir = projectDir(name);
	const createdAt = new Date().toISOString().slice(0, 19).replace("T", " ");
	const force = Boolean(options.force);
	const includeInit = options.includeInit !== false;

	const replacements = replacementsFor({ ...options, name }, targetDir, createdAt);
	if (includeInit) {
		replacements.INIT_BODY = await readText(join(TEMPLATE_DIR, "init-body.sh"));
	}

	const files: Array<{ template: string; target: string }> = [
		{ template: "AGENTS.md", target: options.agentFile || "AGENTS.md" },
		{ template: "index.md", target: "index.md" },
		{ template: "feature_list.json", target: "feature_list.json" },
		{ template: "feature-list.schema.json", target: "feature-list.schema.json" },
		{ template: "progress.md", target: "progress.md" },
		{ template: "session-handoff.md", target: "session-handoff.md" },
		...(includeInit ? [{ template: "init.sh", target: "init.sh" }] : []),
		{ template: "clean-state-checklist.md", target: "clean-state-checklist.md" },
		{ template: "evaluator-rubric.md", target: "evaluator-rubric.md" },
		{ template: "quality-document.md", target: "quality-document.md" },
		{ template: "docs/ARCHITECTURE.md", target: "docs/ARCHITECTURE.md" },
		{ template: "docs/PRODUCT.md", target: "docs/PRODUCT.md" },
		{ template: "docs/CODE-STYLE.md", target: "docs/CODE-STYLE.md" },
		{ template: "docs/PLACEMENT.md", target: "docs/PLACEMENT.md" },
	];

	const written: string[] = [];
	const skipped: string[] = [];

	await mkdir(targetDir, { recursive: true });

	for (const { template, target } of files) {
		const targetPath = join(targetDir, target);
		if (!force && (await pathExists(targetPath))) {
			skipped.push(target);
			continue;
		}
		const contents = applyTemplate(await readText(join(TEMPLATE_DIR, template)), replacements);
		await writeText(targetPath, contents);
		if (target.endsWith(".sh")) await chmod(targetPath, 0o755);
		written.push(target);
	}

	// Register / refresh the project in the state file.
	const state = await loadState();
	const existing = state.projects[name];
	state.projects[name] = {
		name,
		path: targetDir,
		projectRoot: replacements.PROJECT_ROOT,
		createdAt: existing?.createdAt ?? createdAt,
		updatedAt: new Date().toISOString(),
	};
	state.active = name;
	await saveState(state);

	return { path: targetDir, written, skipped, projectRoot: replacements.PROJECT_ROOT, includeInit };
}

// ---------------------------------------------------------------------------
// Validation (port of harness-creator scoreHarness)
// ---------------------------------------------------------------------------

export async function loadHarnessFiles(record: ProjectRecord): Promise<Array<{ path: string; content: string }>> {
	const files: Array<{ path: string; content: string }> = [];
	for (const candidate of KNOWN_FILES) {
		const full = join(record.path, candidate);
		if (await pathExists(full)) {
			try {
				files.push({ path: candidate, content: await readText(full) });
			} catch {
				// ignore unreadable
			}
		}
	}
	return files;
}

function textHas(text: string, needles: string[], message: string) {
	const lower = text.toLowerCase();
	return { pass: needles.some((needle) => lower.includes(needle.toLowerCase())), message };
}

function structuredText(markdown: string): string {
	const kept: string[] = [];
	let inFence = false;
	for (const raw of markdown.split(/\r?\n/)) {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			kept.push(line);
			continue;
		}
		if (!line) continue;
		const isHeading = /^#{1,6}\s/.test(line);
		const isList = /^([-*+]|\d+\.)\s/.test(line);
		const isTable = line.startsWith("|");
		const isBoldLead = /^\*\*[^*]+\*\*/.test(line);
		if (isHeading || isList || isTable || isBoldLead) kept.push(line);
	}
	return kept.join("\n");
}

function structuredHas(markdown: string, needles: string[], message: string) {
	return textHas(structuredText(markdown), needles, message);
}

function hasFile(byPath: Map<string, string>, names: string[], message: string) {
	return { pass: names.some((name) => byPath.has(name)), message };
}

function jsonFeatureList(text: string, message: string) {
	try {
		const parsed = JSON.parse(text);
		const valid =
			Array.isArray(parsed.features) &&
			parsed.features.every(
				(feature: Feature) =>
					typeof feature.id === "string" &&
					typeof feature.name === "string" &&
					typeof feature.description === "string" &&
					typeof feature.status === "string",
			);
		return { pass: valid, message };
	} catch {
		return { pass: false, message };
	}
}

export function scoreHarness(files: Array<{ path: string; content: string }>): ValidationResult {
	const byPath = new Map(files.map((file) => [file.path, file.content]));
	const allText = files.map((file) => `${file.path}\n${file.content}`).join("\n\n");
	const agents = byPath.get("AGENTS.md") || byPath.get("CLAUDE.md") || "";
	const featureList = byPath.get("feature_list.json") || byPath.get("feature-list.json") || "";
	const progress = byPath.get("progress.md") || "";
	const init = byPath.get("init.sh") || "";
	const handoff = byPath.get("session-handoff.md") || "";

	const checks: Record<string, Array<{ pass: boolean; message: string }>> = {
		instructions: [
			hasFile(byPath, ["AGENTS.md", "CLAUDE.md"], "Agent instruction file exists"),
			structuredHas(agents, ["Startup Workflow", "Before writing code"], "Startup workflow documented"),
			structuredHas(agents, ["Definition of Done", "done only when"], "Definition of done documented"),
			structuredHas(agents, ["Verification Commands", "./init.sh", "test", "verify"], "Verification commands discoverable"),
			structuredHas(agents, ["feature_list.json", "progress.md"], "State artifacts routed from instructions"),
		],
		state: [
			hasFile(byPath, ["feature_list.json", "feature-list.json"], "Feature tracker exists"),
			jsonFeatureList(featureList, "Feature tracker is valid and has feature fields"),
			hasFile(byPath, ["progress.md"], "Progress log exists"),
			structuredHas(progress, ["Current State", "What", "Next"], "Progress log supports restart"),
			structuredHas(handoff || progress, ["Blockers", "Files", "Next Session"], "Handoff captures blockers/files/next step"),
		],
		verification: [
			hasFile(byPath, ["init.sh"], "Verification entrypoint exists"),
			textHas(init, ["set -e"], "Verification fails fast"),
			textHas(init + agents, ["test", "pytest", "vitest", "cargo test", "go test", "dotnet test"], "Test command documented"),
			textHas(init + agents, ["build", "type", "lint", "compile"], "Static/build check documented"),
			textHas(allText, ["Evidence", "Verification Evidence", "command and output"], "Verification evidence is recorded"),
		],
		scope: [
			structuredHas(agents, ["One feature at a time", "one-feature-at-a-time"], "One-feature-at-a-time rule exists"),
			textHas(featureList, ["dependencies"], "Feature dependencies are tracked"),
			textHas(agents + featureList, ["status"], "Feature status is explicit"),
			structuredHas(agents, ["Stay in scope", "scope"], "Scope boundary documented"),
			structuredHas(agents, ["Definition of Done"], "Completion gate limits scope closure"),
		],
		lifecycle: [
			hasFile(byPath, ["init.sh"], "Startup script exists"),
			structuredHas(agents, ["End of Session", "Before ending"], "End-of-session procedure exists"),
			hasFile(byPath, ["session-handoff.md"], "Session handoff template exists"),
			structuredHas(progress + "\n" + handoff, ["Last Updated", "Current Objective", "Recommended Next Step"], "Session restart markers exist"),
			textHas(agents + init, ["restartable", "clean", "Next steps"], "Clean restart path documented"),
		],
	};

	const subsystemNames = ["instructions", "state", "verification", "scope", "lifecycle"];
	const subsystems = Object.fromEntries(
		subsystemNames.map((name) => {
			const list = checks[name];
			const passed = list.filter((check) => check.pass).length;
			const score = Math.max(1, Math.round((passed / list.length) * 5));
			return [name, { score, passed, total: list.length, checks: list }];
		}),
	);

	const total = Object.values(subsystems).reduce((sum, item) => sum + item.score, 0);
	const overall = Math.round((total / (subsystemNames.length * 5)) * 100);
	const ranked = Object.entries(subsystems).sort((a, b) => a[1].score - b[1].score);
	const bottleneck = ranked[0][1].score === 5 ? null : ranked[0][0];
	return { overall, bottleneck, subsystems };
}

export async function validateProject(record: ProjectRecord): Promise<ValidationResult> {
	return scoreHarness(await loadHarnessFiles(record));
}

// ---------------------------------------------------------------------------
// /ha-learn: scan a codebase and seed the harness artifacts
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"build",
	"out",
	"output",
	"coverage",
	".next",
	".nuxt",
	".svelte-kit",
	".output",
	".expo",
	".cache",
	".parcel-cache",
	".turbo",
	"vendor",
	"target",
	"bin",
	"obj",
	".venv",
	"venv",
	"env",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".eggs",
	".gradle",
	".terraform",
	".idea",
	".vscode",
	"tmp",
	"temp",
]);

const ALLOW_DOT_DIRS = new Set([".github"]);

const IGNORE_FILE_PATTERNS = [
	/^package-lock\.json$/,
	/^yarn\.lock$/,
	/^pnpm-lock\.yaml$/,
	/\.min\.(js|css)$/,
	/\.map$/,
	/\.lock$/,
	/\.log$/,
	/\.snap$/,
];

const LANGUAGE_BY_EXT: Record<string, string> = {
	js: "JavaScript",
	jsx: "JavaScript (JSX)",
	mjs: "JavaScript",
	cjs: "JavaScript",
	ts: "TypeScript",
	tsx: "TypeScript (TSX)",
	py: "Python",
	pyw: "Python",
	rb: "Ruby",
	go: "Go",
	rs: "Rust",
	java: "Java",
	kt: "Kotlin",
	kts: "Kotlin",
	swift: "Swift",
	c: "C",
	h: "C/C++ header",
	cc: "C++",
	cpp: "C++",
	hpp: "C++ header",
	cs: "C#",
	php: "PHP",
	scala: "Scala",
	clj: "Clojure",
	ex: "Elixir",
	exs: "Elixir",
	erl: "Erlang",
	hs: "Haskell",
	lua: "Lua",
	pl: "Perl",
	pm: "Perl",
	r: "R",
	sql: "SQL",
	graphql: "GraphQL",
	gql: "GraphQL",
	vue: "Vue",
	svelte: "Svelte",
	astro: "Astro",
	html: "HTML",
	htm: "HTML",
	css: "CSS",
	scss: "SCSS",
	sass: "Sass",
	less: "Less",
	styl: "Stylus",
	sh: "Shell",
	bash: "Shell",
	zsh: "Shell",
	fish: "Shell",
	ps1: "PowerShell",
	md: "Markdown",
	mdx: "MDX",
	json: "JSON",
	jsonc: "JSON",
	yml: "YAML",
	yaml: "YAML",
	toml: "TOML",
	xml: "XML",
	proto: "Protocol Buffers",
	prisma: "Prisma",
	terraform: "HCL",
	tf: "HCL",
};

const CODE_EXTS = new Set([
	"js",
	"jsx",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"py",
	"pyw",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"kts",
	"swift",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"php",
	"scala",
	"clj",
	"ex",
	"exs",
	"erl",
	"hs",
	"lua",
	"pl",
	"pm",
	"r",
	"vue",
	"svelte",
	"astro",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"sql",
	"dart",
]);

/** Extensions whose statements normally end in a semicolon (used for style detection). */
const SEMICOLON_EXTS = new Set([
	"js",
	"jsx",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"java",
	"kt",
	"kts",
	"cs",
	"c",
	"cc",
	"cpp",
	"h",
	"hpp",
	"php",
	"swift",
	"dart",
]);

const CODE_SAMPLE_LIMIT = 40;
const CODE_SAMPLE_CHARS = 8000;

const TEXT_EXTS = new Set([
	...Object.keys(LANGUAGE_BY_EXT),
	"txt",
	"ini",
	"cfg",
	"conf",
	"env",
	"properties",
	"gradle",
	"cmake",
	"editorconfig",
	"gitignore",
	"dockerignore",
	"csv",
	"tsv",
	"svg",
]);

const TEXT_FILENAMES = new Set([
	"Makefile",
	"makefile",
	"Dockerfile",
	"dockerfile",
	"Procfile",
	"Gemfile",
	"Rakefile",
	"LICENSE",
	"NOTICE",
	"CODEOWNERS",
]);

const MANIFEST_NAMES = new Set([
	"package.json",
	"pyproject.toml",
	"requirements.txt",
	"Cargo.toml",
	"go.mod",
	"composer.json",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"setup.py",
	"setup.cfg",
	"tox.ini",
]);

const CONFIG_NAMES = new Set([
	"tsconfig.json",
	"jsconfig.json",
	".eslintrc",
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc.cjs",
	"eslint.config.js",
	"eslint.config.mjs",
	"vite.config.js",
	"vite.config.ts",
	"next.config.js",
	"next.config.mjs",
	"next.config.ts",
	"nuxt.config.ts",
	"svelte.config.js",
	"tailwind.config.js",
	"tailwind.config.ts",
	"jest.config.js",
	"jest.config.ts",
	"vitest.config.ts",
	"playwright.config.ts",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"Makefile",
	".env.example",
	".prettierrc",
	".editorconfig",
	"rollup.config.js",
	"webpack.config.js",
	".gitlab-ci.yml",
	"pom.xml",
	"build.gradle",
]);

const TODO_LINE_RE =
	/^(?:\s*(?:\/\/|#|\/\*|\*|<!--|--|;)\s*)?(?:[-*+]\s+)?(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE|REFACTOR)\b(?=$|[:\s(-])\s*[:(-]?\s*(.*)$/i;

const TEXT_READ_LIMIT_BYTES = 256 * 1024;
const TOTAL_READ_LIMIT_BYTES = 48 * 1024 * 1024;

const execFileAsync = promisify(execFile);

export interface WalkedFile {
	rel: string;
	full: string;
	name: string;
	size: number;
}

export interface LanguageStat {
	name: string;
	files: number;
	lines: number;
}

export interface TodoItem {
	file: string;
	line: number;
	tag: string;
	text: string;
}

export interface ManifestInfo {
	path: string;
	name?: string;
	description?: string;
	scripts: string[];
	dependencies: string[];
}

export interface GitInfo {
	branch: string;
	recentCommits: string[];
	dirty: boolean;
}

export interface CodeStyleSignals {
	samples: number;
	indent: string;
	indentUnit: number;
	quotes: string;
	semicolons: string;
	trailingCommas: string;
	lineWidth: number;
	moduleSystems: string[];
	fileNaming: string[];
	functionNaming: string[];
	typeNaming: string[];
	constNaming: string[];
	commentStyles: string[];
	errorHandling: string[];
	concurrency: string[];
	formattingTools: string[];
	examples: Record<string, string[]>;
}

export interface PlacementHint {
	kind: string;
	directory: string;
	role: string;
	examples: string[];
	namePattern: string;
}

export interface SourceScan {
	root: string;
	scannedAt: string;
	totalFiles: number;
	totalLines: number;
	languages: LanguageStat[];
	directories: Array<{ path: string; files: number }>;
	entryPoints: string[];
	tests: string[];
	docs: string[];
	configs: string[];
	manifests: ManifestInfo[];
	todos: TodoItem[];
	tree: string[];
	style: CodeStyleSignals;
	placement: PlacementHint[];
	git?: GitInfo;
	readmeExcerpt?: string;
}

export interface LearnOptions {
	root?: string;
	force?: boolean;
	maxFiles?: number;
	maxDepth?: number;
}

export interface LearnResult {
	root: string;
	scannedAt: string;
	files: number;
	lines: number;
	languages: LanguageStat[];
	todos: number;
	featuresAdded: number;
	written: string[];
	git?: GitInfo;
}

function isTextFile(name: string): boolean {
	const ext = extname(name).slice(1).toLowerCase();
	if (ext) return TEXT_EXTS.has(ext);
	return TEXT_FILENAMES.has(name);
}

function shouldIgnoreFile(name: string): boolean {
	return IGNORE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

async function walkFiles(root: string, options: LearnOptions): Promise<WalkedFile[]> {
	const maxFiles = options.maxFiles ?? 4000;
	const maxDepth = options.maxDepth ?? 12;
	const out: WalkedFile[] = [];
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (stack.length && out.length < maxFiles) {
		const current = stack.pop() as { dir: string; depth: number };
		let entries: Awaited<ReturnType<typeof readdir>>;
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (out.length >= maxFiles) break;
			const full = join(current.dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") && !ALLOW_DOT_DIRS.has(entry.name)) continue;
				if (IGNORE_DIRS.has(entry.name)) continue;
				if (current.depth + 1 > maxDepth) continue;
				stack.push({ dir: full, depth: current.depth + 1 });
			} else if (entry.isFile()) {
				if (shouldIgnoreFile(entry.name)) continue;
				let size = 0;
				try {
					size = (await stat(full)).size;
				} catch {
					continue;
				}
				out.push({ rel: toPosix(relative(root, full)), full, name: entry.name, size });
			}
		}
	}
	return out;
}

function inferDirectoryRole(path: string): string {
	const parts = path.split("/");
	const key = parts[parts.length - 1].toLowerCase();
	const map: Record<string, string> = {
		src: "Application source code",
		app: "Application entry / route handlers",
		lib: "Shared library code",
		libs: "Shared library code",
		components: "UI components",
		pages: "Routable views / pages",
		routes: "Routing layer",
		api: "API / service boundary",
		server: "Server-side code",
		client: "Client-side code",
		services: "Service layer",
		models: "Data models",
		entities: "Data entities",
		schema: "Schemas / validation",
		schemas: "Schemas / validation",
		db: "Database access",
		database: "Database access",
		migrations: "Database migrations",
		repositories: "Data access layer",
		utils: "Utilities / helpers",
		helpers: "Utilities / helpers",
		hooks: "Reusable hooks",
		store: "State management",
		state: "State management",
		templates: "Harness templates",
		tests: "Tests",
		test: "Tests",
		__tests__: "Tests",
		spec: "Tests",
		docs: "Documentation",
		doc: "Documentation",
		scripts: "Tooling / automation",
		config: "Configuration",
		configs: "Configuration",
		assets: "Static assets",
		static: "Static assets",
		public: "Static assets",
		cmd: "CLI entrypoints",
		internal: "Private packages",
		pkg: "Reusable packages",
	};
	return map[key] ?? "Source directory";
}

function classifyCase(name: string): string {
	if (!name) return "other";
	if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return "SCREAMING_SNAKE_CASE";
	if (/^[A-Z][A-Za-z0-9]*$/.test(name)) return "PascalCase";
	if (/^[a-z][A-Za-z0-9]*$/.test(name)) return "camelCase";
	if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return "snake_case";
	if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name)) return "kebab-case";
	return "other";
}

function topEntries(counts: Map<string, number>, limit = 4, minShare = 0.15): string[] {
	const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
	if (!total) return [];
	return [...counts.entries()]
		.filter(([, count]) => count / total >= minShare)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([key]) => key);
}

function deriveNamePattern(examples: string[]): string {
	if (!examples.length) return "(no existing files)";
	const exts = new Map<string, number>();
	for (const file of examples) {
		const ext = extname(file).slice(1).toLowerCase();
		if (ext) exts.set(ext, (exts.get(ext) ?? 0) + 1);
	}
	const topExt = topEntries(exts, 1, 0)[0];
	const styles = new Map<string, number>();
	for (const file of examples) {
		const stem = topExt ? basename(file, `.${topExt}`) : basename(file);
		const head = stem.split(/[.-]/)[0] ?? stem;
		const style = classifyCase(head);
		styles.set(style, (styles.get(style) ?? 0) + 1);
	}
	const style = topEntries(styles, 1, 0)[0] ?? "camelCase";
	return `${style}${topExt ? ` + .${topExt}` : ""}`;
}

export function analyzeCodeStyle(
	samples: Array<{ rel: string; content: string }>,
	allFiles: string[],
	configs: string[],
	manifests: ManifestInfo[],
	languages: LanguageStat[],
): CodeStyleSignals {
	const fileNaming = new Map<string, number>();
	const functionNaming = new Map<string, number>();
	const typeNaming = new Map<string, number>();
	const constNaming = new Map<string, number>();
	const moduleSystems = new Set<string>();
	const commentStyles = new Set<string>();
	const errorHandling = new Set<string>();
	const concurrency = new Set<string>();
	const examples: Record<string, string[]> = {};
	const addExample = (category: string, value: string) => {
		const list = (examples[category] ??= []);
		if (list.length < 5 && !list.includes(value)) list.push(value);
	};

	for (const rel of allFiles) {
		const ext = extname(rel).slice(1).toLowerCase();
		if (!CODE_EXTS.has(ext)) continue;
		const stem = basename(rel, `.${ext}`);
		const head = stem.split(/[.-]/)[0] ?? stem;
		const style = classifyCase(head);
		fileNaming.set(style, (fileNaming.get(style) ?? 0) + 1);
		addExample("fileNaming", rel);
	}

	let tabLines = 0;
	let twoSpaceLines = 0;
	let fourSpaceLines = 0;
	let singleQuotes = 0;
	let doubleQuotes = 0;
	let semicolonLines = 0;
	let statementLines = 0;
	let trailingCommas = 0;
	const lineLengths: number[] = [];

	for (const sample of samples) {
		const ext = extname(sample.rel).slice(1).toLowerCase();
		const content = sample.content;

		for (const line of content.split(/\r?\n/)) {
			if (!line.trim()) continue;
			lineLengths.push(line.length);
			if (/^\t/.test(line)) {
				tabLines += 1;
			} else {
				const spaces = line.match(/^( +)/)?.[1].length ?? 0;
				if (spaces === 2) twoSpaceLines += 1;
				if (spaces === 4) fourSpaceLines += 1;
			}
			singleQuotes += (line.match(/'/g) ?? []).length;
			doubleQuotes += (line.match(/"/g) ?? []).length;

			if (SEMICOLON_EXTS.has(ext)) {
				const trimmed = line.trim();
				const isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
				const opensBlock = /[{(\[,]$/.test(trimmed) || trimmed.endsWith("=>");
				if (!isComment && !opensBlock) {
					statementLines += 1;
					if (trimmed.endsWith(";")) semicolonLines += 1;
				}
			}
		}
		trailingCommas += (content.match(/,\s*\n\s*[)\]}]/g) ?? []).length;

		if (/\bimport\s+[\s\S]{0,120}?from\s+['"]/.test(content) || /\bexport\s+(default|const|function|class|\{)/.test(content) || /^\s*import\s+['"]/m.test(content)) {
			moduleSystems.add("ES modules (import/export)");
		}
		if (/\brequire\s*\(|module\.exports/.test(content)) moduleSystems.add("CommonJS (require/module.exports)");
		if (ext === "py" && /^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+)/m.test(content)) moduleSystems.add("Python imports");
		if (ext === "go" && /^import\s+/m.test(content)) moduleSystems.add("Go imports");
		if (["java", "kt", "kts", "scala"].includes(ext) && /^import\s+/m.test(content)) {
			moduleSystems.add(`${LANGUAGE_BY_EXT[ext] ?? ext} imports`);
		}
		if (ext === "rs" && /^use\s+/m.test(content)) moduleSystems.add("Rust use statements");

		for (const match of content.matchAll(/\b(?:function|def|func|fn|fun)\s+([A-Za-z_$][\w$]*)/g)) {
			const style = classifyCase(match[1]);
			functionNaming.set(style, (functionNaming.get(style) ?? 0) + 1);
			addExample("functionNaming", match[1]);
		}
		for (const match of content.matchAll(/\b(?:class|interface|type|enum|struct|trait|record)\s+([A-Za-z_$][\w$]*)/g)) {
			const style = classifyCase(match[1]);
			typeNaming.set(style, (typeNaming.get(style) ?? 0) + 1);
			addExample("typeNaming", match[1]);
		}
		for (const match of content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
			const style = classifyCase(match[1]);
			constNaming.set(style, (constNaming.get(style) ?? 0) + 1);
			addExample("constNaming", match[1]);
		}

		if (/^\s*(\/\/|#)/m.test(content)) commentStyles.add(ext === "py" || ext === "rb" || ext === "sh" ? "hash comments (#)" : "line comments (//)");
		if (/\/\*/.test(content)) commentStyles.add("block comments (/* */)");
		if (/^\s*\/{3}/m.test(content) || /\/\*\*/.test(content)) commentStyles.add("documentation comments (///, /**)");
		if (ext === "py" && /("""|''')/.test(content)) commentStyles.add("docstrings");

		if (/\btry\s*[{(]|\bcatch\s*\(|\bexcept\b|\bfinally\b/.test(content)) errorHandling.add("try/catch/finally");
		if (/\bthrow\s+/.test(content) || /\braise\s+/.test(content)) errorHandling.add("throw/raise");
		if (/\bResult</.test(content) || /->\s*Result/.test(content)) errorHandling.add("Result types");
		if (/\bpanic\s*\(|\berrors\.New\b/.test(content)) errorHandling.add("panic/errors.New (Go)");
		if (/\bexpect\s*\(|\.unwrap\s*\(/.test(content)) errorHandling.add("unwrap/expect (Rust)");

		if (/\basync\s+|\bawait\s+/.test(content)) concurrency.add("async/await");
		if (/\bPromise</.test(content) || /\.then\s*\(/.test(content)) concurrency.add("Promises");
		if (/\bgo\s+func\b|\bgoroutine\b/.test(content)) concurrency.add("goroutines");
		if (/\basyncio\b|\basync def\b/.test(content)) concurrency.add("asyncio");
		if (/\btokio\b|\bspawn\s*\(/.test(content)) concurrency.add("async runtime / spawn");
	}

	lineLengths.sort((a, b) => a - b);
	const p95 = lineLengths.length ? lineLengths[Math.floor(lineLengths.length * 0.95)] : 0;
	const lineWidth = p95 ? Math.round(p95 / 10) * 10 : 0;

	const spaces = twoSpaceLines + fourSpaceLines;
	let indent = "unknown";
	let indentUnit = 0;
	if (tabLines > spaces) {
		indent = "Tabs";
		indentUnit = 1;
	} else if (spaces > 0) {
		indent = fourSpaceLines > twoSpaceLines ? "4 spaces" : "2 spaces";
		indentUnit = fourSpaceLines > twoSpaceLines ? 4 : 2;
	}

	let quotes = "unknown";
	if (singleQuotes + doubleQuotes > 0) {
		if (doubleQuotes > singleQuotes * 1.3) quotes = "double quotes";
		else if (singleQuotes > doubleQuotes * 1.3) quotes = "single quotes";
		else quotes = "mixed";
	}

	let semicolons = "n/a";
	if (statementLines > 0) {
		const ratio = semicolonLines / statementLines;
		semicolons = ratio > 0.6 ? "required" : ratio < 0.15 ? "omitted" : "mixed";
	}

	const trailingCommaStyle = trailingCommas > 3 ? "used" : "rare/none";

	const formattingTools = detectFormattingTools(configs, manifests, languages);

	return {
		samples: samples.length,
		indent,
		indentUnit,
		quotes,
		semicolons,
		trailingCommas: trailingCommaStyle,
		lineWidth,
		moduleSystems: [...moduleSystems],
		fileNaming: topEntries(fileNaming),
		functionNaming: topEntries(functionNaming),
		typeNaming: topEntries(typeNaming),
		constNaming: topEntries(constNaming),
		commentStyles: [...commentStyles],
		errorHandling: [...errorHandling],
		concurrency: [...concurrency],
		formattingTools,
		examples,
	};
}

function detectFormattingTools(configs: string[], manifests: ManifestInfo[], languages: LanguageStat[]): string[] {
	const tools = new Set<string>();
	const deps = new Set(manifests.flatMap((manifest) => manifest.dependencies.map((dep) => dep.toLowerCase())));
	const lowerConfigs = configs.map((config) => config.toLowerCase());
	const configHas = (needle: string) => lowerConfigs.some((config) => config.includes(needle));

	if (deps.has("prettier") || configHas("prettier")) tools.add("Prettier");
	if (deps.has("eslint") || configHas("eslint")) tools.add("ESLint");
	if (deps.has("@biomejs/biome") || deps.has("biome")) tools.add("Biome");
	if (deps.has("standard")) tools.add("StandardJS");
	if (deps.has("black")) tools.add("Black");
	if (deps.has("ruff")) tools.add("Ruff");
	if (deps.has("flake8")) tools.add("Flake8");
	if (deps.has("isort")) tools.add("isort");
	if (deps.has("mypy") || deps.has("pyright")) tools.add("type checker (mypy/pyright)");
	if (configHas("editorconfig")) tools.add("EditorConfig");
	if (configHas("rustfmt")) tools.add("rustfmt");
	if (configHas("clang-format")) tools.add("clang-format");

	const names = new Set(languages.map((language) => language.name));
	if (names.has("Go")) tools.add("gofmt (Go default)");
	if (names.has("Rust") && !tools.has("rustfmt")) tools.add("rustfmt (Rust default)");
	if ((names.has("Python") || names.has("Python (pyw)")) && !tools.has("Black") && !tools.has("Ruff")) {
		tools.add("PEP 8 (Python default)");
	}
	return [...tools];
}

const PLACEMENT_KINDS: Array<{ kind: string; aliases: string[]; role: string }> = [
	{ kind: "HTTP controller / handler", aliases: ["controllers", "controller", "handlers", "handler", "http"], role: "Request handling / orchestration" },
	{ kind: "Route / endpoint", aliases: ["routes", "route", "router", "routers", "api", "endpoints"], role: "URL routing / API surface" },
	{ kind: "Service / use case", aliases: ["services", "service", "usecases", "use-cases", "application"], role: "Business logic" },
	{ kind: "Domain model / entity", aliases: ["models", "model", "entities", "entity", "domain"], role: "Domain data" },
	{ kind: "Repository / data access", aliases: ["repositories", "repository", "repos", "dao", "db", "database", "persistence"], role: "Persistence" },
	{ kind: "Schema / DTO / validation", aliases: ["schemas", "schema", "dtos", "dto", "types", "interfaces", "validation", "validators"], role: "Contracts / validation" },
	{ kind: "UI component", aliases: ["components", "component", "ui"], role: "Reusable UI" },
	{ kind: "Page / view / screen", aliases: ["pages", "page", "views", "view", "screens", "screen", "app"], role: "Routable views" },
	{ kind: "Hook / composable", aliases: ["hooks", "hook", "composables"], role: "Reusable reactive logic" },
	{ kind: "State store", aliases: ["store", "stores", "state", "redux", "slices"], role: "Shared state" },
	{ kind: "Middleware / interceptor", aliases: ["middleware", "middlewares", "interceptors", "guards"], role: "Cross-cutting request logic" },
	{ kind: "Utility / helper", aliases: ["utils", "util", "helpers", "helper", "lib", "libs", "shared", "common"], role: "Shared helpers" },
	{ kind: "Configuration", aliases: ["config", "configs", "configuration", "settings"], role: "Configuration" },
	{ kind: "Database migration", aliases: ["migrations", "migration"], role: "Schema changes" },
	{ kind: "Test", aliases: ["tests", "test", "__tests__", "spec", "specs"], role: "Tests" },
	{ kind: "CLI command", aliases: ["cli", "cmd", "commands", "bin"], role: "CLI entrypoints" },
];

export function inferPlacement(allFiles: string[]): PlacementHint[] {
	const byDir = new Map<string, string[]>();
	for (const rel of allFiles) {
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
		if (!dir) continue;
		const list = byDir.get(dir) ?? [];
		list.push(rel);
		byDir.set(dir, list);
	}

	const hints: PlacementHint[] = [];
	for (const { kind, aliases, role } of PLACEMENT_KINDS) {
		let best: { dir: string; files: string[] } | undefined;
		for (const [dir, files] of byDir) {
			const base = (dir.split("/").pop() ?? dir).toLowerCase();
			if (!aliases.includes(base)) continue;
			if (!best || files.length > best.files.length) best = { dir, files };
		}
		if (!best) continue;
		const direct = best.files.filter((file) => !file.slice(best.dir.length + 1).includes("/"));
		const pool = direct.length ? direct : best.files;
		const examples = pool.slice(0, 4).map((file) => basename(file));
		hints.push({
			kind,
			directory: best.dir,
			role: role || inferDirectoryRole(best.dir),
			examples,
			namePattern: deriveNamePattern(examples),
		});
	}
	return hints;
}

function samplePriority(rel: string): number {
	const lower = rel.toLowerCase();
	let score = 0;
	if (/(controller|service|model|route|component|handler|repository|entity)/.test(lower)) score += 3;
	if (/^(src|app|lib)\//.test(lower)) score += 1;
	if (/(test|spec|mock|fixture)/.test(lower)) score -= 2;
	if (lower.endsWith(".d.ts") || /(\.min\.|generated|vendor)/.test(lower)) score -= 3;
	return score;
}

function parseManifest(rel: string, content: string): ManifestInfo | undefined {
	const name = basename(rel);
	const info: ManifestInfo = { path: rel, scripts: [], dependencies: [] };
	try {
		if (name === "package.json") {
			const pkg = JSON.parse(content);
			info.name = pkg.name;
			info.description = pkg.description;
			info.scripts = Object.keys(pkg.scripts ?? {});
			info.dependencies = [
				...Object.keys(pkg.dependencies ?? {}),
				...Object.keys(pkg.devDependencies ?? {}),
			].sort();
		} else if (name === "composer.json") {
			const pkg = JSON.parse(content);
			info.name = pkg.name;
			info.description = pkg.description;
			info.scripts = Object.keys(pkg.scripts ?? {});
			info.dependencies = Object.keys(pkg.require ?? {}).sort();
		} else if (name === "requirements.txt") {
			info.dependencies = content
				.split(/\r?\n/)
				.map((line) => line.trim().replace(/[<>=!~;].*$/, ""))
				.filter((line) => line && !line.startsWith("#"))
				.slice(0, 60);
		} else if (name === "pyproject.toml") {
			info.name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
			info.description = content.match(/^\s*description\s*=\s*"([^"]+)"/m)?.[1];
			const deps = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1];
			if (deps) {
				info.dependencies = deps
					.split(",")
					.map((line) => line.trim().replace(/["']/g, "").replace(/[<>=!~;].*$/, ""))
					.filter(Boolean)
					.slice(0, 60);
			}
		} else if (name === "Cargo.toml") {
			info.name = content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
			info.description = content.match(/^\s*description\s*=\s*"([^"]+)"/m)?.[1];
			const depsBlock = content.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/m)?.[1] ?? "";
			info.dependencies = depsBlock
				.split(/\r?\n/)
				.map((line) => line.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1])
				.filter((value): value is string => Boolean(value));
		} else if (name === "go.mod") {
			info.name = content.match(/^module\s+(\S+)/m)?.[1];
			info.dependencies = [...content.matchAll(/^\s*([^\s/]+\/[^\s]+)\s+v/gm)].map((m) => m[1]).slice(0, 60);
		} else if (name === "Gemfile") {
			info.dependencies = [...content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]).slice(0, 60);
		} else if (name === "pom.xml") {
			info.name = content.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
			info.description = content.match(/<description>([^<]+)<\/description>/)?.[1];
		} else if (name === "build.gradle" || name === "build.gradle.kts") {
			info.description = content.match(/description\s*=\s*["']([^"']+)["']/)?.[1];
		}
	} catch {
		return undefined;
	}
	if (!info.name && !info.description && !info.scripts.length && !info.dependencies.length) return undefined;
	return info;
}

function looksLikeTest(rel: string): boolean {
	const lower = rel.toLowerCase();
	const base = basename(lower);
	return (
		lower.includes("/test/") ||
		lower.includes("/tests/") ||
		lower.includes("/__tests__/") ||
		lower.includes("/spec/") ||
		/\.(test|spec)\.[a-z0-9]+$/.test(base) ||
		/^test_/.test(base) ||
		/_test\.(go|py|rb)$/.test(base) ||
		/(test|tests|spec)\.(js|ts|jsx|tsx|py|rb|go|java|kt)$/.test(base) ||
		/^test[a-z0-9_]*\.(java|kt|cs)$/.test(base)
	);
}

const ENTRY_RE = [
	/^src\/index\.[a-z]+$/,
	/^src\/main\.[a-z]+$/,
	/^index\.[a-z]+$/,
	/^main\.[a-z]+$/,
	/^app\.[a-z]+$/,
	/^server\.[a-z]+$/,
	/^cli\.[a-z]+$/,
	/^src\/app\.[a-z]+$/,
	/^src\/server\.[a-z]+$/,
	/^src\/cli\.[a-z]+$/,
	/^bin\/[^/]+$/,
	/^cmd\/[^/]+\/main\.go$/,
	/^main\.go$/,
	/^src\/main\.rs$/,
	/^src\/lib\.rs$/,
	/^manage\.py$/,
	/^app\.py$/,
	/^main\.py$/,
	/^src\/__main__\.py$/,
	/^__main__\.py$/,
];

async function gitInfo(root: string): Promise<GitInfo | undefined> {
	try {
		const [{ stdout: branchOut }, { stdout: logOut }, { stdout: statusOut }] = await Promise.all([
			execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeout: 8000 }),
			execFileAsync("git", ["log", "--oneline", "-10"], { cwd: root, timeout: 8000 }),
			execFileAsync("git", ["status", "--porcelain"], { cwd: root, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }),
		]);
		return {
			branch: String(branchOut).trim(),
			recentCommits: String(logOut).trim().split("\n").filter(Boolean),
			dirty: String(statusOut).trim().length > 0,
		};
	} catch {
		return undefined;
	}
}

export async function scanSourceCode(root: string, options: LearnOptions = {}): Promise<SourceScan> {
	const resolvedRoot = resolve(root);
	const files = await walkFiles(resolvedRoot, options);

	const languages = new Map<string, LanguageStat>();
	const dirCounts = new Map<string, number>();
	const todos: TodoItem[] = [];
	const manifests: ManifestInfo[] = [];
	const entryPoints: string[] = [];
	const tests: string[] = [];
	const docs: string[] = [];
	const configs: string[] = [];
	const codeSamples: Array<{ rel: string; content: string }> = [];
	let totalLines = 0;
	let readBudget = TOTAL_READ_LIMIT_BYTES;
	let readmeExcerpt: string | undefined;

	const bumpLang = (name: string, lines: number) => {
		const entry = languages.get(name) ?? { name, files: 0, lines: 0 };
		entry.files += 1;
		entry.lines += lines;
		languages.set(name, entry);
	};

	for (const file of files) {
		if (file.rel.includes("/")) {
			const parts = file.rel.slice(0, file.rel.lastIndexOf("/")).split("/");
			for (let depth = 1; depth <= parts.length; depth += 1) {
				const dir = parts.slice(0, depth).join("/");
				dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
			}
		}

		const ext = extname(file.name).slice(1).toLowerCase();
		const language = LANGUAGE_BY_EXT[ext];

		if (looksLikeTest(file.rel)) tests.push(file.rel);
		if (/^(README|CHANGELOG|CONTRIBUTING|LICENSE)/i.test(file.name) || file.rel.startsWith("docs/")) docs.push(file.rel);
		if (CONFIG_NAMES.has(file.name) || file.rel.startsWith(".github/workflows/")) configs.push(file.rel);
		if (ENTRY_RE.some((pattern) => pattern.test(file.rel))) entryPoints.push(file.rel);

		if (!isTextFile(file.name) || file.size > TEXT_READ_LIMIT_BYTES || readBudget <= 0) {
			if (language) bumpLang(language, 0);
			continue;
		}

		let content: string;
		try {
			content = await readText(file.full);
		} catch {
			if (language) bumpLang(language, 0);
			continue;
		}
		readBudget -= Math.min(content.length, TEXT_READ_LIMIT_BYTES);
		const lines = content.split("\n").length;
		totalLines += lines;
		if (language) bumpLang(language, lines);

		if (CODE_EXTS.has(ext) && codeSamples.length < 150 && !looksLikeTest(file.rel)) {
			codeSamples.push({ rel: file.rel, content: content.slice(0, CODE_SAMPLE_CHARS) });
		}

		if (MANIFEST_NAMES.has(file.name)) {
			const info = parseManifest(file.rel, content);
			if (info) manifests.push(info);
		}
		if (/^README/i.test(file.name) && readmeExcerpt === undefined) {
			readmeExcerpt = content
				.split(/\r?\n/)
				.filter((line) => line.trim() && !line.startsWith("#"))
				.slice(0, 6)
				.join(" ")
				.slice(0, 600);
		}

		if (todos.length < 120) {
			const lines = content.split("\n");
			for (let index = 0; index < lines.length && todos.length < 120; index += 1) {
				const match = TODO_LINE_RE.exec(lines[index]);
				if (!match) continue;
				todos.push({
					file: file.rel,
					line: index + 1,
					tag: match[1].toUpperCase(),
					text: (match[2] ?? "").trim().slice(0, 160),
				});
			}
		}
	}

	codeSamples.sort((a, b) => samplePriority(b.rel) - samplePriority(a.rel));
	const filePaths = files.map((file) => file.rel);
	const style = analyzeCodeStyle(
		codeSamples.slice(0, CODE_SAMPLE_LIMIT),
		filePaths,
		configs,
		manifests,
		[...languages.values()],
	);
	const placement = inferPlacement(filePaths);
	const tree = files.map((file) => file.rel).sort();
	return {
		root: resolvedRoot,
		scannedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
		totalFiles: files.length,
		totalLines,
		languages: [...languages.values()].sort((a, b) => b.lines - a.lines || b.files - a.files),
		directories: [...dirCounts.entries()]
			.map(([path, count]) => ({ path, files: count }))
			.sort((a, b) => b.files - a.files)
			.slice(0, 24),
		entryPoints: entryPoints.slice(0, 30),
		tests: tests.slice(0, 60),
		docs: docs.slice(0, 60),
		configs: configs.slice(0, 60),
		manifests,
		todos,
		style,
		placement,
		tree,
		git: await gitInfo(resolvedRoot),
		readmeExcerpt,
	};
}

function bulletList(items: string[], limit = 25): string {
	if (!items.length) return "- (none detected)";
	return items
		.slice(0, limit)
		.map((item) => `- \`${item}\``)
		.join("\n");
}

function projectTitle(record: ProjectRecord, scan: SourceScan): string {
	return scan.manifests.find((m) => m.name)?.name ?? record.name;
}

export function renderArchitectureMd(record: ProjectRecord, scan: SourceScan): string {
	const title = projectTitle(record, scan);
	const langs = scan.languages
		.slice(0, 12)
		.map((lang) => `| ${lang.name} | ${lang.files} | ${lang.lines} |`)
		.join("\n");
	const dirs = scan.directories
		.map((dir) => `| \`${dir.path}\` | ${dir.files} | ${inferDirectoryRole(dir.path)} |`)
		.join("\n");
	const deps = [...new Set(scan.manifests.flatMap((m) => m.dependencies))].sort();
	return `# Architecture — ${title}

> Generated by \`/ha-learn\` on ${scan.scannedAt} from a scan of \`${scan.root}\`.
> This is a machine-generated starting point. Verify it against the real code and correct it.

## System Overview

- **Project:** ${title}
- **Source root:** \`${scan.root}\`
- **Scanned:** ${scan.totalFiles} files, ${scan.totalLines} lines
- **Primary language:** ${scan.languages[0]?.name ?? "unknown"}
- **Git branch:** ${scan.git ? `\`${scan.git.branch}\`${scan.git.dirty ? " (dirty working tree)" : ""}` : "(not a git repo)"}

## Languages

| Language | Files | Lines |
|---|---|---|
${langs || "| (none detected) | 0 | 0 |"}

## Directory Roles

| Directory | Files | Inferred role |
|---|---|---|
${dirs || "| `.` | 0 | Root |"}

## Entry Points

${bulletList(scan.entryPoints)}

## Dependencies

${deps.length ? deps.slice(0, 40).map((dep) => `- \`${dep}\``).join("\n") : "- (no manifests detected)"}

## Configuration & Integration

${bulletList(scan.configs)}

## Tests

${scan.tests.length} test file(s) detected.
${bulletList(scan.tests, 15)}

## Documentation

${bulletList(scan.docs, 15)}

## Layers & Data Flow

Fill this in after reading the code. Starting points:

${scan.directories
	.slice(0, 8)
	.map((dir) => `- \`${dir.path}\` (${inferDirectoryRole(dir.path)}): describe what depends on it and what it depends on`)
	.join("\n") || "- Describe the main request/data flow here."}

## Where New Code Goes

Full guide: \`docs/PLACEMENT.md\`. Quick map of detected locations:

${scan.placement.length ? scan.placement.slice(0, 12).map((hint) => `- **${hint.kind}** → \`${hint.directory}/\` (${hint.namePattern})`).join("\n") : "- No conventional module directories were detected. Read \`docs/PLACEMENT.md\` and confirm with the user before inventing a location."}

When adding a file, put it in the directory above and match the naming pattern of
its existing files. Do not create a new directory for a kind that already has one.

## Code Style

Full guide: \`docs/CODE-STYLE.md\`. Detected baseline (${scan.style.samples} sample file(s)):

- Indentation: ${scan.style.indent}${scan.style.indentUnit ? ` (unit ${scan.style.indentUnit})` : ""}
- Quotes: ${scan.style.quotes}
- Semicolons: ${scan.style.semicolons}
- Trailing commas: ${scan.style.trailingCommas}
- Module system: ${scan.style.moduleSystems.join(", ") || "(not detected)"}
- Naming: files ${scan.style.fileNaming.join("/") || "?"}, types ${scan.style.typeNaming.join("/") || "?"}, functions ${scan.style.functionNaming.join("/") || "?"}
- Tooling: ${scan.style.formattingTools.join(", ") || "(not detected)"}

## Technical Debt Signals

${scan.todos.length
	? scan.todos
			.slice(0, 25)
			.map((todo) => `- \`${todo.file}:${todo.line}\` **${todo.tag}**: ${todo.text || "(no detail)"}`)
			.join("\n")
	: "- No TODO/FIXME markers detected."}

## Verification

Run the harness verification path, then the project's own checks:

\`\`\`bash
./init.sh
\`\`\`

## Evidence

- \`/ha-learn\` scanned ${scan.totalFiles} files at ${scan.scannedAt}
- Languages: ${scan.languages.slice(0, 5).map((lang) => lang.name).join(", ") || "none"}
- Commit: ${scan.git?.recentCommits[0] ?? "(none)"}
`;
}

export function renderCodeStyleMd(record: ProjectRecord, scan: SourceScan): string {
	const title = projectTitle(record, scan);
	const style = scan.style;
	const rows: Array<[string, string]> = [
		["Samples analyzed", String(style.samples)],
		["Indentation", style.indent + (style.indentUnit ? ` (unit ${style.indentUnit})` : "")],
		["Quote style", style.quotes],
		["Semicolons", style.semicolons],
		["Trailing commas", style.trailingCommas],
		["Approx. line width (p95)", style.lineWidth ? String(style.lineWidth) : "unknown"],
		["Module system", style.moduleSystems.join(", ") || "(not detected)"],
		["File naming", style.fileNaming.join(", ") || "(not detected)"],
		["Class / type naming", style.typeNaming.join(", ") || "(not detected)"],
		["Function naming", style.functionNaming.join(", ") || "(not detected)"],
		["Variable / const naming", style.constNaming.join(", ") || "(not detected)"],
		["Comments", style.commentStyles.join(", ") || "(not detected)"],
		["Error handling", style.errorHandling.join(", ") || "(not detected)"],
		["Async / concurrency", style.concurrency.join(", ") || "(not detected)"],
		["Formatter / linter", style.formattingTools.join(", ") || "(not detected)"],
	];
	const exampleSection = Object.entries(style.examples)
		.filter(([, values]) => values.length)
		.map(([category, values]) => `- **${category}:** ${values.map((value) => `\`${value}\``).join(", ")}`)
		.join("\n");
	return `# Code Style — ${title}

> Generated by \`/ha-learn\` on ${scan.scannedAt} from ${style.samples} source sample(s).
> These are heuristic signals. Verify them against the real code and correct anything wrong.

## Detected Signals

| Signal | Detected value |
|---|---|
${rows.map(([key, value]) => `| ${key} | ${value} |`).join("\n")}

## Representative Files

${exampleSection || "- (no samples collected)"}

## Confirmed Conventions

Fill this in after reading the sample files above. Replace any wrong detected
value and add rules the scanner cannot infer (import order, error taxonomy,
logging, testing style, code review expectations).

| Rule | Convention | Evidence (file) |
|---|---|---|
|  |  |  |

## Canonical Examples

List the files new code should imitate:

- Best model / service example:
- Best controller / handler example:
- Best test example:

## Update History

- ${scan.scannedAt}: seeded by \`/ha-learn\`.
`;
}

export function renderPlacementMd(record: ProjectRecord, scan: SourceScan): string {
	const title = projectTitle(record, scan);
	const rows = scan.placement.length
		? scan.placement
				.map(
					(hint) =>
						`| ${hint.kind} | \`${hint.directory}/\` | ${hint.examples.map((example) => `\`${example}\``).join(", ") || "—"} | ${hint.namePattern} |`,
				)
				.join("\n")
		: "| (none detected) | — | — | — |";
	return `# Placement Guide — ${title}

> Generated by \`/ha-learn\` on ${scan.scannedAt} from \`${scan.root}\`.
> Inferred from existing directory names and files. Verify before relying on it.

## Where To Put New Code

| Kind | Directory | Existing examples | Naming pattern |
|---|---|---|---|
${rows}

## Decision Recipe

1. Identify the kind of file (controller, service, model, component, …).
2. Find its row above and create the file in that directory.
3. Match the naming pattern of the existing examples in that directory.
4. Follow \`docs/CODE-STYLE.md\` for formatting and naming inside the file.
5. Add or update the matching test next to the existing tests.
6. If the kind has no row, ask the user instead of inventing a new location.

## Layer Rules

- What may import what (dependency direction):
- What must NOT be imported by:
- Shared code lives in:

## Adding A New Module

- [ ] Created in the correct directory from the table above
- [ ] File and symbol names match the surrounding conventions
- [ ] Wired into the existing registration / routing / bootstrap file
- [ ] Test added following the existing test layout
- [ ] No cross-layer imports that violate the layer rules

## Update History

- ${scan.scannedAt}: seeded by \`/ha-learn\`.
`;
}

export function renderProductMd(record: ProjectRecord, scan: SourceScan): string {
	const title = projectTitle(record, scan);
	const manifest = scan.manifests.find((m) => m.description);
	const scripts = [...new Set(scan.manifests.flatMap((m) => m.scripts))].sort();
	return `# Product — ${title}

> Generated by \`/ha-learn\` on ${scan.scannedAt}. Replace guesses with confirmed intent.

## What This Is

${manifest?.description ?? scan.readmeExcerpt ?? "Describe what this product does and who it is for."}

## How It Is Run

${scripts.length ? scripts.map((script) => `- \`${script}\``).join("\n") : "- Document the build/run/test commands here."}

## User-Visible Surface

${bulletList(scan.entryPoints, 15)}

## Product Rules & Constraints

- (Add user-visible behavior that must not regress)

## Open Questions

- Who are the primary users?
- What is explicitly out of scope?
- Which behaviors are contractually fixed?
`;
}

export function renderSourceMapMd(record: ProjectRecord, scan: SourceScan): string {
	const title = projectTitle(record, scan);
	const tree = scan.tree.slice(0, 300);
	return `# Source Map — ${title}

> Generated by \`/ha-learn\` on ${scan.scannedAt} from \`${scan.root}\`.
> ${scan.totalFiles} files, ${scan.totalLines} lines. Tree is capped at 300 entries.

## Files

\`\`\`
${tree.join("\n")}${scan.totalFiles > tree.length ? `\n… ${scan.totalFiles - tree.length} more` : ""}
\`\`\`

## Largest Directories

${scan.directories.slice(0, 15).map((dir) => `- \`${dir.path}\` — ${dir.files} files`).join("\n")}

## Recent Commits

${scan.git ? scan.git.recentCommits.map((commit) => `- ${commit}`).join("\n") || "- (none)" : "- (not a git repo)"}
`;
}

export function renderQualityMd(record: ProjectRecord, scan: SourceScan): string {
	const title = projectTitle(record, scan);
	const testRatio = scan.totalFiles ? Math.round((scan.tests.length / scan.totalFiles) * 100) : 0;
	return `# Quality Snapshot — ${title}

> Generated by \`/ha-learn\` on ${scan.scannedAt}.

| Metric | Value |
|---|---|
| Files scanned | ${scan.totalFiles} |
| Lines scanned | ${scan.totalLines} |
| Languages | ${scan.languages.length} |
| Test files | ${scan.tests.length} (${testRatio}% of files) |
| TODO/FIXME markers | ${scan.todos.length} |
| Manifests | ${scan.manifests.length} |
| Working tree dirty | ${scan.git ? (scan.git.dirty ? "yes" : "no") : "n/a"} |

## Observations

${scan.todos.slice(0, 10).map((todo) => `- \`${todo.file}:${todo.line}\` ${todo.tag}: ${todo.text}`).join("\n") || "- No debt markers detected."}

## Next Quality Actions

- [ ] Add or confirm tests for the entry points listed in \`docs/ARCHITECTURE.md\`
- [ ] Resolve or ticket the TODO/FIXME markers above
- [ ] Re-run \`/ha-learn\` after major structural changes
`;
}

export function deriveFeatures(scan: SourceScan, existing: Feature[]): Feature[] {
	const existingNames = new Set(existing.map((feature) => feature.name.toLowerCase()));
	const maxId = existing.reduce((max, feature) => {
		const numeric = Number.parseInt(feature.id.replace(/\D/g, ""), 10);
		return Number.isNaN(numeric) ? max : Math.max(max, numeric);
	}, 0);

	const candidates: Feature[] = [];
	let next = maxId;
	const push = (name: string, description: string) => {
		if (candidates.length >= 20) return;
		if (existingNames.has(name.toLowerCase())) return;
		if (candidates.some((feature) => feature.name === name)) return;
		next += 1;
		candidates.push({
			id: `feat-${String(next).padStart(3, "0")}`,
			name,
			description,
			dependencies: [],
			status: "not-started",
		});
	};

	for (const todo of scan.todos) {
		push(`Resolve ${todo.tag} in ${todo.file}`, `${todo.tag} at ${todo.file}:${todo.line} — ${todo.text || "no detail"}`);
	}
	for (const dir of scan.directories.slice(0, 5)) {
		if (dir.path === "." || dir.files < 2) continue;
		push(`Harden module: ${dir.path}`, `Document, test, and clean up the ${dir.path} module (${dir.files} files).`);
	}
	if (!scan.tests.length && scan.totalFiles > 5) {
		push("Establish a test baseline", "No test files were detected during /ha-learn. Add a minimal test suite for the entry points.");
	}
	if (scan.style.samples > 0) {
		push(
			"Confirm code style & placement guide",
			"Read docs/CODE-STYLE.md and docs/PLACEMENT.md, correct anything wrong, and add canonical examples so future files match house style.",
		);
	}
	return candidates;
}

function appendSection(existing: string, marker: string, section: string): string {
	if (existing.includes(marker)) {
		const index = existing.indexOf(marker);
		return `${existing.slice(0, index).trimEnd()}\n\n${section}`;
	}
	return `${existing.trimEnd()}\n\n${section}`;
}

export async function learnProject(record: ProjectRecord, options: LearnOptions = {}): Promise<LearnResult> {
	const root = resolve(options.root ?? record.projectRoot ?? record.path);
	if (!(await pathExists(root))) throw new Error(`Source root does not exist: ${root}`);
	if (!(await isDirectory(root))) throw new Error(`Source root is not a directory: ${root}`);

	const scan = await scanSourceCode(root, options);
	const written: string[] = [];

	const documents: Array<{ path: string; content: string }> = [
		{ path: "docs/ARCHITECTURE.md", content: renderArchitectureMd(record, scan) },
		{ path: "docs/PRODUCT.md", content: renderProductMd(record, scan) },
		{ path: "docs/SOURCE-MAP.md", content: renderSourceMapMd(record, scan) },
		{ path: "docs/CODE-STYLE.md", content: renderCodeStyleMd(record, scan) },
		{ path: "docs/PLACEMENT.md", content: renderPlacementMd(record, scan) },
		{ path: "quality-document.md", content: renderQualityMd(record, scan) },
	];

	for (const doc of documents) {
		await writeText(join(record.path, doc.path), doc.content);
		written.push(doc.path);
	}

	// Merge discovered features into the existing tracker (existing entries win).
	const list = await readFeatureList(record);
	const existingNames = new Set(list.features.map((feature) => feature.name));
	const candidates = deriveFeatures(scan, list.features).filter((feature) => !existingNames.has(feature.name));
	list.project = list.project ?? projectTitle(record, scan);
	list.features = [...list.features, ...candidates];
	await writeText(join(record.path, "feature_list.json"), `${JSON.stringify(list, null, 2)}\n`);
	written.push("feature_list.json");

	// Append learn markers to progress.md and index.md, and refresh the handoff.
	const progressPath = join(record.path, "progress.md");
	const progress = (await pathExists(progressPath)) ? await readText(progressPath) : "# Progress\n";
	const learnSection = `## Learn Baseline — ${scan.scannedAt}

- Source root: \`${scan.root}\`
- Scanned: ${scan.totalFiles} files, ${scan.totalLines} lines
- Languages: ${scan.languages.slice(0, 5).map((lang) => lang.name).join(", ") || "none"}
- Candidate features added: ${candidates.length}
- Debt markers: ${scan.todos.length}
- Code style samples: ${scan.style.samples} (${scan.style.indent}, ${scan.style.quotes}, semicolons ${scan.style.semicolons})
- Placement hints: ${scan.placement.length}

## Current State

Harness docs were seeded from a source scan. Verify them against the real code.

## Next Steps

1. Review \`docs/ARCHITECTURE.md\`, \`docs/SOURCE-MAP.md\`, \`docs/CODE-STYLE.md\`, and \`docs/PLACEMENT.md\` for accuracy.
2. Turn the top debt markers into prioritized features in \`feature_list.json\`.
3. Run the verification path and record evidence.`;
	await writeText(progressPath, appendSection(progress, "## Learn Baseline", learnSection));
	written.push("progress.md");

	const indexPath = join(record.path, "index.md");
	if (await pathExists(indexPath)) {
		const index = await readText(indexPath);
		const indexSection = `## Learned Code Map — ${scan.scannedAt}

- \`docs/SOURCE-MAP.md\` — full file tree and directory sizes
- \`docs/ARCHITECTURE.md\` — languages, entry points, dependencies, layers, where new code goes
- \`docs/CODE-STYLE.md\` — detected formatting, naming, and tooling conventions
- \`docs/PLACEMENT.md\` — where to create controllers, services, models, components, tests
- \`docs/PRODUCT.md\` — product intent and user-visible surface
- \`quality-document.md\` — metrics snapshot

Source root: \`${scan.root}\` (${scan.totalFiles} files, ${scan.totalLines} lines)`;
		await writeText(indexPath, appendSection(index, "## Learned Code Map", indexSection));
		written.push("index.md");
	}

	const handoff = `# Session Handoff — ${projectTitle(record, scan)}

## Last Updated

${scan.scannedAt} (\`/ha-learn\`)

## Current Objective

Verify and refine the auto-generated harness documents against the real code.

## What Was Done

- Scanned \`${scan.root}\`: ${scan.totalFiles} files, ${scan.totalLines} lines
- Wrote \`docs/ARCHITECTURE.md\`, \`docs/PRODUCT.md\`, \`docs/SOURCE-MAP.md\`, \`docs/CODE-STYLE.md\`, \`docs/PLACEMENT.md\`, \`quality-document.md\`
- Added ${candidates.length} candidate feature(s) to \`feature_list.json\`
- Detected code style from ${scan.style.samples} sample(s) and ${scan.placement.length} placement location(s)

## Recommended Next Step

Read \`docs/ARCHITECTURE.md\`, \`docs/CODE-STYLE.md\`, and \`docs/PLACEMENT.md\`, correct anything wrong, then pick one feature from \`feature_list.json\`.

## Blockers

- Machine-generated docs may contain incorrect inferences.

## Files

- \`docs/ARCHITECTURE.md\`, \`docs/PRODUCT.md\`, \`docs/SOURCE-MAP.md\`, \`docs/CODE-STYLE.md\`, \`docs/PLACEMENT.md\`
- \`feature_list.json\`, \`progress.md\`, \`quality-document.md\`

## Verification

\`\`\`bash
./init.sh
\`\`\`
`;
	await writeText(join(record.path, "session-handoff.md"), handoff);
	written.push("session-handoff.md");

	// Remember the learned root so future commands default to it.
	const state = await loadState();
	if (state.projects[record.name]) {
		state.projects[record.name].projectRoot = root;
		state.projects[record.name].updatedAt = new Date().toISOString();
		await saveState(state);
	}

	return {
		root,
		scannedAt: scan.scannedAt,
		files: scan.totalFiles,
		lines: scan.totalLines,
		languages: scan.languages,
		todos: scan.todos.length,
		featuresAdded: candidates.length,
		written,
		git: scan.git,
	};
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
