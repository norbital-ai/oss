// `run_js` (compute model §3, "Agents' scripts" and "Running a file"): an agent's JavaScript, run in a fresh guest
// isolate through `GuestIsolates`, never in the cell. Inline code is the body of one async function whose only
// crossing is `http`. A file is a skill's or a repository reference's script run as written (a reference's never has
// `fetch`): the host's confined bundler makes its tree one module
// (`Bundler`), and the isolate runs that bundle over a virtual Node (`run-js-node.ts`) whose crossings are its mounts,
// its outputs and `fetch`. HTTP is answered here through `Http` only for a run granted it; every other call is refused.
// The files a run returns are classified by their bytes, and an executable or an unrecognized binary is never kept.
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { Effect, Option, Predicate, Result, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import {
	CONVERT_MIME,
	LIMITS,
	type GuestTurn,
	type HttpRequest,
	type HttpResponse
} from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { fromBase64 } from '../crypto.ts';
import { DOWNLOAD, mediaType } from '../files/media.ts';
import { PRELUDE } from '../guest/prelude.ts';
import { Port, type PortFailure } from '../port.ts';
import type { Bundler, GuestIsolates, Http } from '../ports.ts';
import type { BoltError } from '../../protocol/errors.ts';
import { NODE_SHIM } from './run-js-node.ts';

const MiB = 1024 * 1024;
/** The script's walls besides the host's CPU (what is left of the unit's 2 s) and its 256 MiB heap. */
export const RUN_JS = {
	wallMs: 60_000,
	httpMs: 20_000,
	httpBytes: 4 * MiB,
	answerBytes: 4 * MiB,
	/** Console text kept (characters); past it lines are counted, not kept. */
	consoleChars: MiB,
	/** What a file run writes to /out, and the conversation files it is handed at /in. */
	outBytes: 64 * MiB,
	inBytes: 64 * MiB,
	/** A bundle, a cold bundler included. */
	bundleMs: 60_000
} as const;

// The script is the body of one async function, and everything before it sits on its first line, so the module's
// lines are the script's (a column on line 1 is offset by the head's length).
const HTTP =
	"const http = (request) => globalThis[Symbol.for('norbital.bolt.call')]('http', [request]).catch((e) => { throw Object.assign(new Error(e.message), { kind: e.kind }); }); ";
const headOf = (http: boolean) => `${http ? HTTP : ''}export default { run: async (input) => { `;

/** `line:column` in the script, from a `guest.mjs` position; `undefined` inside the head (the `http` wrapper). */
const at = (head: number, line: number, column: number): string | undefined =>
	line > 1 ? `line ${line}:${column}` : column > head ? `line 1:${column - head}` : undefined;
const positionIn = (head: number, text: string): string | undefined => {
	for (const [, line = '0', column = '0'] of text.matchAll(/guest\.mjs:(\d+):(\d+)/g)) {
		const where = at(head, Number(line), Number(column));
		if (where !== undefined) return where;
	}
	return undefined;
};
const located = (text: string, where: string | undefined) =>
	where === undefined ? text : `${text} (${where})`;

/** A wall a session hit, by name. */
const wallOf = (error: BoltError): string | undefined =>
	error.code === 'cpuBudget'
		? `the script used its ${LIMITS.guestCpuMs / 1000} s of CPU`
		: error.code === 'memory'
			? `the script used its ${LIMITS.guestMemoryMiB} MiB of memory`
			: undefined;
/** A session's failure in the script's terms: its walls by name, a syntax error at its line. */
const failureOf = (error: BoltError, head: number): string => {
	const wall = wallOf(error);
	if (wall !== undefined) return wall;
	const cause = error.cause;
	const message =
		Predicate.hasProperty(cause, 'message') && Predicate.isString(cause.message)
			? cause.message
			: '';
	// a compile error is the host's: V8 puts its position at the end of the message
	const syntax = / \[guest\.mjs:(\d+):(\d+)\]$/.exec(message);
	return syntax === null
		? error.message
		: located(
				`SyntaxError: ${message.slice(0, syntax.index)}`,
				at(head, Number(syntax[1]), Number(syntax[2]))
			);
};
const request = {
	method: Schema.optionalKey(Schema.String),
	url: Schema.String,
	headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
};
const HttpCall = Schema.fromJsonString(
	Schema.Tuple([Schema.Struct({ ...request, body: Schema.optionalKey(Schema.String) })])
);
/** A bytes value across the bridge: its index among the call's bytes. */
const Bin = Schema.Struct({ $bin: Schema.Number });
const FetchCall = Schema.fromJsonString(
	Schema.Tuple([Schema.Struct({ ...request, body: Schema.optionalKey(Bin) })])
);
const OutCall = Schema.fromJsonString(
	Schema.Tuple([
		Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Bin })) })
	])
);
const utf8 = new TextEncoder();
/** One crossing's answer, as the prelude's `give` parses it: a JSON text and its bytes. */
type Answer = { readonly text: string; readonly bins: readonly Uint8Array[] };
const answered = (value: Json): Answer => ({ text: JSON.stringify(value), bins: [] });
const refuse = (message: string) => answered({ ok: false, error: { kind: 'invalid', message } });
/** One request under the script egress policy: no redirects, at most 4 MiB, 20 s. */
const fetchOne = (http: Http['Service'], req: HttpRequest) =>
	http.fetch(req, { redirects: 0, maxBytes: RUN_JS.httpBytes }).pipe(
		Port.call('http', RUN_JS.httpMs),
		Effect.map((response): Result.Result<HttpResponse, Answer> => Result.succeed(response)),
		Effect.catch((failure: PortFailure) =>
			Effect.succeed(
				Result.fail(
					answered({
						ok: false,
						error: {
							kind: failure._tag === 'Unavailable' ? 'unavailable' : failure.kind,
							message: failure.message
						}
					})
				)
			)
		)
	);
/** Inline code's crossing: `http`, for a run granted it. */
const inlineAnswer = (http: Http['Service'] | undefined, member: string, args: string) =>
	Effect.gen(function* () {
		if (member !== 'http' || http === undefined)
			return refuse(
				member === 'http' ? 'this run has no http' : `a script can only call http, not '${member}'`
			);
		const decoded = Schema.decodeUnknownOption(HttpCall)(args);
		if (Option.isNone(decoded)) return refuse('http takes { method?, url, headers?, body? }');
		const [req] = decoded.value;
		const got = yield* fetchOne(http, {
			method: req.method ?? 'GET',
			url: req.url,
			headers: Object.entries(req.headers ?? {}),
			...(req.body === undefined ? {} : { body: utf8.encode(req.body) })
		});
		return Result.isFailure(got)
			? got.failure
			: answered({
					ok: true,
					value: {
						status: got.success.status,
						headers: Object.fromEntries(got.success.headers),
						text: new TextDecoder().decode(got.success.body)
					}
				});
	});

type Outcome =
	{ readonly ok: true; readonly answer: Json } | { readonly ok: false; readonly error: string };
/** How a run's failures read: a throw (name, message, stack) and a session's own failure. */
type Failures = {
	readonly thrown: (name: string, message: string, stack: string) => string;
	readonly session: (error: BoltError) => string;
};
/** The guest loop: start, answer each batch of calls, until the body settles. */
const execute = (
	guest: GuestIsolates['Service'],
	source: string,
	input: Json,
	invocation: string,
	said: (turn: GuestTurn) => void,
	answer: (member: string, args: string, bins: readonly Uint8Array[]) => Effect.Effect<Answer>,
	failures: Failures
): Effect.Effect<Outcome> => {
	const turn = (next: Effect.Effect<GuestTurn, BoltError>) =>
		Effect.tap(next, (t) => Effect.sync(() => said(t)));
	return Effect.gen(function* () {
		const session = yield* guest.open(
			{ source },
			{
				prelude: PRELUDE,
				seed: globalThis.crypto.randomUUID(),
				memoryMiB: LIMITS.guestMemoryMiB,
				once: true
			}
		);
		let { taken } = yield* turn(
			session.start({
				kind: 'tool',
				path: ['run'],
				input: JSON.stringify([input]),
				ctx: '{}',
				invocation
			})
		);
		for (;;) {
			const [final, calls, bins, ranTimer] = taken;
			if (ranTimer) {
				({ taken } = yield* turn(session.take));
				continue;
			}
			if (final !== null)
				switch (final[0]) {
					case 'ok': {
						if (utf8.encode(final[1]).byteLength > RUN_JS.answerBytes)
							return {
								ok: false,
								error: `the answer is over ${RUN_JS.answerBytes / MiB} MiB`
							} as const;
						const value = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(final[1]);
						return Option.isSome(value)
							? ({ ok: true, answer: value.value } as const)
							: ({ ok: false, error: 'the answer is not JSON' } as const);
					}
					case 'error':
						return { ok: false, error: failures.thrown(final[1], final[2], final[3]) } as const;
					default:
						return { ok: false, error: final[1] } as const;
				}
			if (calls.length === 0)
				return {
					ok: false,
					error: 'the script awaits something that never settles (only http answers)'
				} as const;
			const answers = yield* Effect.forEach(
				calls,
				([member, args], i) => answer(member, args, bins[i] ?? []),
				{ concurrency: 'unbounded' }
			);
			({ taken } = yield* turn(
				session.give({
					ids: calls.map((call) => call[3]),
					texts: answers.map((a) => a.text),
					bins: answers.map((a) => a.bins)
				})
			));
		}
	}).pipe(
		Effect.scoped,
		Effect.catch((error: BoltError) =>
			Effect.succeed({ ok: false, error: failures.session(error) } as const)
		),
		Effect.timeoutOrElse({
			duration: RUN_JS.wallMs,
			orElse: () =>
				Effect.succeed({
					ok: false,
					error: `the script ran past its ${RUN_JS.wallMs / 1000} s wall`
				} as const)
		})
	);
};

const ascii = (b: Uint8Array, at: number, length: number): string =>
	String.fromCharCode(...b.subarray(at, at + length));
const starts = (b: Uint8Array, magic: readonly number[]) => magic.every((x, i) => b[i] === x);
/** ELF, PE (and DOS), Mach-O thin and fat. */
const EXECUTABLES = [
	[0x7f, 0x45, 0x4c, 0x46],
	[0x4d, 0x5a],
	[0xfe, 0xed, 0xfa, 0xce],
	[0xfe, 0xed, 0xfa, 0xcf],
	[0xce, 0xfa, 0xed, 0xfe],
	[0xcf, 0xfa, 0xed, 0xfe],
	[0xca, 0xfe, 0xba, 0xbe]
];
// a zip is an office document by its name, else an archive; a legacy (OLE) office file only by its name
const ZIPPED: { readonly [ext: string]: string } = {
	docx: CONVERT_MIME.docx,
	pptx: CONVERT_MIME.pptx,
	odt: CONVERT_MIME.odt,
	epub: CONVERT_MIME.epub,
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	odp: 'application/vnd.oasis.opendocument.presentation'
};
const OLE: { readonly [ext: string]: string } = {
	doc: 'application/msword',
	xls: 'application/vnd.ms-excel',
	ppt: 'application/vnd.ms-powerpoint'
};
const ARCHIVES: readonly (readonly [magic: readonly number[], mime: string])[] = [
	[[0x1f, 0x8b], 'application/gzip'],
	[[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 'application/x-7z-compressed'],
	[[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], 'application/x-xz'],
	[[0x42, 0x5a, 0x68], 'application/x-bzip2']
];
const TEXT: { readonly [ext: string]: string } = {
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	json: 'application/json',
	md: 'text/markdown',
	markdown: 'text/markdown'
};
const isUtf8 = (bytes: Uint8Array) => {
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
};
/**
 * What a returned file is, by its bytes (the name only tells office documents and text kinds apart): media, an office
 * document or a PDF, an archive, or UTF-8 text. An executable or any other binary is refused.
 */
export function outputType(
	bytes: Uint8Array,
	name: string
): { mime: string } | { refused: string } {
	const head = bytes.subarray(0, DOWNLOAD.headBytes),
		binary = bytes.includes(0),
		ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
	// every executable header holds a NUL, so a text that happens to start "MZ" stays text
	if (binary && EXECUTABLES.some((magic) => starts(head, magic)))
		return { refused: 'an executable' };
	const media = mediaType(head);
	if (media !== undefined) return { mime: media };
	if (ascii(head, 0, 4) === 'PK\x03\x04' || ascii(head, 0, 4) === 'PK\x05\x06')
		return { mime: ZIPPED[ext] ?? 'application/zip' };
	const legacy = OLE[ext];
	if (legacy !== undefined && starts(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
		return { mime: legacy };
	const archive = ARCHIVES.find(([magic]) => starts(head, magic));
	if (archive !== undefined) return { mime: archive[1] };
	if (ascii(head, 257, 5) === 'ustar') return { mime: 'application/x-tar' };
	if (!binary && isUtf8(bytes)) return { mime: TEXT[ext] ?? 'text/plain' };
	return { refused: 'not a recognized file type' };
}

const Returned = Schema.Struct({
	files: Schema.Array(
		Schema.Union([
			Schema.Struct({ name: Schema.NonEmptyString, text: Schema.String }),
			Schema.Struct({ name: Schema.NonEmptyString, base64: Schema.String })
		])
	)
});
export type RunJsFile = {
	readonly name: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
};
/** Keeps a returned file as the person's output (`storeFile`) and answers its reference; absent, files are refused. */
type Keep = ((file: RunJsFile) => Effect.Effect<Json, EngineError | PortFailure>) | undefined;
export type RunJs = {
	readonly code: string;
	readonly input: Json;
	readonly guest: GuestIsolates['Service'];
	/** Only for a run granted HTTP: the script then has `http`. */
	readonly http: Http['Service'] | undefined;
	/** The call id: the guest invocation's. */
	readonly invocation: string;
	readonly keep: Keep;
};
/** The console a run printed, at most `consoleChars`; past it lines are counted. */
const printer = () => {
	const lines: string[] = [];
	let chars = 0,
		dropped = 0;
	return {
		said: ({ lines: turn, dropped: lost }: GuestTurn) => {
			dropped += lost;
			for (const [level, line] of turn) {
				const text = level === 'log' || level === 'info' ? line : `${level}: ${line}`;
				if (chars + text.length > RUN_JS.consoleChars) dropped++;
				else {
					lines.push(text);
					chars += text.length;
				}
			}
		},
		printed: () => ({
			...(lines.length === 0 ? {} : { console: lines }),
			...(dropped === 0 ? {} : { dropped })
		})
	};
};
/** Each file classified and kept, or refused with the reason. */
const keepAll = Effect.fn('Agents.runJsKeep')(function* (
	files: readonly { readonly name: string; readonly bytes: Uint8Array }[],
	keep: Keep
) {
	const kept: Json[] = [],
		refused: Json[] = [];
	for (const file of files) {
		const type = outputType(file.bytes, file.name);
		if ('refused' in type) refused.push({ name: file.name, reason: type.refused });
		else if (keep === undefined)
			refused.push({ name: file.name, reason: 'this workspace keeps no files' });
		else kept.push(yield* keep({ name: file.name, mime: type.mime, bytes: file.bytes }));
	}
	return { kept, refused: refused.length === 0 ? {} : { refused } };
});
/**
 * Runs the script and answers what the model sees: `{ answer, refused?, console?, dropped? }` (its returned files
 * replaced by their references) or `{ error, console?, dropped? }`.
 */
export const runJs = Effect.fn('Agents.runJs')(function* (run: RunJs) {
	const { said, printed } = printer();
	const head = headOf(run.http !== undefined);
	const outcome = yield* execute(
		run.guest,
		`${head}${run.code}\n} };`,
		run.input,
		run.invocation,
		said,
		(member, args) => inlineAnswer(run.http, member, args),
		{
			thrown: (name, message, stack) =>
				located(`${name}: ${message}`, positionIn(head.length, stack)),
			session: (error) => failureOf(error, head.length)
		}
	);
	if (!outcome.ok) return { error: outcome.error, ...printed() } satisfies Json;
	const answer = outcome.answer;
	if (!Predicate.isObject(answer) || !('files' in answer))
		return { answer, ...printed() } satisfies Json;
	const returned = Schema.decodeUnknownOption(Returned)(answer);
	if (Option.isNone(returned))
		return {
			error: 'files must be [{ name, text } | { name, base64 }]',
			...printed()
		} satisfies Json;
	const { kept, refused } = yield* keepAll(
		returned.value.files.map((file) => ({
			name: file.name,
			bytes: 'text' in file ? utf8.encode(file.text) : fromBase64(file.base64)
		})),
		run.keep
	);
	return { answer: { ...answer, files: kept }, ...refused, ...printed() } satisfies Json;
});

/**
 * A repository reference (compute model §3, "Agents' files"): the host's `reference` tool keeps this index as the
 * person's output file, named `<repository>@<commit>`, and a file run reads its tree from it. Each text file is a blob
 * by its content address. A run reads the whole tree, so a reference over `treeBytes` runs no file.
 */
export const REFERENCE = {
	mime: 'application/vnd.norbital.reference+json',
	treeBytes: 32 * MiB
} as const;
export const ReferenceIndex = Schema.Struct({
	repository: Schema.String,
	commit: Schema.NullOr(Schema.String),
	/** `treeDigest` of the tree: the bundler's cache key. */
	digest: Schema.String,
	files: Schema.Array(
		Schema.Struct({ path: Schema.String, key: Schema.String, bytes: Schema.Number })
	)
});
export type RunFile = {
	/** The script's path in its tree. */
	readonly entry: string;
	/** The tree (a skill's folder, a repository reference): its digest and every file by its path. */
	readonly digest: string;
	readonly tree: readonly (readonly [path: string, bytes: Uint8Array])[];
	/** `process.argv` after the script. */
	readonly args: readonly string[];
	/** The conversation files the call names, read-only at `/in/<name>`. */
	readonly inputs: readonly (readonly [name: string, bytes: Uint8Array])[];
	readonly guest: GuestIsolates['Service'];
	readonly bundler: Bundler['Service'];
	/** Only for a run granted HTTP: the script then has `fetch`. */
	readonly http: Http['Service'] | undefined;
	readonly invocation: string;
	readonly keep: Keep;
};
const ExitCode = Schema.Struct({ exitCode: Schema.Number });
/** A throw's stack with each bundle position at the author's `file:line:column`; frames outside the tree are dropped. */
const mapped = (map: string, name: string, message: string, stack: string) => {
	const trace = new TraceMap(map);
	const frames = stack
		.split('\n')
		.filter((line) => /^\s+at /.test(line))
		.flatMap((line) => {
			const position = /guest\.mjs:(\d+):(\d+)/.exec(line);
			if (position === null) return [];
			const original = originalPositionFor(trace, {
				line: Number(position[1]),
				column: Number(position[2]) - 1
			});
			const { source, line: at, column } = original;
			return source === null || at === null || column === null || source.includes('\0')
				? []
				: [line.replace(position[0], `${source}:${at}:${column + 1}`)];
		});
	return [`${name}: ${message}`, ...frames].join('\n');
};
/**
 * Runs a skill's script as written: one bundle from the host's bundler, one fresh isolate over its mounts. Answers
 * `{ exitCode, files?, refused?, console?, dropped? }` (what it wrote to /out kept as the person's files) or
 * `{ error, … }`: a bundle's errors at the author's `file:line:column`, a throw mapped back through the source map.
 */
export const runFile = Effect.fn('Agents.runFile')(function* (run: RunFile) {
	const bundled = yield* run.bundler
		.bundle({ digest: run.digest, entry: run.entry, files: run.tree })
		.pipe(Port.call('bundler', RUN_JS.bundleMs), Effect.result);
	if (Result.isFailure(bundled))
		return { error: `the script could not be bundled: ${bundled.failure.message}` } satisfies Json;
	if ('errors' in bundled.success)
		return { error: bundled.success.errors.join('\n') } satisfies Json;
	const { code, map } = bundled.success;
	const { said, printed } = printer();
	const mounts = [
		...run.tree.map(([path, bytes]) => [`/app/${path}`, bytes] as const),
		...run.inputs.map(([name, bytes]) => [`/in/${name}`, bytes] as const)
	];
	const outputs = new Map<string, Uint8Array>();
	let written = 0;
	const answer = (member: string, args: string, bins: readonly Uint8Array[]) =>
		Effect.gen(function* () {
			if (member === 'mounts')
				return {
					text: JSON.stringify({
						ok: true,
						value: {
							paths: mounts.map(([path]) => path),
							bytes: mounts.map((_, i) => ({ $bin: i }))
						}
					}),
					bins: mounts.map(([, bytes]) => bytes)
				};
			if (member === 'out') {
				const decoded = Schema.decodeUnknownOption(OutCall)(args);
				if (Option.isNone(decoded)) return refuse('out takes { files: [{ path, bytes }] }');
				for (const file of decoded.value[0].files) {
					const bytes = bins[file.bytes.$bin];
					if (bytes === undefined) return refuse('out names bytes it did not send');
					written += bytes.byteLength;
					if (written > RUN_JS.outBytes) return refuse(`outputs over ${RUN_JS.outBytes / MiB} MiB`);
					outputs.set(file.path, bytes);
				}
				return answered({ ok: true, value: null });
			}
			if (member !== 'fetch' || run.http === undefined)
				return refuse(
					member === 'fetch'
						? 'this run has no fetch'
						: `a file run can only call fetch, not '${member}'`
				);
			const decoded = Schema.decodeUnknownOption(FetchCall)(args);
			if (Option.isNone(decoded))
				return refuse('fetch takes a url and { method?, headers?, body? }');
			const [req] = decoded.value;
			const body = req.body === undefined ? undefined : bins[req.body.$bin];
			const got = yield* fetchOne(run.http, {
				method: req.method ?? 'GET',
				url: req.url,
				headers: Object.entries(req.headers ?? {}),
				...(body === undefined ? {} : { body })
			});
			return Result.isFailure(got)
				? got.failure
				: {
						text: JSON.stringify({
							ok: true,
							value: {
								status: got.success.status,
								headers: Object.fromEntries(got.success.headers),
								body: { $bin: 0 }
							}
						}),
						bins: [got.success.body]
					};
		});
	const outcome = yield* execute(
		run.guest,
		`${code}\n${NODE_SHIM}`,
		{ entry: `/app/${run.entry}`, args: [...run.args], http: run.http !== undefined },
		run.invocation,
		said,
		answer,
		{
			thrown: (name, message, stack) => mapped(map, name, message, stack),
			session: (error) => wallOf(error) ?? error.message
		}
	);
	const { kept, refused } = yield* keepAll(
		[...outputs].map(([name, bytes]) => ({ name, bytes })),
		run.keep
	);
	const files = kept.length === 0 ? {} : { files: kept };
	if (!outcome.ok)
		return { error: outcome.error, ...files, ...refused, ...printed() } satisfies Json;
	const exit = Schema.decodeUnknownOption(ExitCode)(outcome.answer);
	return {
		exitCode: Option.isSome(exit) ? exit.value.exitCode : 0,
		...files,
		...refused,
		...printed()
	} satisfies Json;
});
