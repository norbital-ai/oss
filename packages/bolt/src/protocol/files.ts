// `PUT /__bolt/files/<collection>.<field>` (an upload) and `GET /__bolt/files/<id>` (a download, §5.7) as one fetch-style
// handler over the engine's files port; any host mounts it before `boltHandler` (P18). Sessions are the host's.
import { LIMITS, type Authority, type Bindings } from '../engine/contracts.ts';
import { chargesFor, RateWindows } from '../engine/access/rate.ts';
import { upload } from '../engine/callables/upload.ts';
import { readableFile } from '../engine/decisions/index.ts';
import type { Engine } from '../engine/index.ts';
import { HEADERS, PATHS, statusOf } from './wire.ts';

export type FilesHttp = {
	engine: Pick<Engine, 'manifest' | 'db' | 'read' | 'files'>;
	/** The caller's compiled authority, or `null` (401). */
	session(request: Request): Promise<Authority | null>;
	bindings(): Bindings;
};

const err = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });

export function filesHandler(h: FilesHttp): (request: Request) => Promise<Response | null> {
	const windows = new RateWindows();
	return async (request) => {
		const path = new URL(request.url).pathname;
		if (!path.startsWith(PATHS.files)) return null;
		const auth = await h.session(request);
		if (auth === null) return err('unauthenticated', 'Sign in first.', 401);
		const { manifest, db, files } = h.engine, b = h.bindings(), rest = decodeURIComponent(path.slice(PATHS.files.length));
		if (files === undefined) return err('unavailable', 'This host stores no files.', 503);
		if (request.method === 'PUT') {
			const [collection, field] = rest.split('.') as [string, string | undefined];
			if (field === undefined) return err('invalid', 'upload to <collection>.<field>', 400);
			const cs = chargesFor(auth, ['upload'], auth.actor.kind === 'member' ? { actor: auth.actor.id } : {});
			const nowMs = Date.parse(b.now);
			if (!windows.charge(cs, nowMs).ok) return err('rateLimited', 'Too many uploads; try again later.', 429);
			const disposition = /filename\*=UTF-8''([^;]+)/i.exec(request.headers.get('content-disposition') ?? '')?.[1];
			const outcome = await upload({ manifest, db, files }, { id: request.headers.get(HEADERS.key) ?? '', collection, field,
				name: disposition === undefined ? 'file' : decodeURIComponent(disposition), mime: request.headers.get('content-type') ?? 'application/octet-stream',
				bytes: new Uint8Array(await request.arrayBuffer()), authority: auth, now: b.now,
				rate: cs.map((x) => ({ rule: x.rule, bucket: x.bucket, limit: x.limit, windowStart: new Date(nowMs - (nowMs % x.windowMs)).toISOString() })) });
			return outcome.kind === 'committed' ? Response.json(outcome.output)
				: err(outcome.kind === 'refused' ? outcome.code : outcome.kind, outcome.kind === 'refused' ? outcome.message : outcome.kind, statusOf(outcome));
		}
		if (request.method !== 'GET') return err('invalid', 'files take PUT or GET', 405);
		const [r] = await db.read([{ text: `SELECT key, mime, name, field FROM sys_file WHERE id = $1`, params: [rest] }]);
		const row = r!.rows[0];
		// the caller reads a row holding this file (masks and row predicates included), or the message carrying it
		if (row === undefined || !await readableFile({ manifest, db, read: h.engine.read, authority: auth, bindings: b }, rest, String(row['field'])))
			return err('notFound', 'Not found or no access.', 404);
		const bytes = await files.get(String(row['key']), LIMITS.storedFileBytes, AbortSignal.timeout(LIMITS.callMs.other));
		return new Response(new Uint8Array(bytes), { headers: { 'content-type': String(row['mime']), 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(String(row['name']))}`,
			'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
	};
}
