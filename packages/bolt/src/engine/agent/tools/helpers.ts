import { Validator } from '@cfworker/json-schema';
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import {
	FacilityFailure,
	Port,
	type PortFailure,
	ToolView,
	type WorkspacePort
} from '@norbital-ai/host-api';
import { sha256_hex } from '@norbital-ai/store';
import { FOLDER_NOTES, role_at } from '../../../decl/layout.ts';
import type { Json } from '../../../decl/values.ts';
import { SYSTEM } from '../../../system/index.ts';
import { actor_ref } from '../../access/actor.ts';
import { outputsOf } from '../../access/authority.ts';
import { routesApproval } from '../../approvals/lock.ts';
import type { Authority, Bindings, Outcome } from '../../contracts.ts';
import { stableId } from '../../conversations/store.ts';
import type { EngineError } from '../../errors.ts';
import { layered, type EngineManifest } from '../../manifest.ts';
import type { Http } from '../../ports.ts';
import { MODEL_FILES, type ToolAnswer } from '../ai.ts';
import { BOUNDS, bound, localTime, size } from '../context.ts';
import { isList, isObj } from '../draft.ts';
import type { AgentEngine as Engine } from '../index.ts';
import { sourceLines, window } from '../ingest.ts';
import type { Receipt } from '../schema.ts';
import {
	APPROVE,
	LINE_CHARS,
	PAGE_BYTES,
	READ_LINES,
	TAIL_LINES,
	VERBS,
	type Spec,
	type ToolContext,
	type Validators
} from './types.ts';

export const decodeView = Schema.decodeUnknownResult(ToolView);

export const ok = (result: Json): ToolAnswer => ({ result });

export const err = (message: string): { result: Json } => ({ result: { error: message } });

export const guard = (
	work: Effect.Effect<ToolAnswer, EngineError | PortFailure>
): Effect.Effect<ToolAnswer> =>
	work.pipe(Effect.catch((error) => Effect.succeed(err(error.message))));

const PACKAGES = ': installed packages are outside the workspace: workspace_lang reads their types.';

export const outsideSource = (asked: string, path: string): string | undefined =>
	path.split('/').includes('node_modules')
		? `${asked}${PACKAGES}`
		: path === '.norbital' || path.startsWith('.norbital/')
			? `${asked}: the build writes .norbital from your source (a model's binding from its +model.ts) and it is never read: workspace_lang reads its types.`
			: undefined;

export const documentAnswer = (answer: { readonly [key: string]: Json }, key: string): ToolAnswer => {
	const value = answer[key],
		text = typeof value === 'string' ? value : '',
		room = BOUNDS.resultBytes - 2_000;
	if (size(text) <= room) return { result: answer, bounded: true };
	return {
		result: { ...answer, [key]: text.slice(0, room) },
		full: answer,
		bounded: true
	};
};

export type Clip = (v: Json, bytes: number) => Json;

export const clipJson =
	(call: string): Clip =>
	(v, bytes) =>
		size(v) <= bytes
			? v
			: `${JSON.stringify(v).slice(0, bytes)}... [clipped, ${size(v)} bytes; read_output { call: '${call}' } reads it whole]`;

export const clippedView = (view: (clip: Clip) => Json, call: string): ToolAnswer => ({
	result: bound(view(clipJson(call))),
	full: view((v) => v),
	bounded: true
});

export const textAnswer = (text: string): ToolAnswer => {
	const room = BOUNDS.resultBytes - 2_000;
	return size(text) <= room
		? { result: text, bounded: true }
		: { result: text.slice(0, room), full: text, bounded: true };
};

export const sourcePath = (path: string) => {
	const parts: string[] = [];
	for (const part of path.split('/'))
		if (part === '..') parts.pop();
		else if (part !== '' && part !== '.') parts.push(part);
	return parts.join('/');
};

export const scriptRead = (
	source: WorkspacePort,
	input: unknown,
	page: Effect.Effect<ToolAnswer>
) =>
	Effect.gen(function* () {
		if (
			!Predicate.isObject(input) ||
			typeof input['path'] !== 'string' ||
			input['offset'] !== undefined ||
			input['limit'] !== undefined
		)
			return yield* page;
		const path = sourcePath(input['path']),
			content = path === '' ? null : yield* Port.attempt('workspace.read', () => source.read(path));
		return content === null
			? yield* page
			: ok({ path, content, lines: sourceLines(content).length });
	}).pipe(Effect.catch((failure) => Effect.succeed(err(failure.message))));

export const truncatedNote = (shown: number) =>
	`(Results are truncated: showing first ${shown} results. Consider using a more specific path or pattern.)`;

export const linePage = (
	text: string,
	offset = 1,
	limit = READ_LINES,
	format: 'html' | 'text' = 'html'
) => {
	const from = Math.max(1, offset),
		w = window(text, from, from + Math.min(Math.max(1, limit), READ_LINES) - 1, undefined, format);
	return from > w.total
		? { error: `Offset ${from} is out of range (${w.total} lines)` }
		: { window: w };
};

export const filePage = (path: string, text: string, offset?: number, limit?: number) => {
	const all = sourceLines(text),
		total = all.length,
		most = Math.min(limit ?? READ_LINES, READ_LINES),
		tail = offset !== undefined && offset > total,
		from =
			offset !== undefined && offset < 0
				? Math.max(1, total + 1 + offset)
				: tail
					? Math.max(1, total + 1 - Math.min(limit ?? TAIL_LINES, TAIL_LINES))
					: Math.max(1, offset ?? 1),
		lines: string[] = [];
	let bytes = 0,
		next: number | undefined;
	for (let n = from; n <= total; n++) {
		const raw = all[n - 1] ?? '',
			line = `${n}: ${raw.length > LINE_CHARS ? `${raw.slice(0, LINE_CHARS)}... (line truncated to ${LINE_CHARS} chars)` : raw}`;
		if (lines.length === most || (lines.length > 0 && bytes + size(line) > PAGE_BYTES)) {
			next = n;
			break;
		}
		bytes += size(line) + 1;
		lines.push(line);
	}
	const to = from + lines.length - 1;
	return [
		(lines.length === 0 ? `Read file ${path}, 0 lines` : `Read file ${path}, lines ${from}-${to}`) +
			(tail
				? ` (offset ${offset} is past the end; the file has ${total} ${total === 1 ? 'line' : 'lines'})`
				: ''),
		...lines,
		...(next === undefined ? [] : [`[Output truncated. Continue reading with offset: ${next}]`])
	].join('\n');
};

export const directoryPage = (path: string, files: readonly string[], offset?: number, limit?: number) => {
	const prefix = path === '' ? '' : `${path}/`,
		entries = [
			...new Set(
				files
					.filter((file) => file.startsWith(prefix))
					.map((file) => {
						const rest = file.slice(prefix.length),
							slash = rest.indexOf('/');
						return slash === -1 ? rest : rest.slice(0, slash + 1);
					})
			)
		].sort((a, b) =>
			a.endsWith('/') === b.endsWith('/') ? a.localeCompare(b) : a.endsWith('/') ? -1 : 1
		),
		from = Math.max(1, offset ?? 1),
		shown = entries.slice(from - 1, from - 1 + Math.min(limit ?? READ_LINES, READ_LINES)),
		next = from - 1 + shown.length < entries.length ? from + shown.length : undefined,
		name = path === '' ? '.' : path;
	return [
		shown.length === 0
			? `Read directory ${name}, 0 entries`
			: `Read directory ${name}, entries ${from}-${from + shown.length - 1}`,
		...shown,
		...(next === undefined ? [] : [`[Output truncated. Continue reading with offset: ${next}]`])
	].join('\n');
};

export const grepAnswer = (
	hits: readonly { readonly path: string; readonly line: number; readonly text: string }[],
	truncated: boolean
) => {
	const lines = [
		truncated
			? `Showing ${hits.length} matching lines (more exist)`
			: hits.length === 0
				? 'No matches found'
				: `Found ${hits.length} matches`
	];
	let current = '';
	for (const hit of hits) {
		if (current !== hit.path) {
			if (current !== '') lines.push('');
			current = hit.path;
			lines.push(`${hit.path}:`);
		}
		lines.push(`  Line ${hit.line}: ${hit.text}`);
	}
	return [...lines, ...(truncated ? ['', truncatedNote(hits.length)] : [])].join('\n');
};

/** A glob as ripgrep's `--glob` reads it: `**`, `*`, `?` and `{a,b}`; with no `/` it matches at any depth. */
export const globRegExp = (glob: string) => {
	const rooted = glob.includes('/') ? glob.replace(/^\.?\//, '') : `**/${glob}`;
	let regex = '',
		braces = 0;
	for (let at = 0; at < rooted.length; at++) {
		const char = rooted[at] ?? '';
		if (char === '*' && rooted[at + 1] === '*') {
			at++;
			if (rooted[at + 1] === '/') {
				at++;
				regex += '(?:.*/)?';
			} else regex += '.*';
		} else if (char === '*') regex += '[^/]*';
		else if (char === '?') regex += '[^/]';
		else if (char === '{') {
			braces++;
			regex += '(?:';
		} else if (char === '}' && braces > 0) {
			braces--;
			regex += ')';
		} else if (char === ',' && braces > 0) regex += '|';
		else regex += char.replace(/[.+^$()|\\[\]{}]/g, '\\$&');
	}
	return new RegExp(`^${regex}$`);
};

export const sourceTree = (files: readonly string[]): string => {
	type Folder = Map<string, Folder | null>;
	const root: Folder = new Map(),
		noted = new Set<string>(),
		lines = ['/  <- cwd'];
	for (const file of files) {
		const folders = file.split('/'),
			name = folders.pop() ?? '';
		let at = root;
		for (const folder of folders) {
			const next: Folder = at.get(folder) ?? new Map();
			at.set(folder, next);
			at = next;
		}
		at.set(name, null);
	}
	const walk = (folder: Folder, path: string, indent: string) => {
		const names = [...folder.keys()].sort();
		for (const [i, name] of names.entries()) {
			const last = i === names.length - 1,
				inner = folder.get(name),
				shown = inner == null ? name : `${name}/`,
				role = inner == null ? role_at(`${path}${name}`) : undefined,
				note =
					role === undefined || noted.has(role.role) ? FOLDER_NOTES[`${path}${shown}`] : role.note;
			if (role !== undefined) noted.add(role.role);
			lines.push(`${indent}${last ? '└── ' : '├── '}${shown}${note ? `  ${note}` : ''}`);
			if (inner != null) walk(inner, `${path}${name}/`, `${indent}${last ? '    ' : '│   '}`);
		}
	};
	walk(root, '', '');
	return lines.join('\n');
};

/**
 * A write the person confirms on a card: a delete, a batch of more than one row, an import that prunes, or an update
 * that deletes a child. One plain create or update runs directly.
 */
export const sweeping = (callable: string, input: Json | undefined): boolean => {
	const verb = callable.slice(callable.lastIndexOf('.') + 1);
	if (verb === 'delete') return true;
	if (verb === 'import')
		return (
			isObj(input) &&
			input['dry_run'] !== true &&
			((isList(input['rows']) && input['rows'].length > 1) || isObj(input['prune']))
		);
	if (verb !== 'create' && verb !== 'update') return false;
	const rows = isList(input) ? input : [];
	return (
		rows.length > 1 ||
		rows.some(
			(row) =>
				isObj(row) &&
				isObj(row['set']) &&
				Object.values(row['set']).some((v) => isObj(v) && v['delete'] !== undefined)
		)
	);
};

export const readsOnly = (http: Http['Service']): Http['Service'] => ({
	fetch: (request, options) =>
		['GET', 'HEAD'].includes(request.method.toUpperCase())
			? http.fetch(request, options)
			: Effect.fail(
					FacilityFailure.invalid(
						`a ${request.method.toUpperCase()} needs http: 'send', which the person confirms`
					)
				)
});

export const before = (text: string, separator: string) => {
	const at = text.indexOf(separator);
	return at < 0 ? text : text.slice(0, at);
};

export function skillOf(text: string): {
	description: string;
	body: string;
	sections: string[];
} {
	const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const description =
		fm?.[1] === undefined ? '' : (/^description:\s*(.*)$/m.exec(fm[1])?.[1] ?? '').trim();
	const body = fm === null ? text : text.slice(fm[0].length);
	return {
		description,
		body,
		sections: [...body.matchAll(/^##\s+(.+)$/gm)].flatMap((x) =>
			x[1] === undefined ? [] : [x[1].trim()]
		)
	};
}

export function section(body: string, title: string): string | undefined {
	const parts = body.split(/^(?=##\s)/m);
	return parts.find(
		(p) =>
			before(p.replace(/^##\s+/, ''), '\n')
				.trim()
				.toLowerCase() === title.toLowerCase()
	);
}

/**
 * The read outputs of `root` the actor may read (`default` first, then the named ones in declaration order). An
 * administrator reads every workspace model and the member directory; another built-in model only through a grant.
 */
export function readOutputs(m: EngineManifest, a: Authority, root: string): readonly string[] {
	if (root === 'sys_run') return [];
	return outputsOf(m, root).filter((output) => {
		const arms = a.models[root]?.read[output]?.[root] ?? [];
		return Object.hasOwn(SYSTEM.models, root)
			? arms.some(
					(arm) =>
						arm.policy !== '$admin' ||
						root === 'sys_user' ||
						root === 'sys_integration' ||
						root === 'sys_workspace'
				)
			: arms.length > 0;
	});
}

export const outputLayers = (m: EngineManifest, root: string, output: string) => {
	const spec = layered(m).exposures[root];
	return spec?.outputs[output] ?? {};
};

/**
 * What the actor may read: each read root (a model with `read`, never the run ledger) with an output it may read, with
 * every layer path those outputs declare.
 */
export function readPaths(m: EngineManifest, a: Authority): string[] {
	return Object.keys(layered(m).exposures).flatMap((root) => [
		...new Set(
			readOutputs(m, a, root).flatMap((output) => Object.keys(outputLayers(m, root, output)))
		)
	]);
}

export function mayDecide(m: Engine['manifest'], a: Authority): boolean {
	return (
		a.actor.kind === 'member' &&
		!a.actor.external &&
		Object.values(m.policies).some((policy) => Object.values(policy.grants).some(routesApproval))
	);
}

export function callablesFor(m: EngineManifest, a: Authority, identity = false): Map<string, Spec> {
	const acts = new Map<string, Spec>();
	for (const [c, spec] of Object.entries(m.exposures)) {
		const ca = a.models[c];
		for (const v of VERBS) {
			const arms =
				v === 'import'
					? Math.max(ca?.create.length ?? 0, ca?.update.length ?? 0)
					: (ca?.[v].length ?? 0);
			const declared =
				v === 'import'
					? spec.create !== undefined && (m.models[c]?.key?.length ?? 0) > 0
					: spec[v] !== undefined;
			if (declared && (a.admin || arms > 0))
				acts.set(
					`${c}.${v}`,
					Object.hasOwn(SYSTEM.models, c) && c !== 'sys_user' ? { confirm: true } : {}
				);
		}
	}
	if (identity && a.admin && a.actor.kind === 'member' && !a.actor.external)
		acts.set('sys_invitation.create', { confirm: true });
	if (mayDecide(m, a)) acts.set(APPROVE, { confirm: true });
	return acts;
}

/** The step's facts, in the closing note (the system prompt names the identity): the time, and an envoy's sender. */
export function turnFacts(e: Engine, a: Authority, b: Bindings, tz?: string): string {
	const x = a.actor,
		wtz = e.manifest.workspace.tz;
	return (
		`Now: ${localTime(b.now, wtz)} (${wtz}, ${b.now})${tz === undefined || tz === wtz ? '' : `; theirs ${localTime(b.now, tz)} (${tz})`}.` +
		(x.kind === 'envoy'
			? ` The newest message is from ${x.sender}${x.linked === undefined ? '' : `, linked to ${x.linked.email ?? x.linked.id} (member id ${x.linked.id})`}.`
			: '')
	);
}

export function receipt(receipts: Receipt[], callable: string, o: Outcome): void {
	if (o.kind !== 'committed' && o.kind !== 'pending_approval') return;
	const records = o.records.map(({ model, id }) => ({ model, id }));
	receipts.push(
		o.kind === 'committed'
			? { outcome: 'committed', callable, records }
			: { outcome: 'pending_approval', callable, request_id: o.request_id, records }
	);
}

export const requestId = (
	x: Pick<ToolContext, 'authority' | 'turn'> & { readonly conv: { readonly id: string } },
	call: string,
	key?: string
) =>
	stableId(
		'agent.run',
		actor_ref(x.authority.actor),
		x.conv.id,
		...(key === undefined ? [x.turn, call] : [key])
	);

export type OpenedFile = { mime: string; bytes: Uint8Array; id?: string };

export const attach = (files: OpenedFile[], file: OpenedFile): 'shown' | 'none' => {
	if (file.id !== undefined && files.some((f) => f.id === file.id)) return 'shown';
	const bytes = files.reduce((sum, f) => sum + f.bytes.byteLength, 0) + file.bytes.byteLength;
	if (files.length >= MODEL_FILES.count || bytes > MODEL_FILES.bytes) return 'none';
	files.push(file);
	return 'shown';
};

export const ATTACHED = {
	shown: 'shown on your next step only',
	none: 'not shown: too many images at once'
} as const;

export const validatorOf = (json: { readonly [k: string]: Json }) => {
	const validator = new Validator(json, '2020-12', false);
	return (value: unknown): Json | string => {
		const checked = Result.try(() => validator.validate(value));
		if (Result.isSuccess(checked) && !checked.success.valid)
			return `Invalid input: ${checked.success.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join('; ')}`;
		return Option.getOrElse(
			Schema.decodeUnknownOption(Schema.Json)(value),
			() => 'Invalid input: not JSON'
		);
	};
};

export const validatorFor = (validators: Validators, input: { readonly [key: string]: Json }) => {
	const valid = validators.get(input) ?? validatorOf(input);
	validators.set(input, valid);
	return valid;
};

export const mcpName = (server: string, tool: string) => {
	const plain = `${server}__${tool}`;
	return /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(server) &&
		/^[A-Za-z0-9_-]+$/.test(tool) &&
		plain.length <= 64
		? plain
		: `${`${server}_${tool}`.replace(/[^A-Za-z0-9-]+/g, '_').slice(0, 51).replace(/_+$/, '')}_${sha256_hex(`${server}\0${tool}`).slice(0, 12)}`;
};
