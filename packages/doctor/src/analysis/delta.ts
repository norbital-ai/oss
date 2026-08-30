/**
 * Checkpoint delta: file and code-LOC movement per pillar between a git checkpoint and the
 * working tree.
 *
 * The question this answers is the one a report cannot: which pillar shrank, which grew, and by
 * how much, between a ref and what is on disc right now. The checkpoint tree is materialized
 * through `git read-tree` + `git checkout-index` against a temporary index — not `git archive`,
 * whose `export-ignore` attributes would silently thin the baseline inventory — so both sides of
 * the comparison are scanned by the same walk, the same LOC classifiers, and the same pillar
 * assignment the report uses.
 *
 * This is inventory, not a gate: a reduction is not virtue and a growth is not debt, so the delta
 * carries no verdict and no severity. Evidence that cannot be produced (not a git work tree, an
 * unknown ref) is a thrown error, which the CLI maps to exit 2 like every other invalid-evidence
 * path.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { collectSourceFiles, describeRoots, isTestPath, lineCounts } from './inventory.js';
import type { LineCounts, RootDescription } from './inventory.js';
import { packageFor } from './graph.js';
import type { PackageOwner } from './graph.js';
import { pillarFor } from './structure.js';

/** One side's volume: file count with comment-excluded and physical LOC. */
export type DeltaSide = Readonly<{
	files: number;
	codeLoc: number;
	physicalLoc: number;
}>;

/** The movement of one pillar between the checkpoint and the working tree, in serialization order. */
export type PillarDelta = Readonly<{
	pillar: string;
	base: DeltaSide;
	disc: DeltaSide;
	delta: Readonly<{ files: number; codeLoc: number; physicalLoc: number }>;
	/** Paths present only on disc, sorted. */
	added: ReadonlyArray<string>;
	/** Paths present only at the checkpoint, sorted. */
	removed: ReadonlyArray<string>;
	/** Paths on both sides whose content hash differs, sorted. */
	changed: ReadonlyArray<string>;
}>;

export type CheckpointDelta = Readonly<{
	kind: 'checkpoint-delta';
	root: string;
	checkpoint: Readonly<{ ref: string; commit: string }>;
	includeTests: boolean;
	totals: Readonly<{ base: DeltaSide; disc: DeltaSide; delta: DeltaSide }>;
	/** Most-reduced pillar first, ties broken by pillar id. */
	pillars: ReadonlyArray<PillarDelta>;
}>;

export type DeltaOptions = Readonly<{
	/** Repository to analyse. Defaults to the current working directory. */
	readonly root?: string | undefined;
	/** The git ref — branch, tag, or commit — that anchors the baseline side. */
	readonly against: string;
	/** Include test and end-to-end sources in the counted scope. */
	readonly includeTests?: boolean | undefined;
}>;

/** Everything the delta needs to know about one file on one side. */
type FileFacts = Readonly<{
	path: string;
	displayPath: string;
	pillar: string;
	test: boolean;
	lines: LineCounts;
	digest: string;
}>;

function git(root: string, args: ReadonlyArray<string>, indexFile?: string): string {
	try {
		return execFileSync(
			'git',
			['-C', root, ...args],
			indexFile === undefined
				? { encoding: 'utf8' }
				: { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: indexFile } }
		);
	} catch (error) {
		const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
		throw new Error(`git ${args[0] ?? ''} failed in ${root}: ${message}`);
	}
}

/**
 * Materialize one commit's tracked tree into a fresh directory without touching the repository's
 * own index, and return the temporary root for the caller to remove.
 */
function materializeCheckpoint(root: string, ref: string): { directory: string; commit: string } {
	git(root, ['rev-parse', '--show-toplevel']);
	let commit = '';
	try {
		commit = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
	} catch {
		throw new Error(`unknown git checkpoint "${ref}" in ${root}`);
	}
	if (commit === '') throw new Error(`unknown git checkpoint "${ref}" in ${root}`);
	const temporary = mkdtempSync(join(tmpdir(), 'doctor-delta-'));
	const indexFile = join(temporary, 'index');
	const directory = join(temporary, 'tree');
	try {
		git(root, ['read-tree', commit], indexFile);
		git(root, ['checkout-index', '-a', '-f', `--prefix=${directory}/`], indexFile);
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
	return { directory, commit };
}

/** Run the report's own inventory over one side and key it by repository-relative path. */
function inventorySide(rootPath: string, description: RootDescription): Map<string, FileFacts> {
	const facts = new Map<string, FileFacts>();
	const ownerCache = new Map<string, PackageOwner>();
	for (const path of collectSourceFiles([rootPath])) {
		const source = readFileSync(path, 'utf8');
		const owner = packageFor(path, rootPath, description.id, ownerCache);
		const localPath = relative(rootPath, path).split(sep).join('/');
		facts.set(localPath, {
			path,
			displayPath: `${description.id}/${localPath}`,
			pillar: pillarFor(path, owner),
			test: isTestPath(path),
			lines: lineCounts(path, source),
			digest: createHash('sha256').update(source).digest('hex')
		});
	}
	return facts;
}

function sideFor(facts: Iterable<FileFacts>): DeltaSide {
	let files = 0;
	let codeLoc = 0;
	let physicalLoc = 0;
	for (const fact of facts) {
		files += 1;
		codeLoc += fact.lines.code;
		physicalLoc += fact.lines.physical;
	}
	return { files, codeLoc, physicalLoc };
}

function subtractSide(base: DeltaSide, disc: DeltaSide): DeltaSide {
	return {
		files: disc.files - base.files,
		codeLoc: disc.codeLoc - base.codeLoc,
		physicalLoc: disc.physicalLoc - base.physicalLoc
	};
}

/**
 * Compare the working tree against a git checkpoint and break the movement down per pillar:
 * the same pillar assignment the health report uses, so a delta row and a report row name the
 * same domain. Untracked-but-not-ignored files count as part of the working tree, because that
 * is what "on disc" means.
 */
export function computeCheckpointDelta(options: DeltaOptions): CheckpointDelta {
	const root = resolve(options.root ?? process.cwd());
	if (!statSync(root).isDirectory()) throw new Error(`root is not a directory: ${root}`);
	const includeTests = options.includeTests === true;
	const checkpoint = materializeCheckpoint(root, options.against);
	try {
		const description = describeRoots([root])[0] ?? { path: root, id: basename(root) };
		const baseAll = inventorySide(checkpoint.directory, description);
		const discAll = inventorySide(root, description);
		const inScope = (fact: FileFacts): boolean => includeTests || !fact.test;
		const membership = new Map<string, { base: Array<FileFacts>; disc: Array<FileFacts> }>();
		const rowFor = (pillar: string): { base: Array<FileFacts>; disc: Array<FileFacts> } => {
			const existing = membership.get(pillar);
			if (existing !== undefined) return existing;
			const fresh = { base: [], disc: [] };
			membership.set(pillar, fresh);
			return fresh;
		};
		const added = new Map<string, Array<string>>();
		const removed = new Map<string, Array<string>>();
		const changed = new Map<string, Array<string>>();
		const pushTo = (map: Map<string, Array<string>>, pillar: string, path: string): void => {
			const paths = map.get(pillar) ?? [];
			paths.push(path);
			map.set(pillar, paths);
		};
		for (const [path, fact] of baseAll) {
			if (!inScope(fact)) continue;
			rowFor(fact.pillar).base.push(fact);
			const onDisc = discAll.get(path);
			if (onDisc === undefined) pushTo(removed, fact.pillar, fact.displayPath);
			else if (onDisc.digest !== fact.digest) pushTo(changed, fact.pillar, fact.displayPath);
		}
		for (const [path, fact] of discAll) {
			if (!inScope(fact)) continue;
			rowFor(fact.pillar).disc.push(fact);
			if (!baseAll.has(path)) pushTo(added, fact.pillar, fact.displayPath);
		}
		const pillars = [...membership.entries()]
			.map(([pillar, sides]) => {
				const base = sideFor(sides.base);
				const disc = sideFor(sides.disc);
				return {
					pillar,
					base,
					disc,
					delta: subtractSide(base, disc),
					added: (added.get(pillar) ?? []).sort(),
					removed: (removed.get(pillar) ?? []).sort(),
					changed: (changed.get(pillar) ?? []).sort()
				};
			})
			.sort(
				(left, right) =>
					left.delta.codeLoc - right.delta.codeLoc || left.pillar.localeCompare(right.pillar)
			);
		const baseSide = sideFor([...baseAll.values()].filter(inScope));
		const discSide = sideFor([...discAll.values()].filter(inScope));
		return {
			kind: 'checkpoint-delta',
			root,
			checkpoint: { ref: options.against, commit: checkpoint.commit },
			includeTests,
			totals: { base: baseSide, disc: discSide, delta: subtractSide(baseSide, discSide) },
			pillars
		};
	} finally {
		rmSync(join(checkpoint.directory, '..'), { recursive: true, force: true });
	}
}

/** The console brief: one row per pillar, most-reduced first. */
export function deltaSummary(delta: CheckpointDelta): string {
	const width = (value: number): string => value.toLocaleString('en-US');
	const signed = (value: number): string => (value > 0 ? `+${width(value)}` : width(value));
	const cells = {
		pillar: Math.max(
			'pillar (sub tree)'.length,
			...delta.pillars.map(({ pillar }) => pillar.length),
			'totals'.length
		),
		files: Math.max(
			'files'.length,
			...delta.pillars.map(
				({ base, disc }) => `${width(base.files)} → ${width(disc.files)}`.length
			)
		),
		deltaFiles: Math.max(
			'Δfiles'.length,
			...delta.pillars.map(({ delta }) => signed(delta.files).length)
		),
		codeLoc: Math.max(
			'codeLoc'.length,
			...delta.pillars.map(
				({ base, disc }) => `${width(base.codeLoc)} → ${width(disc.codeLoc)}`.length
			)
		),
		deltaLoc: Math.max(
			'ΔcodeLoc'.length,
			...delta.pillars.map(({ delta }) => signed(delta.codeLoc).length)
		)
	};
	const pad = (value: string, size: number): string => value.padStart(size);
	const line = (cellsForRow: Array<string>): string => cellsForRow.join('  ').replace(/\s+$/, '');
	const row = ({
		pillar,
		base,
		disc,
		delta
	}: {
		pillar: string;
		base: DeltaSide;
		disc: DeltaSide;
		delta: DeltaSide;
	}): string =>
		line([
			pillar.padEnd(cells.pillar),
			pad(`${width(base.files)} → ${width(disc.files)}`, cells.files),
			pad(signed(delta.files), cells.deltaFiles),
			pad(`${width(base.codeLoc)} → ${width(disc.codeLoc)}`, cells.codeLoc),
			pad(signed(delta.codeLoc), cells.deltaLoc)
		]);
	const scope = delta.includeTests ? 'including tests' : 'production only';
	const header = line([
		'pillar (sub tree)'.padEnd(cells.pillar),
		pad('files', cells.files),
		pad('Δfiles', cells.deltaFiles),
		pad('codeLoc', cells.codeLoc),
		pad('ΔcodeLoc', cells.deltaLoc)
	]);
	return [
		`norbital-doctor delta: ${delta.checkpoint.ref} (${delta.checkpoint.commit.slice(0, 12)}) → working tree · ${scope}`,
		header,
		...delta.pillars.map(row),
		row({ pillar: 'totals', base: delta.totals.base, disc: delta.totals.disc, delta: delta.totals.delta })
	].join('\n');
}
