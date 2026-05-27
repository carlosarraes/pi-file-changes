import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "@mariozechner/pi-coding-agent";
import { Container, Key, Markdown, SelectList, Text, matchesKey } from "@mariozechner/pi-tui";
import type { SelectItem } from "@mariozechner/pi-tui";
import { createTwoFilesPatch } from "diff";

const ENTRY_BASELINE = "filechanges:baseline";
const ENTRY_CLEAR = "filechanges:clear";
const ENTRY_UNTRACK = "filechanges:untrack";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type Baseline = {
	path: string;
	absPath: string;
	originalContent: string | null;
	createdAt: number;
};

type TrackedFile = {
	path: string;
	absPath: string;
	displayPath: string;
	originalContent: string | null;
	currentContent: string;
	diff: string;
	pdiffDiff: string;
	added: number;
	removed: number;
	kind: "new" | "edited";
	updatedAt: number;
};

type PendingSnapshot = {
	path: string;
	absPath: string;
	before: string | null;
};

type ReviewItem = {
	path: string;
	oldPath?: string;
	displayPath: string;
	kind: "new" | "edited" | "deleted" | "renamed" | "untracked";
	added: number;
	removed: number;
	source: "git" | "tracked";
};

type ReviewState =
	| { mode: "git"; root: string; base: string; items: ReviewItem[] }
	| { mode: "tracked"; items: ReviewItem[] };

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function normalizeToolPath(cwd: string, raw: string): { absPath: string; relPath: string } {
	const cleaned = stripAtPrefix(raw);
	const absPath = resolve(cwd, cleaned);
	const rel = relative(cwd, absPath);
	const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleaned;
	return { absPath, relPath };
}

async function readTextOrNull(absPath: string): Promise<string | null> {
	try {
		return await readFile(absPath, "utf-8");
	} catch {
		return null;
	}
}

function countDiffLines(unifiedDiff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of unifiedDiff.split("\n")) {
		if (
			line.startsWith("+++ ") ||
			line.startsWith("--- ") ||
			line.startsWith("@@") ||
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("new file ") ||
			line.startsWith("deleted file ") ||
			line.startsWith("rename ") ||
			line.startsWith("similarity ")
		) {
			continue;
		}
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function formatAddedRemovedPlain(added: number, removed: number): string {
	return `(+${added}/-${removed})`;
}

function styleAddedRemovedForList(theme: any, text: string): string {
	const match = text.match(/^\+(\d+)\/\-(\d+)$/);
	if (!match) return theme.fg("muted", text);

	const added = Number(match[1]);
	const removed = Number(match[2]);
	const plus = added === 0 ? theme.fg("text", `+${added}`) : theme.fg("success", `+${added}`);
	const minus = removed === 0 ? theme.fg("text", `-${removed}`) : theme.fg("error", `-${removed}`);
	return plus + theme.fg("text", "/") + minus;
}

function reviewTag(kind: ReviewItem["kind"]): string {
	switch (kind) {
		case "new":
		case "untracked":
			return "+";
		case "deleted":
			return "-";
		case "renamed":
			return "R";
		case "edited":
			return "Δ";
	}
}

function formatStatus(tracked: Map<string, TrackedFile>, theme?: any): string | undefined {
	if (tracked.size === 0) return undefined;

	let edited = 0;
	let created = 0;
	for (const file of tracked.values()) {
		if (file.kind === "new") created++;
		else edited++;
	}

	const text = `fc Δ ${edited}  + ${created}`;
	return theme ? theme.fg("muted", text) : text;
}

function buildWidgetLines(tracked: Map<string, TrackedFile>, theme?: any): string[] | undefined {
	if (tracked.size === 0) return undefined;

	const items = [...tracked.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	const max = 8;
	const lines: string[] = [];

	for (const item of items.slice(0, max)) {
		const tag = item.kind === "new" ? "+" : "Δ";
		if (!theme) {
			lines.push(`${tag} ${item.displayPath} ${formatAddedRemovedPlain(item.added, item.removed)}`);
			continue;
		}

		const prefix = theme.fg("muted", `${tag} ${item.displayPath} `);
		const plus = item.added === 0 ? theme.fg("text", `+${item.added}`) : theme.fg("success", `+${item.added}`);
		const minus = item.removed === 0 ? theme.fg("text", `-${item.removed}`) : theme.fg("error", `-${item.removed}`);
		const counts = theme.fg("text", "(") + plus + theme.fg("text", "/") + minus + theme.fg("text", ")");
		lines.push(prefix + counts);
	}

	if (items.length > max) {
		lines.push(theme ? theme.fg("dim", `…and ${items.length - max} more`) : `…and ${items.length - max} more`);
	}

	return lines;
}

function inlinePatch(displayPath: string, original: string | null, current: string | null): string {
	return createTwoFilesPatch(
		displayPath,
		displayPath,
		original ?? "",
		current ?? "",
		"",
		"",
		{ context: 3 },
	);
}

function gitStylePatch(displayPath: string, original: string | null, current: string | null): string {
	const oldPath = original === null ? "/dev/null" : `a/${displayPath}`;
	const newPath = current === null ? "/dev/null" : `b/${displayPath}`;
	let header = `diff --git a/${displayPath} b/${displayPath}\n`;
	if (original === null) header += "new file mode 100644\n";
	else if (current === null) header += "deleted file mode 100644\n";

	return header + createTwoFilesPatch(oldPath, newPath, original ?? "", current ?? "", "", "", { context: 3 });
}

async function ensureParentDir(absPath: string): Promise<void> {
	await mkdir(dirname(absPath), { recursive: true });
}

function parseCommandArgs(args: string | undefined): string[] {
	if (!args) return [];
	return args
		.split(/\s+/g)
		.map((part) => part.trim())
		.filter(Boolean);
}

export default function (pi: ExtensionAPI) {
	const baselines = new Map<string, Baseline>();
	const tracked = new Map<string, TrackedFile>();
	const pendingByToolCallId = new Map<string, PendingSnapshot>();

	function updateUi(ctx: ExtensionContext | ExtensionCommandContext | any) {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("filechanges", formatStatus(tracked, ctx.ui.theme));
		ctx.ui.setWidget("filechanges", buildWidgetLines(tracked, ctx.ui.theme));
	}

	async function recomputeTrackedFile(ctx: ExtensionContext | ExtensionCommandContext | any, relPath: string) {
		const baseline = baselines.get(relPath);
		if (!baseline) return;

		const current = await readTextOrNull(baseline.absPath);
		if (baseline.originalContent === null && current === null) {
			tracked.delete(relPath);
			return;
		}

		if (baseline.originalContent !== null && current === baseline.originalContent) {
			tracked.delete(relPath);
			return;
		}

		const displayPath = baseline.path;
		const diff = inlinePatch(displayPath, baseline.originalContent, current ?? "");
		const pdiffDiff = gitStylePatch(displayPath, baseline.originalContent, current);
		const { added, removed } = countDiffLines(pdiffDiff);
		tracked.set(relPath, {
			path: baseline.path,
			absPath: baseline.absPath,
			displayPath,
			originalContent: baseline.originalContent,
			currentContent: current ?? "",
			diff,
			pdiffDiff,
			added,
			removed,
			kind: baseline.originalContent === null ? "new" : "edited",
			updatedAt: Date.now(),
		});
	}

	async function clearLog(ctx: ExtensionCommandContext, reason: "accept" | "decline") {
		baselines.clear();
		tracked.clear();
		pendingByToolCallId.clear();
		pi.appendEntry(ENTRY_CLEAR, { timestamp: Date.now(), reason });
		updateUi(ctx);
	}

	async function acceptAll(ctx: ExtensionCommandContext, args: string[]) {
		await ctx.waitForIdle();

		if (tracked.size === 0) {
			if (ctx.hasUI) ctx.ui.notify("fc: no Pi-tracked changes to accept.", "info");
			return;
		}

		const force = args.includes("force");
		if (ctx.hasUI && !force) {
			const ok = await ctx.ui.confirm("Accept Pi changes?", "This keeps files as-is and clears the Pi-tracked change log.");
			if (!ok) return;
		} else if (!ctx.hasUI && !force) {
			throw new Error("Accept requires confirmation. Run: /fc-accept force");
		}

		const count = tracked.size;
		await clearLog(ctx, "accept");
		if (ctx.hasUI) ctx.ui.notify(`fc: accepted Pi-tracked changes for ${count} file(s).`, "info");
	}

	async function declineAll(ctx: ExtensionCommandContext, args: string[]) {
		await ctx.waitForIdle();

		if (tracked.size === 0) {
			if (ctx.hasUI) ctx.ui.notify("fc: no Pi-tracked changes to decline.", "info");
			return;
		}

		const force = args.includes("force");
		if (ctx.hasUI && !force) {
			const ok = await ctx.ui.confirm(
				"Decline Pi changes?",
				"This reverts only files Pi touched through edit/write. Later same-file changes may also be overwritten.",
			);
			if (!ok) return;
		} else if (!ctx.hasUI && !force) {
			throw new Error("Decline requires confirmation. Run: /fc-decline force");
		}

		const items = [...tracked.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		let reverted = 0;
		const errors: string[] = [];

		for (const item of items) {
			try {
				if (item.originalContent === null) {
					await rm(item.absPath, { force: true });
				} else {
					await ensureParentDir(item.absPath);
					await writeFile(item.absPath, item.originalContent, "utf-8");
				}
				reverted++;
			} catch (error: any) {
				errors.push(`${item.displayPath}: ${error?.message ?? String(error)}`);
			}
		}

		await clearLog(ctx, "decline");

		if (ctx.hasUI) {
			if (errors.length === 0) {
				ctx.ui.notify(`fc: declined Pi-tracked changes for ${reverted} file(s).`, "info");
			} else {
				ctx.ui.notify(`fc: declined with ${errors.length} error(s). See console for details.`, "warning");
				console.warn("[pi-file-changes] decline errors:\n" + errors.join("\n"));
			}
		}
	}

	async function gitRoot(ctx: ExtensionContext | ExtensionCommandContext): Promise<string | null> {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { signal: (ctx as any).signal });
		if (result.code !== 0) return null;
		const root = result.stdout.trim();
		return root || null;
	}

	async function gitExec(root: string, args: string[]) {
		return pi.exec("git", ["-C", root, ...args]);
	}

	async function gitBaseRef(root: string): Promise<string> {
		const head = await gitExec(root, ["rev-parse", "--verify", "HEAD"]);
		return head.code === 0 ? "HEAD" : EMPTY_TREE;
	}

	function parseNameStatusZ(stdout: string): Array<{ status: string; path: string; oldPath?: string }> {
		const fields = stdout.split("\0").filter(Boolean);
		const items: Array<{ status: string; path: string; oldPath?: string }> = [];
		let index = 0;
		while (index < fields.length) {
			const status = fields[index++] ?? "";
			if (!status) break;

			if (status.startsWith("R") || status.startsWith("C")) {
				const oldPath = fields[index++];
				const path = fields[index++];
				if (path) items.push({ status, oldPath, path });
				continue;
			}

			const path = fields[index++];
			if (path) items.push({ status, path });
		}
		return items;
	}

	function kindFromGitStatus(status: string): ReviewItem["kind"] {
		if (status.startsWith("R")) return "renamed";
		if (status === "A") return "new";
		if (status === "D") return "deleted";
		return "edited";
	}

	async function getGitDiffForPath(root: string, base: string, item: ReviewItem): Promise<string> {
		if (item.kind === "untracked") {
			const result = await gitExec(root, ["diff", "--no-index", "--", "/dev/null", item.path]);
			return result.stdout;
		}

		const pathspecs = item.oldPath ? [item.oldPath, item.path] : [item.path];
		const result = await gitExec(root, ["diff", "--find-renames", base, "--", ...pathspecs]);
		return result.stdout;
	}

	async function getAllGitDiff(root: string, base: string, items: ReviewItem[]): Promise<string> {
		const trackedDiff = await gitExec(root, ["diff", "--find-renames", base, "--"]);
		const parts: string[] = [];
		if (trackedDiff.stdout.trim()) parts.push(trackedDiff.stdout.trimEnd());

		for (const item of items) {
			if (item.kind !== "untracked") continue;
			const diff = await getGitDiffForPath(root, base, item);
			if (diff.trim()) parts.push(diff.trimEnd());
		}

		return parts.join("\n");
	}

	async function getReviewState(ctx: ExtensionContext | ExtensionCommandContext): Promise<ReviewState> {
		const root = await gitRoot(ctx);
		if (root) {
			const base = await gitBaseRef(root);
			const nameStatus = await gitExec(root, ["diff", "--name-status", "-z", "--find-renames", base, "--"]);
			const entries = parseNameStatusZ(nameStatus.stdout);
			const byPath = new Map<string, ReviewItem>();

			for (const entry of entries) {
				const item: ReviewItem = {
					path: entry.path,
					oldPath: entry.oldPath,
					displayPath: entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path,
					kind: kindFromGitStatus(entry.status),
					added: 0,
					removed: 0,
					source: "git",
				};
				byPath.set(entry.path, item);
			}

			const untracked = await gitExec(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
			for (const path of untracked.stdout.split("\0").filter(Boolean)) {
				if (byPath.has(path)) continue;
				byPath.set(path, {
					path,
					displayPath: path,
					kind: "untracked",
					added: 0,
					removed: 0,
					source: "git",
				});
			}

			const items = [...byPath.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
			for (const item of items) {
				const diff = await getGitDiffForPath(root, base, item);
				const stats = countDiffLines(diff);
				item.added = stats.added;
				item.removed = stats.removed;
			}

			if (items.length > 0) return { mode: "git", root, base, items };
		}

		const items = [...tracked.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map<ReviewItem>((file) => ({
				path: file.path,
				displayPath: file.displayPath,
				kind: file.kind,
				added: file.added,
				removed: file.removed,
				source: "tracked",
			}));
		return { mode: "tracked", items };
	}

	async function getReviewDiff(ctx: ExtensionCommandContext, state: ReviewState, item?: ReviewItem): Promise<string> {
		if (state.mode === "git") {
			return item ? getGitDiffForPath(state.root, state.base, item) : getAllGitDiff(state.root, state.base, state.items);
		}

		if (item) {
			return tracked.get(item.path)?.pdiffDiff ?? "";
		}

		return [...tracked.values()]
			.sort((a, b) => a.displayPath.localeCompare(b.displayPath))
			.map((file) => file.pdiffDiff.trimEnd())
			.filter(Boolean)
			.join("\n");
	}

	async function openInlineDiff(ctx: ExtensionCommandContext, title: string, diff: string) {
		const md = "```diff\n" + (diff.trimEnd() || "(no diff)") + "\n```";
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(new Markdown(md, 1, 0, getMarkdownTheme()));
			container.addChild(new Text(theme.fg("dim", "esc to go back"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done();
					else tui.requestRender();
				},
			};
		}, { overlay: true });
	}

	function runPdiff(diff: string, ctx: ExtensionCommandContext): string | null {
		const dir = mkdtempSync(join(tmpdir(), "pi-file-changes-"));
		const inputPath = join(dir, "changes.diff");
		const outputPath = join(dir, "pdiff-review.md");

		try {
			writeFileSync(inputPath, diff);
			const result = spawnSync("pdiff", ["--input", inputPath, "--output", outputPath], {
				stdio: "inherit",
				cwd: ctx.cwd,
			});

			if (result.error && (result.error as any).code === "ENOENT") {
				ctx.ui.notify("pdiff not found. Install it with: cargo install --git https://github.com/carlosarraes/pdiff", "error");
				return null;
			}

			if (result.status !== 0) {
				ctx.ui.notify("pdiff exited with an error.", "warning");
				return null;
			}

			try {
				return readFileSync(outputPath, "utf-8");
			} catch {
				return null;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	function sendPdiffComments(markdown: string | null, ctx: ExtensionCommandContext) {
		if (!markdown || !markdown.trim() || markdown.includes("No comments.")) {
			ctx.ui.notify("pdiff: no review comments.", "info");
			return;
		}
		pi.sendUserMessage(markdown);
	}

	async function openPdiff(ctx: ExtensionCommandContext, diff: string) {
		if (!diff.trim()) {
			if (ctx.hasUI) ctx.ui.notify("fc: no diff to review.", "info");
			return;
		}

		if (!ctx.hasUI) {
			console.log(diff);
			return;
		}

		const comments = runPdiff(diff, ctx);
		sendPdiffComments(comments, ctx);
	}

	async function showFileActionMenu(ctx: ExtensionCommandContext, state: ReviewState, item: ReviewItem) {
		const choices: SelectItem[] = [
			{ value: "inline", label: "Open inline diff", description: "Show inside Pi" },
			{ value: "pdiff", label: "Open in pdiff", description: "Interactive terminal diff review" },
		];

		const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(item.displayPath)), 1, 0));
			const list = new SelectList(choices, choices.length, {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
			});
			list.onSelect = (choice: SelectItem) => done(choice.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });

		if (!picked) return;
		const diff = await getReviewDiff(ctx, state, item);
		if (picked === "pdiff") {
			await openPdiff(ctx, diff);
			return;
		}
		await openInlineDiff(ctx, item.displayPath, diff);
	}

	async function showFc(ctx: ExtensionCommandContext) {
		await ctx.waitForIdle();
		updateUi(ctx);

		if (!ctx.hasUI) {
			const state = await getReviewState(ctx);
			if (state.items.length === 0) {
				console.log("fc: no file changes found.");
				return;
			}
			for (const item of state.items) {
				console.log(`${reviewTag(item.kind)} ${item.displayPath} +${item.added}/-${item.removed}`);
			}
			return;
		}

		while (true) {
			await ctx.waitForIdle();
			updateUi(ctx);
			const state = await getReviewState(ctx);

			if (state.items.length === 0 && tracked.size === 0) {
				ctx.ui.notify("fc: no file changes found.", "info");
				return;
			}

			const selectItems: SelectItem[] = [
				{ value: "__pdiff_all__", label: "Open all in pdiff", description: state.mode === "git" ? "Review all git changes" : "Review all Pi-tracked changes" },
				{ value: "__accept__", label: "Accept Pi-tracked changes", description: tracked.size === 0 ? "No Pi-tracked changes" : `Clear ${tracked.size} tracked file(s)` },
				{ value: "__decline__", label: "Decline Pi-tracked changes", description: tracked.size === 0 ? "No Pi-tracked changes" : `Revert ${tracked.size} tracked file(s)` },
				{ value: "__sep__", label: "────────", description: "" },
				...state.items.map((item) => ({
					value: item.path,
					label: `${reviewTag(item.kind)} ${item.displayPath}`,
					description: `+${item.added}/-${item.removed}`,
				})),
			];

			const title = state.mode === "git" ? "File changes — git review" : "File changes — Pi-tracked fallback";
			const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
				const list = new SelectList(selectItems, Math.min(14, selectItems.length), {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => styleAddedRemovedForList(theme, text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				});
				list.onSelect = (item: SelectItem) => {
					if (item.value === "__sep__") return;
					done(item.value);
				};
				list.onCancel = () => done(null);
				container.addChild(list);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc close"), 1, 0));
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput(data);
						tui.requestRender();
					},
				};
			}, { overlay: true });

			if (!picked) return;
			if (picked === "__accept__") {
				await acceptAll(ctx, []);
				return;
			}
			if (picked === "__decline__") {
				await declineAll(ctx, []);
				return;
			}
			if (picked === "__pdiff_all__") {
				await openPdiff(ctx, await getReviewDiff(ctx, state));
				return;
			}

			const item = state.items.find((candidate) => candidate.path === picked);
			if (!item) {
				ctx.ui.notify("fc: entry not found; changes may have been updated.", "warning");
				continue;
			}
			await showFileActionMenu(ctx, state, item);
		}
	}

	pi.registerCommand("fc", {
		description: "Show file changes; review git diffs and accept/decline Pi-tracked edits",
		handler: async (_args, ctx) => showFc(ctx),
	});

	pi.registerCommand("fc-diff", {
		description: "Open all current review changes in pdiff",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const state = await getReviewState(ctx);
			await openPdiff(ctx, await getReviewDiff(ctx, state));
		},
	});

	pi.registerCommand("fc-accept", {
		description: "Accept Pi-tracked changes (keeps files, clears log)",
		handler: async (args, ctx) => acceptAll(ctx, parseCommandArgs(args)),
	});

	pi.registerCommand("fc-decline", {
		description: "Decline Pi-tracked changes (reverts files, clears log)",
		handler: async (args, ctx) => declineAll(ctx, parseCommandArgs(args)),
	});

	async function rebuildFromSession(ctx: ExtensionContext | any): Promise<void> {
		baselines.clear();
		tracked.clear();
		pendingByToolCallId.clear();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;

			if (entry.customType === ENTRY_CLEAR) {
				baselines.clear();
				tracked.clear();
				continue;
			}

			if (entry.customType === ENTRY_BASELINE) {
				const data = entry.data as any;
				if (!data?.path) continue;
				const { absPath, relPath } = normalizeToolPath(ctx.cwd, data.path);
				baselines.set(relPath, {
					path: relPath,
					absPath,
					originalContent: typeof data.originalContent === "string" ? data.originalContent : null,
					createdAt: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
				});
				continue;
			}

			if (entry.customType === ENTRY_UNTRACK) {
				const data = entry.data as any;
				if (!data?.path) continue;
				const { relPath } = normalizeToolPath(ctx.cwd, data.path);
				baselines.delete(relPath);
				tracked.delete(relPath);
			}
		}

		for (const relPath of baselines.keys()) {
			await recomputeTrackedFile(ctx, relPath);
		}

		updateUi(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await rebuildFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await rebuildFromSession(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const { absPath, relPath } = normalizeToolPath(ctx.cwd, event.input.path);
			const before = await readTextOrNull(absPath);
			pendingByToolCallId.set(event.toolCallId, { path: relPath, absPath, before });
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			pendingByToolCallId.delete(event.toolCallId);
			return;
		}

		if (!isEditToolResult(event) && !isWriteToolResult(event)) return;

		const pending = pendingByToolCallId.get(event.toolCallId);
		pendingByToolCallId.delete(event.toolCallId);
		if (!pending) return;

		if (!baselines.has(pending.path)) {
			baselines.set(pending.path, {
				path: pending.path,
				absPath: pending.absPath,
				originalContent: pending.before,
				createdAt: Date.now(),
			});
			pi.appendEntry(ENTRY_BASELINE, {
				path: pending.path,
				originalContent: pending.before,
				timestamp: Date.now(),
			});
		}

		await recomputeTrackedFile(ctx, pending.path);

		const baseline = baselines.get(pending.path);
		const current = await readTextOrNull(pending.absPath);
		if (baseline) {
			const backToOriginal =
				(baseline.originalContent !== null && current === baseline.originalContent) ||
				(baseline.originalContent === null && current === null);

			if (backToOriginal) {
				baselines.delete(pending.path);
				tracked.delete(pending.path);
				pi.appendEntry(ENTRY_UNTRACK, { path: pending.path, timestamp: Date.now() });
			}
		}

		updateUi(ctx);
	});
}
