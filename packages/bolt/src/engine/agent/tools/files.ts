import { Clock, Deferred, Effect, Option, Predicate, Schema } from 'effect';
import {
	CONVERT_MIME,
	type Downloaded,
	type ImageCrop,
	type Ingested,
	Port,
	REFERENCE,
	ReferenceIndex,
	uuidv7
} from '@norbital-ai/host-api';
import { sha256_hex } from '@norbital-ai/store';
import type { Json } from '../../../decl/values.ts';
import { BoltError } from '../../../protocol/errors.ts';
import { CapturedResult, capturePiece, nativeCommit } from '../../db/captured.ts';
import { readableFile } from '../../decision.ts';
import { imageCrop, image_jpeg } from '../../files/image.ts';
import { Images } from '../../ports.ts';
import { row as systemRow } from '../../system/rows.ts';
import { Chain } from '../../write/sql.ts';
import { MODEL_FILES } from '../ai.ts';
import { outputText, size } from '../context.ts';
import { isObj } from '../draft.ts';
import type { AgentEngine as Engine } from '../index.ts';
import {
	cached,
	dataLine,
	dataSummary,
	entryFiles,
	flight,
	grep,
	imageIngest,
	imagesIn,
	INGEST_BYTES,
	isArchive,
	isUtf8Text,
	outlineMap,
	route,
	stash,
	StoredFile,
	summary,
	TEXT_SNIFF_BYTES,
	textIngest,
	transcriptOf,
	unparsed,
	WINDOW_IMAGES,
	type Stash
} from '../ingest.ts';
import { RUN_JS } from '../run-js.ts';
import {
	documentTool,
	downloadTool,
	readFileTool,
	readOutputTool
} from './definitions.ts';
import {
	attach,
	ATTACHED,
	documentAnswer,
	err,
	linePage,
	ok,
	textAnswer
} from './helpers.ts';
import { jobFailed, JOBS } from './jobs.ts';
import {
	READ_LINES,
	TILED_PAGES,
	TILES,
	ZOOMS,
	type AddTool,
	type HoldTool,
	type ToolContext
} from './types.ts';

const InputFile = systemRow('sys_file', ['id', 'name', 'mime', 'key', 'size']);
const SourceFile = systemRow('sys_file', ['id', 'name', 'mime', 'size', 'key', 'sha256']);
const ReferenceFile = systemRow('sys_file', ['key', 'size']);
const ReferenceJson = Schema.fromJsonString(ReferenceIndex);

const IngestEntry = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	name: Schema.String,
	files: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				mime: Schema.String,
				size: Schema.Number
			})
		)
	),
	ingest: Schema.Struct({
		output: Schema.String,
		source: Schema.String,
		sha256: Schema.String,
		status: Schema.Literals(['ingesting', 'ready', 'failed']),
		job: Schema.optionalKey(Schema.String),
		error: Schema.optionalKey(Schema.String),
		entry: Schema.optionalKey(Schema.String)
	})
});

const FileRefs = Schema.Struct({ files: Schema.Array(Schema.Struct({ id: Schema.String })) });

export const namedFiles = (input: Json) =>
	Option.match(Schema.decodeUnknownOption(FileRefs)(input), {
		onNone: () => [],
		onSome: ({ files }) => files
	});

export const sourceFile = (x: ToolContext, id: string) =>
	x.engine.db.rows(SourceFile, {
		text: 'SELECT id, name, mime, size, key, sha256 FROM sys_file WHERE id = $1',
		params: [id]
	});

export const canRead = Effect.fn('AgentTool.canRead')(function* (x: ToolContext, id: string) {
	const [r] = yield* x.engine.db.read([
		{
			text: `SELECT f.field, f.created_by, EXISTS (
					SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.outputs) o
					WHERE c.id = $2 AND (o->>'id' = f.id OR o->'files' @> jsonb_build_array(jsonb_build_object('id', f.id)))
				) AS own, EXISTS (
					SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.inputs) i
					WHERE c.id = $2 AND i->>'id' = f.id
				) AS here FROM sys_file f WHERE f.id = $1`,
			params: [id, x.conv.id]
		}
	]);
	const row = r?.rows[0],
		field = row?.['field'],
		member = x.authority.actor.kind === 'member' ? x.authority.actor.id : undefined;
	if (row?.['own'] === true || row?.['here'] === true) return true;
	if (
		field === 'sys_conversation.inputs' &&
		(x.authority.admin || (member !== undefined && row?.['created_by'] === member))
	)
		return true;
	if (typeof field !== 'string' || !field.includes('.') || field.startsWith('sys_conversation.'))
		return false;
	const { manifest, db, read } = x.engine;
	return yield* readableFile(
		{ manifest, db, read, authority: x.authority, bindings: x.bindings },
		id,
		field
	);
});

export const inputOfFile = Effect.fn('AgentTool.inputOfFile')(function* (
	x: ToolContext,
	fileId: string
) {
	const a = x.authority,
		e = x.engine,
		member = a.actor.kind === 'member' ? a.actor.id : null,
		files = e.files;
	if (files === undefined || member === null)
		return { error: 'This host stores no files; give input.' };
	const [f] = yield* e.db.rows(ReferenceFile, {
		text: 'SELECT key, size FROM sys_file WHERE id = $1 AND created_by = $2',
		params: [fileId, member]
	});
	if (f === undefined)
		return {
			error: `No file ${fileId} of yours; give the id of a file you uploaded or a tool stored for you.`
		};
	if (f.size > MODEL_FILES.fileBytes)
		return {
			error: `That file is over ${MODEL_FILES.fileBytes / 1024 / 1024} MiB; split the input.`
		};
	return yield* files.get(f.key, MODEL_FILES.fileBytes).pipe(
		Port.call('files', 30000),
		Effect.flatMap((bytes) =>
			Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
				new TextDecoder().decode(bytes)
			)
		),
		Effect.map((input) => ({ input })),
		Effect.catch((error) => Effect.succeed({ error: `That file is not JSON: ${error.message}` }))
	);
});

export const recordFile = Effect.fn('Agents.recordFile')(function* (x: ToolContext, file: Downloaded) {
	const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null;
	const id = uuidv7(Date.parse(x.bindings.now));
	const ref = { id, name: file.name, mime: file.mime, size: file.bytes };
	const chain = new Chain();
	capturePiece(
		chain,
		'filed',
		'sys_file',
		`INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
		VALUES (${chain.p(id)}, ${chain.p(file.name)}, ${chain.p(file.mime)}, ${chain.p(file.bytes)}, ${chain.p(file.key)}, ${chain.p(file.sha256)},
			'sys_conversation.outputs', ${chain.p(x.bindings.now)}::timestamptz, ${chain.p(member)})`
	);
	capturePiece(
		chain,
		'listed',
		'sys_conversation',
		`UPDATE sys_conversation SET outputs = outputs || ${chain.p(JSON.stringify([ref]))}::jsonb WHERE id = ${chain.p(x.conv.id)}`
	);
	yield* nativeCommit(x.engine.db.write, x.engine.live.publish, chain, CapturedResult);
	return ref;
});

export const storeFile = Effect.fn('Agents.storeFile')(function* (
	x: ToolContext,
	files: NonNullable<Engine['files']>,
	f: { name: string; mime: string; bytes: Uint8Array }
) {
	const blob = yield* files.put(f.bytes, { name: f.name, mime: f.mime });
	return yield* recordFile(x, { ...blob, name: f.name, mime: f.mime });
});

export const conversationFiles = Effect.fn('Agents.runFileInputs')(function* (
	x: ToolContext,
	refs: readonly { readonly id: string }[]
) {
	if (refs.length === 0) return [];
	const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null,
		files = x.engine.files,
		ids = refs.map((ref) => ref.id);
	if (member === null || files === undefined) return 'This run can be handed no files.';
	const rows = yield* x.engine.db.rows(InputFile, {
		text: `SELECT id, name, mime, key, size FROM sys_file f WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))
			AND field IN ('sys_conversation.inputs', 'sys_conversation.outputs') AND (created_by = $2 OR EXISTS (
				SELECT 1 FROM sys_conversation c, LATERAL jsonb_array_elements(c.outputs) o
				WHERE c.id = $3 AND (o->>'id' = f.id OR o->'files' @> jsonb_build_array(jsonb_build_object('id', f.id)))
			))`,
		params: [JSON.stringify(ids), member, x.conv.id]
	});
	const byId = new Map(rows.map((file) => [file.id, file]));
	const named: {
		readonly id: string;
		readonly name: string;
		readonly type: string;
		readonly bytes: Uint8Array;
	}[] = [];
	let bytes = 0;
	for (const [n, id] of ids.entries()) {
		const file = byId.get(id);
		if (file === undefined) return `File ${id} is not one of your files in this conversation.`;
		const name = file.name.replaceAll('/', '_');
		if (named.some((taken) => taken.name === name)) return `Two files are named ${name}.`;
		bytes += file.size;
		if (bytes > RUN_JS.inBytes) return `The files are over ${RUN_JS.inBytes / 1024 / 1024} MiB.`;
		named.push({
			id: refs[n]?.id ?? id,
			name,
			type: file.mime,
			bytes: yield* files.get(file.key, file.size)
		});
	}
	return named;
});

const referenceIndex = Effect.fn('Agents.referenceIndex')(function* (x: ToolContext, name: string) {
	const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null,
		files = x.engine.files;
	if (member === null || files === undefined) return 'This run reads no repository references.';
	const [row] = yield* x.engine.db.rows(ReferenceFile, {
		text: `SELECT key, size FROM sys_file WHERE name = $1 AND mime = $2 AND field = 'sys_conversation.outputs' AND created_by = $3 ORDER BY created_at DESC LIMIT 1`,
		params: [name, REFERENCE.mime, member]
	});
	if (row === undefined)
		return `No repository reference '${name}' is yours: bring it in with reference first.`;
	const index = Schema.decodeUnknownOption(ReferenceJson)(
		new TextDecoder().decode(yield* files.get(row.key, row.size))
	);
	return Option.isNone(index) ? `The reference ${name} cannot be read.` : index.value;
});

const readReference = Effect.fn('Agents.readReference')(function* (
	x: ToolContext,
	reference: string,
	i: {
		readonly path?: string | undefined;
		readonly offset?: number | undefined;
		readonly limit?: number | undefined;
		readonly text?: string | undefined;
	}
) {
	const entry = i.path?.replace(/^\/+|\/+$/g, ''),
		id = entry ? `${reference.replace(/\/$/, '')}/${entry}` : reference,
		slash = id.indexOf('/'),
		name = slash < 0 ? id : id.slice(0, slash),
		path = slash < 0 ? '' : id.slice(slash + 1),
		index = yield* referenceIndex(x, name),
		files = x.engine.files;
	if (typeof index === 'string') return err(index);
	if (files === undefined) return err('This host stores no files.');
	const read = (file: (typeof index.files)[number]) =>
		Effect.map(files.get(file.key, file.bytes), (bytes) => new TextDecoder().decode(bytes));
	const file = index.files.find((one) => one.path === path);
	if (file !== undefined && !i.text) {
		const page = linePage(yield* read(file), i.offset, i.limit, 'text');
		if ('error' in page) {
			if (file.bytes === 0 && (i.offset ?? 1) === 1) return textAnswer(`Read ${id}, 0 lines`);
			return err(`${page.error} in ${id}`);
		}
		const w = page.window;
		return textAnswer(
			[
				`Read ${id}, lines ${w.from}-${w.to} of ${w.total}`,
				...w.lines,
				...(w.to === w.total ? [] : [`[Output truncated. Continue reading with offset: ${w.to + 1}]`])
			].join('\n')
		);
	}
	const folder = path === '' ? '' : `${path.replace(/\/$/, '')}/`,
		under = file === undefined ? index.files.filter((one) => one.path.startsWith(folder)) : [file];
	if (under.length === 0) return err(`${name} has no file '${path}'.`);
	if (!i.text) {
		const start = Math.max(0, (i.offset ?? 1) - 1);
		if (start >= under.length)
			return err(`Offset ${start + 1} is out of range (${under.length} files) in ${id}`);
		const page = under.slice(
			start,
			start + Math.min(READ_LINES, Math.max(1, i.limit ?? READ_LINES))
		);
		const lines = page.map((one) => `${one.path}  ${one.bytes}`);
		const next = start + page.length;
		if (next < under.length)
			lines.push(`[Output truncated. Continue reading with offset: ${next + 1}]`);
		return textAnswer(lines.join('\n'));
	}
	const hits: string[] = [];
	const limit = Math.min(200, Math.max(1, i.limit ?? 200));
	const offset = Math.max(1, i.offset ?? 1);
	let skipped = offset - 1;
	for (let n = 0; n < under.length; n += 8) {
		const batch = under.slice(n, n + 8);
		const texts = yield* Effect.forEach(batch, read, { concurrency: 8 });
		for (const [j, text] of texts.entries()) {
			const result = grep(text, i.text, limit + 1 - hits.length, 'text', skipped);
			skipped = Math.max(0, skipped - result.total);
			for (const hit of result.hits) hits.push(`${batch[j]?.path}:${hit.from}: ${hit.text}`);
			if (hits.length > limit)
				return textAnswer(
					[
						...hits.slice(0, limit),
						`[More matching lines. Continue with offset: ${offset + limit}]`
					].join('\n')
				);
		}
	}
	return textAnswer(
		hits.length > 0
			? hits.join('\n')
			: offset > 1
				? `No matching lines at offset ${offset} in ${id}.`
				: `Nothing in ${id} holds '${i.text}'.`
	);
});

export const referenceTree = Effect.fn('Agents.referenceTree')(function* (
	x: ToolContext,
	name: string,
	entry: string
) {
	const index = yield* referenceIndex(x, name),
		files = x.engine.files;
	if (typeof index === 'string') return index;
	if (files === undefined) return 'This run reads no repository references.';
	const { digest, files: listed } = index;
	if (!listed.some((file) => file.path === entry))
		return `The reference ${name} has no text file '${entry}'.`;
	if (listed.reduce((sum, file) => sum + file.bytes, 0) > REFERENCE.treeBytes)
		return `The reference ${name} is over ${REFERENCE.treeBytes / 1024 / 1024} MiB of text: too large to run a file from.`;
	const tree = yield* Effect.forEach(
		listed,
		(file) =>
			Effect.map(files.get(file.key, file.bytes), (bytes): readonly [string, Uint8Array] => [
				file.path,
				bytes
			]),
		{ concurrency: 8 }
	);
	return { digest, tree };
});

export function bindFileTools(
	x: ToolContext,
	add: AddTool,
	hold: HoldTool,
	agent: boolean,
	staff: boolean
) {
	const e = x.engine;
	const readOutput = Effect.fn('AgentTool.readOutput')(function* (call: string, offset: number) {
		const named = yield* x.output(call === '' ? null : call),
			latest = named === undefined && call !== '' ? yield* x.output(null) : undefined,
			full = named ?? latest;
		if (full === undefined) return err('No result was clipped in this conversation.');
		const text = outputText(full),
			from = Math.max(0, offset),
			parts: string[] = [];
		let at = from;
		for (let used = 0; at < text.length; ) {
			const part = text.slice(at, at + 1000);
			if ((used += size(part)) > 14000 && parts.length > 0) break;
			parts.push(part);
			at += part.length;
		}
		return {
			result: {
				offset: from,
				total: text.length,
				parts,
				...(latest === undefined
					? {}
					: { note: `No saved output for call '${call}'; this is the latest clipped result.` }),
				...(at < text.length ? { next: at } : {})
			},
			bounded: true as const
		};
	});

	const tileCache = new Map<string, readonly Uint8Array[]>();
	const tiled = Effect.fn('AgentTool.tiled')(function* (bytes: Uint8Array, id: string) {
		const images = x.engine.images;
		if (images === undefined) return;
		const cachedTiles = tileCache.get(id);
		const tiles =
			cachedTiles ??
			(yield* Effect.forEach(
				TILES,
				(tile) =>
					imageCrop(bytes, tile).pipe(
						Effect.flatMap((crop) => image_jpeg(crop, 2048)),
						Effect.provideService(Images, images)
					),
				{ concurrency: TILES.length }
			));
		if (cachedTiles === undefined) tileCache.set(id, tiles);
		for (const [n, tile] of tiles.entries())
			attach(x.files, { mime: 'image/jpeg', bytes: tile, id: `${id}#tile:${n}` });
	});

	const readStored = Effect.fn('AgentTool.readStored')(function* (
		port: NonNullable<typeof x.attachments>,
		file: Json
	) {
		const fileId = isObj(file) && typeof file['id'] === 'string' ? file['id'] : undefined;
		const got = yield* port.read(file).pipe(Port.call('files', 30000));
		if (
			Predicate.isObject(got) &&
			'bytes' in got &&
			got.bytes instanceof Uint8Array &&
			'mime' in got &&
			typeof got.mime === 'string'
		) {
			const seen = attach(x.files, {
				mime: got.mime,
				bytes: got.bytes,
				...(fileId === undefined ? {} : { id: fileId })
			});
			if (seen === 'shown') yield* tiled(got.bytes, fileId ?? got.mime);
			return ok({ attached: ATTACHED[seen] });
		}
		const answer = yield* Schema.decodeUnknownEffect(Schema.Json)(got).pipe(
			Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message, error))
		);
		return isObj(answer) && typeof answer['text'] === 'string'
			? documentAnswer(answer, 'text')
			: ok(answer);
	});

	const readingKey = (output: string) => `${x.conv.id}/${output}`;
	const ingests = Effect.fn('AgentTool.ingests')(function* () {
		const [r] = yield* x.engine.db.read([
			{ text: 'SELECT outputs FROM sys_conversation WHERE id = $1', params: [x.conv.id] }
		]);
		const outputs = r?.rows[0]?.['outputs'];
		return (Array.isArray(outputs) ? outputs : []).flatMap((o) =>
			Option.toArray(Schema.decodeUnknownOption(IngestEntry)(o))
		);
	});

	const patchEntry = (output: string, patch: Json, state: Json) => {
		const chain = new Chain();
		capturePiece(
			chain,
			'patched',
			'sys_conversation',
			`UPDATE sys_conversation SET outputs = (SELECT jsonb_agg(CASE WHEN e->'ingest'->>'output' = ${chain.p(output)}
			THEN (e || ${chain.p(JSON.stringify(patch))}::jsonb) || jsonb_build_object('ingest', (e->'ingest') || ${chain.p(JSON.stringify(state))}::jsonb) ELSE e END ORDER BY n)
			FROM jsonb_array_elements(outputs) WITH ORDINALITY AS t(e, n)) WHERE id = ${chain.p(x.conv.id)}`
		);
		return nativeCommit(x.engine.db.write, x.engine.live.publish, chain, CapturedResult).pipe(
			Effect.asVoid
		);
	};

	const readIngest = Effect.fn('AgentTool.readIngest')(function* (
		entry: typeof IngestEntry.Type,
		i: {
			offset?: number | undefined;
			limit?: number | undefined;
			text?: string | undefined;
			image?: number | undefined;
			page?: number | undefined;
			crops?: readonly (readonly [number, number, number, number])[] | undefined;
			password?: string | undefined;
		}
	) {
		const o = entry.ingest.output,
			files = e.files;
		if (entry.ingest.status === 'ingesting')
			return ok({
				note: `Still being read: wait { jobs: ['${entry.ingest.job ?? o}'] } returns when it ends.`
			});
		if (entry.ingest.status === 'failed' || entry.id === undefined || files === undefined)
			return err(
				`The ingest of ${entry.name} failed: ${entry.ingest.error ?? 'its files are not stored'}.`
			);
		const ids = (entry.files ?? []).map((f) => f.id);
		const stored = yield* x.engine.db.rows(StoredFile, {
			text: `SELECT id, name, mime, size, key FROM sys_file WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(ids)]
		});
		const byId = new Map(stored.map((f) => [f.id, f]));
		const html = byId.get(entry.id);
		if (html === undefined)
			return err(`The ingest ${o} is no longer stored: ingest the file again.`);
		const images = new Map(
			ids.flatMap((id) => {
				const f = byId.get(id),
					name = f?.name.split('/images/')[1];
				return f === undefined || name === undefined || !f.name.includes('/images/')
					? []
					: [[name, f] as const];
			})
		);
		const show = Effect.fn('AgentTool.showImages')(function* (names: readonly string[]) {
			for (const name of names) {
				const f = images.get(name);
				if (f === undefined) continue;
				const bytes = yield* files.get(f.key, f.size);
				const seen = attach(x.files, { mime: f.mime, bytes, id: `${entry.id}#${name}` });
				if (names.length <= TILED_PAGES && seen === 'shown')
					yield* tiled(bytes, `${entry.id}#${name}`);
			}
		});
		if (i.page !== undefined) {
			const [source] = yield* sourceFile(x, entry.ingest.source);
			if (source === undefined || x.ingest === undefined)
				return err('The file is no longer stored.');
			const got = yield* x.ingest(source, {
				page: i.page,
				...(i.password === undefined ? {} : { password: i.password })
			});
			const picture = 'unsupported' in got ? undefined : got.images[0];
			if (picture === undefined) return err(`${entry.name} has no page ${i.page} to show.`);
			const id = `${entry.id}#page-${i.page}`;
			const seen = attach(x.files, { mime: picture.mime, bytes: picture.bytes, id });
			if (seen === 'shown') yield* tiled(picture.bytes, id);
			return ok({ page: i.page, attached: ATTACHED[seen] });
		}
		const crops = i.crops ?? [],
			imageNumber = i.image ?? (crops.length > 0 && images.size === 1 ? 1 : undefined);
		const taken = x.zooms.get(o) ?? 0;
		if (crops.length > 0) {
			if (taken >= ZOOMS) return err(`${o} has had its ${ZOOMS} zooms this turn.`);
			x.zooms.set(o, taken + 1);
		}
		if (crops.length > 0 && imageNumber === undefined)
			return err(`${o} has ${images.size} images: give image, the 1-based one to crop.`);
		const text = new TextDecoder().decode(yield* files.get(html.key, html.size));
		if (imageNumber !== undefined) {
			const name = [...images.keys()][imageNumber - 1];
			if (name === undefined) return err(`${o} has ${images.size} images; image is 1-based.`);
			if (crops.length === 0) yield* show([name]);
			else {
				const image = images.get(name);
				if (image === undefined) return err('The image is no longer stored.');
				if (x.engine.images === undefined) return err('The host provides no image cropping.');
				const source = yield* files.get(image.key, image.size);
				for (const [left, top, right, bottom] of crops) {
					const crop: ImageCrop = { left, top, right, bottom, min_edge: 1024 };
					attach(x.files, {
						mime: 'image/png',
						bytes: yield* imageCrop(source, crop).pipe(
							Effect.provideService(Images, x.engine.images)
						),
						id: `${entry.id}#${name}#crop:${left},${top},${right},${bottom}`
					});
				}
			}
			return ok({
				image: name,
				...(crops.length === 0
					? {}
					: {
							crops: crops.length,
							zoomsLeft: ZOOMS - (x.zooms.get(o) ?? 0)
						}),
				attached: ATTACHED.shown
			});
		}
		if (html.mime === 'application/json') {
			const run = `run_js { files: [{ id: '${html.id}' }] }`;
			if (i.text !== undefined && i.text !== '')
				return err(`${o} is data, not lines: find it with ${run}.`);
			const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text);
			if (Option.isNone(json))
				return err(`The ingest ${o} is no longer readable: ingest the file again.`);
			return ok({
				output: o,
				file: entry.name,
				data: dataSummary(json.value),
				note: `its data: ${run}${images.size === 0 ? '' : `; its images: read_file { id: ${o}, image: n }`}`
			});
		}
		if (i.text !== undefined && i.text !== '') {
			const skip = Math.max(0, (i.offset ?? 1) - 1);
			const found = grep(text, i.text, Math.min(50, Math.max(1, i.limit ?? 50)), 'html', skip);
			return {
				result: {
					output: o,
					...found,
					...(skip + found.hits.length < found.total ? { next: skip + found.hits.length + 1 } : {}),
					...(found.total === 0
						? { note: `No line of ${o} holds '${i.text}'.` }
						: found.total > found.hits.length
							? { note: `${found.total - found.hits.length} more hits` }
							: {})
				},
				bounded: true as const
			};
		}
		const page = linePage(text, i.offset, i.limit);
		if ('error' in page) return err(`${page.error} in ${o}`);
		const w = page.window;
		const refs = imagesIn(w.lines, [...images.keys()]),
			shown = refs.slice(0, WINDOW_IMAGES);
		yield* show(shown);
		return textAnswer(
			[
				`Read ${entry.name} (${o}), lines ${w.from}-${w.to} of ${w.total}`,
				...w.lines,
				...(w.next === undefined
					? []
					: [`[Output truncated. Continue reading with offset: ${w.next}]`]),
				...(shown.length === 0
					? []
					: [
							`Shown on your next step only (extract all visible fields/values now before unrelated lookups): ${shown.join(', ')}${shown.length > TILED_PAGES ? '; whole pages without their quarters: read_file { id, image: n } adds them' : ''}`
						]),
				...(refs.length > shown.length
					? [`${refs.length - shown.length} more images: read_file { id: ${o}, image: n }`]
					: [])
			].join('\n')
		);
	});

	const ingestFile = Effect.fn('AgentTool.ingestFile')(function* (
		fileStore: NonNullable<Engine['files']>,
		file: typeof SourceFile.Type,
		how: Exclude<ReturnType<typeof route>, 'unsupported'>,
		password?: string,
		path?: string
	) {
		const port = x.ingest;
		const cacheKey =
			password === undefined && path === undefined
				? file.sha256
				: sha256_hex(
						[file.sha256, password ?? '', ...(path === undefined ? [] : [path])].join('\0')
					);
		const name = path === undefined ? file.name : `${file.name}/${path}`;
		const chain = new Chain();
		const entry = JSON.stringify({
				name: `${name} (${how === 'audio' ? 'transcript' : 'ingested'})`,
				mime: 'text/html'
			}),
			state = JSON.stringify({
				source: file.id,
				sha256: file.sha256,
				status: 'ingesting',
				...(path === undefined ? {} : { entry: path })
			});
		capturePiece(
			chain,
			'added',
			'sys_conversation',
			`UPDATE sys_conversation SET outputs = outputs || jsonb_build_array(${chain.p(entry)}::jsonb || jsonb_build_object('ingest',
			${chain.p(state)}::jsonb || jsonb_build_object('output', 'o' || (1 + (SELECT count(*) FROM jsonb_array_elements(outputs) e WHERE e ? 'ingest')))))
			WHERE id = ${chain.p(x.conv.id)}`,
			{ returning: (_before, after) => `${after}.outputs->-1->'ingest'->>'output' AS output` }
		);
		const { output } = yield* nativeCommit(
			x.engine.db.write,
			x.engine.live.publish,
			chain,
			Schema.Struct({ ...CapturedResult.fields, output: Schema.NullOr(Schema.String) }),
			'(SELECT output FROM added) AS output'
		);
		if (output === null)
			return yield* BoltError.make('invalid_input', 'admission', 'This conversation is gone.');
		const member = x.authority.actor.kind === 'member' ? x.authority.actor.id : null,
			base =
				(path?.split('/').pop() ?? file.name).replace(/\.[^./]*$/, '').replaceAll('/', '_') ||
				'file';
		const record = (event: string, attributes: { readonly [key: string]: Json }) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) =>
				x.logs.write({
					at: new Date(now).toISOString(),
					severity: 'info',
					event,
					invocation: x.turn,
					run: null,
					conversation: x.conv.id,
					turn: x.turn,
					attributes
				})
			);
		const leader = flight(x.engine.live, cacheKey);
		const work = Effect.gen(function* () {
			if (leader.wait !== undefined) yield* Deferred.await(leader.wait);
			const hit = yield* cached(x.engine.db, fileStore, cacheKey);
			let stored: Stash;
			if (hit !== undefined) {
				stored = hit;
				yield* record('ingest.convert', {
					sha256: file.sha256,
					mime: file.mime,
					kind: hit.kind,
					cached: true,
					bytes: file.size
				});
			} else {
				const got: Ingested | { readonly unsupported: string } =
					how === 'image'
						? imageIngest({
								name: file.name,
								mime: file.mime,
								bytes: yield* fileStore.get(file.key, INGEST_BYTES)
							})
						: how === 'text'
							? textIngest(yield* fileStore.get(file.key, INGEST_BYTES))
							: port !== undefined
								? yield* port(
										{
											sha256: file.sha256,
											name: file.name,
											mime: file.mime,
											key: file.key,
											size: file.size
										},
										{
											...(password === undefined ? {} : { password }),
											...(path === undefined ? {} : { entry: path })
										}
									)
								: { unsupported: 'This host cannot ingest files.' };
				if ('unsupported' in got)
					return yield* BoltError.make(
						'invalid_input',
						'decode',
						unparsed(file.name, file.mime, file.size)
					);
				const usage = got.meta.usage;
				if (usage !== undefined)
					yield* record('ai.call', {
						calls: usage.calls,
						model: usage.model,
						input: usage.input,
						output: usage.output,
						cost: usage.cost,
						facility: 'convert.ingest',
						settlement: usage.calls.length === 0 ? 'attention' : 'pending'
					});
				stored = yield* stash(
					x.engine.db,
					x.engine.live.publish,
					fileStore,
					{ sha256: cacheKey, base, member, now: x.bindings.now },
					got
				);
				yield* record('ingest.convert', {
					sha256: file.sha256,
					mime: file.mime,
					kind: got.kind,
					cached: false,
					...got.meta.stats
				});
			}
			const main = new TextDecoder().decode(
				stored.kind === 'data' || how === 'audio'
					? yield* fileStore.get(stored.main.key, stored.main.size)
					: new Uint8Array()
			);
			const title = `${name} (${stored.kind === 'data' ? 'data' : how === 'audio' ? 'transcript' : 'ingested'})`;
			yield* patchEntry(
				output,
				{
					id: stored.main.id,
					name: title,
					mime: stored.main.mime,
					size: stored.main.size,
					files: entryFiles(stored.files)
				},
				{
					status: 'ready',
					...(stored.kind === 'document' ? { lines: stored.index.lines } : {})
				}
			);
			const run = (f: StoredFile | undefined) =>
				f === undefined ? '' : `${f.name.split('/').pop()} ${f.id} — run_js { files: [{ id }] }`;
			if (stored.kind === 'data') {
				const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(main);
				return {
					title,
					lines: [
						`  ${Option.isNone(json) ? 'unreadable data' : dataLine(json.value)}`,
						`  Compute from it with run_js, never retype: ${run(stored.main)}`
					]
				};
			}
			const json = run(stored.files.find((f) => f.name.endsWith('/transcript.json')));
			return {
				title,
				lines: [
					`  ${summary(stored.index, how === 'audio' ? transcriptOf(main) : undefined)}`,
					`  Map: ${outlineMap(stored.index)}`,
					...(json === ''
						? []
						: [`  Typed JSON for run_js (compute from it, never retype): ${json}`])
				]
			};
		}).pipe(
			Effect.tapError((error) =>
				patchEntry(output, {}, { status: 'failed', error: error.message }).pipe(Effect.ignore)
			),
			Effect.ensuring(leader.done)
		);
		x.reading.add(readingKey(output));
		const job = yield* x.jobs.add(
			`reading ${name}`,
			Effect.ensuring(
				work,
				Effect.sync(() => x.reading.delete(readingKey(output)))
			),
			{
				detach: true,
				done: (id, result) => {
					const said = isObj(result) ? result : {};
					const title = typeof said['title'] === 'string' ? said['title'] : name;
					const lines = Array.isArray(said['lines'])
						? said['lines'].filter((l) => typeof l === 'string')
						: [];
					return [
						`[job ${id} done] ingest of ${name}: read_file { id: ${output} } "${title}"`,
						...lines
					].join('\n');
				}
			}
		);
		yield* patchEntry(output, {}, { job });
		return { job, output };
	});

	const readFile = Effect.fn('AgentTool.readFile')(function* (i: {
		readonly id: string;
		readonly offset?: number | undefined;
		readonly limit?: number | undefined;
		readonly text?: string | undefined;
		readonly image?: number | undefined;
		readonly page?: number | undefined;
		readonly crops?: readonly (readonly [number, number, number, number])[] | undefined;
		readonly password?: string | undefined;
		readonly path?: string | undefined;
	}) {
		if (i.id.includes('@')) return yield* readReference(x, i.id, i);
		const given = i.id,
			all = yield* ingests(),
			path = i.path?.replace(/^\/+|\/+$/g, '') || undefined;
		const id =
			path === undefined
				? given
				: (all.findLast((o) => o.ingest.output === given || o.id === given)?.ingest.source ??
					given);
		let found = all.findLast((o) =>
			path === undefined
				? o.ingest.output === id ||
					o.id === id ||
					(o.ingest.source === id && o.ingest.entry === undefined)
				: o.ingest.source === id && o.ingest.entry === path
		);
		if (found?.ingest.status === 'ingesting' && !x.reading.has(readingKey(found.ingest.output))) {
			yield* patchEntry(
				found.ingest.output,
				{},
				{ status: 'failed', error: 'a restart cut it short' }
			);
			found = undefined;
		}
		if (found !== undefined && (found.ingest.status !== 'failed' || found.ingest.output === id))
			return yield* readIngest(found, i);
		const [indexed] = yield* sourceFile(x, id);
		if (indexed?.mime === REFERENCE.mime) return yield* readReference(x, indexed.name, i);
		const attachments = x.attachments;
		if (attachments === undefined) return err('This host reads no files.');
		const [attached] = yield* x.engine.db.read([
			{
				text: `SELECT i - 'message' AS file FROM sys_conversation c, jsonb_array_elements(c.inputs) i WHERE c.id = $1 AND i->>'id' = $2 LIMIT 1`,
				params: [x.conv.id, id]
			}
		]);
		const input = attached?.rows[0]?.['file'];
		if (input === undefined && !(yield* canRead(x, id))) {
			const [held] = yield* x.engine.db.read([
				{
					text: `SELECT i->>'id' AS id, i->>'name' AS name FROM sys_conversation c, jsonb_array_elements(c.inputs) i WHERE c.id = $1`,
					params: [x.conv.id]
				}
			]);
			const files = (held?.rows ?? [])
				.slice(-20)
				.map((row) => `${String(row['name'])} ${String(row['id'])}`);
			return err(
				`No file you can read has this id; a clipped result is read_output's.${files.length === 0 ? '' : ` This conversation's files: ${files.join(', ')}`}`
			);
		}
		const file = indexed;
		if (file === undefined) return yield* readStored(attachments, input ?? { id });
		if (path !== undefined && !isArchive(file.mime, file.name))
			return err(`${file.name} is not an archive: path names a file inside a zip, tar or tar.gz.`);
		const typed = route(file.mime, file.name);
		const how =
			typed === 'unsupported' &&
			!/^(audio|video|image)\//.test(file.mime) &&
			file.size <= TEXT_SNIFF_BYTES &&
			e.files !== undefined &&
			isUtf8Text(yield* e.files.get(file.key, file.size))
				? 'text'
				: typed;
		if (how === 'unsupported') return err(unparsed(file.name, file.mime, file.size));
		const detail =
			path !== undefined ||
			typed === 'unsupported' ||
			i.offset !== undefined ||
			i.limit !== undefined ||
			i.text !== undefined ||
			i.image !== undefined ||
			i.page !== undefined ||
			i.crops !== undefined;
		if (how !== 'convert' && how !== 'audio' && !detail)
			return yield* readStored(attachments, input ?? { id });
		if (e.files === undefined) return err('This host cannot parse files.');
		if ((how === 'convert' || how === 'audio') && x.ingest === undefined)
			return err('This host cannot parse files.');
		const started = yield* ingestFile(e.files, file, how, i.password, path);
		const settled = yield* x.jobs.wait([started.job], x.inlineMs ?? JOBS.inlineMs);
		if (settled === null)
			return ok({
				reading: file.name,
				job: started.job,
				note: `Still being read. wait { jobs: ['${started.job}'] } returns when it ends.`
			});
		const failed = jobFailed(settled.result);
		if (failed !== undefined) return err(failed);
		const ready = (yield* ingests()).findLast((o) => o.ingest.output === started.output);
		if (ready === undefined) return err('This conversation is gone.');
		const answer = yield* readIngest(ready, i),
			said = Schema.decodeUnknownOption(Schema.Array(Schema.Json))(
				Predicate.isObject(settled.result) ? settled.result['lines'] : undefined
			);
		if (!('result' in answer) || Option.isNone(said)) return answer;
		const about = said.value.filter((line) => typeof line === 'string').map((line) => line.trim());
		const whole = ('full' in answer ? answer.full : undefined) ?? answer.result;
		return typeof whole === 'string'
			? textAnswer([...about, whole].join('\n'))
			: Predicate.isObject(answer.result)
				? { ...answer, result: { ...answer.result, about: said.value } }
				: answer;
	});

	add(readFileTool, function* (i) {
		return yield* readFile(i);
	});
	add(readOutputTool, function* (i) {
		return yield* readOutput(i.call, i.offset ?? 0);
	});

	const convert = e.convert,
		store = e.files;
	if (agent && convert !== undefined && store !== undefined && convert.targets.length > 0) {
		add(documentTool, function* (i) {
			if (!convert.targets.includes(i.to))
				return err(`This host converts to ${convert.targets.join(', ')}; choose one of those targets.`);
			if (i.markdown.trim() === '') return err('Write the document out in markdown.');
			const bytes = yield* convert.convert({ markdown: i.markdown }, i.to, {
				...(i.page === undefined ? {} : { page: i.page }),
				...(i.landscape === undefined ? {} : { landscape: i.landscape })
			});
			return ok({
				files: [yield* storeFile(x, store, { name: i.name, mime: CONVERT_MIME[i.to], bytes })]
			});
		});
	}
	if (
		agent &&
		x.inApp &&
		staff &&
		store !== undefined &&
		!x.host_tools.some((tool) => tool.behavior.downloads === true)
	) {
		add(downloadTool, function* (i) {
			const held = hold(downloadTool.name, i, 'download from the web');
			if (held !== undefined) return held;
			const file = yield* store.download(i.url);
			return ok({
				saved: file.name,
				mime: file.mime,
				bytes: file.bytes,
				file: yield* recordFile(x, file)
			});
		});
	}
}
