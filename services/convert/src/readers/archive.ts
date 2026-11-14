// Archives (zip, tar, tar.gz) read from the disk, never whole into memory and never unpacked as a tree. A zip's listing
// is its central directory, read by range; an entry is one ranged read inflated as a stream into one file. A tar is a
// stream of headers: a listing skips every body, an entry streams through to its own and writes only that. An entry that
// is itself an archive opens by a longer path. Every byte inflated is counted against the bounds, whatever the archive
// declares.
// ponytail: zip64 and encrypted zips are refused; a tar.gz cannot seek, so each first read of one of its entries streams
// the archive from its start (each entry is read once: the host keeps what it parsed).
import { closeSync, createReadStream, createWriteStream, openSync, writeSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflateRaw } from 'node:zlib';

const MiB = 1024 * 1024;
/**
 * The files one archive may list, one entry's inflated size, a tar's whole inflated size, the inflation a zip entry may
 * declare (a bomb's is thousands to one), and how deep archives nest.
 */
export const ARCHIVE = { entries: 50_000, entryBytes: 256 * MiB, bytes: 2048 * MiB, ratio: 1000, depth: 4 } as const;

export type Listed = { readonly path: string; readonly size: number };
export class ArchiveError extends Error {}

const utf8 = new TextDecoder();
const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;
/** `length` bytes at `position` of the file. */
const range = async (file: string, position: number, length: number) => {
	const handle = await open(file, 'r');
	try {
		const bytes = new Uint8Array(length);
		const { bytesRead } = await handle.read(bytes, 0, length, position);
		return bytes.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
};
/** A stream that passes at most `max` bytes, failing past them. */
const capped = (max: number, what: string) => {
	let seen = 0;
	return new Transform({
		transform(chunk: Buffer, _, done) {
			seen += chunk.length;
			done(seen > max ? new ArchiveError(`${what} unpacks past ${max.toLocaleString('en-US')} bytes`) : null, chunk);
		}
	});
};

type ZipEntry = Listed & { readonly method: number; readonly packed: number; readonly local: number; readonly flags: number };
/** A zip's files from its central directory: the end record and the directory, two ranged reads. */
const zipDirectory = async (file: string): Promise<ZipEntry[]> => {
	const handle = await open(file, 'r');
	const length = (await handle.stat()).size;
	await handle.close();
	const tailLength = Math.min(length, 65_557),
		tail = await range(file, length - tailLength, tailLength);
	let end = -1;
	for (let at = tail.length - 22; at >= 0; at--)
		if (u32(tail, at) === 0x06054b50) {
			end = at;
			break;
		}
	if (end === -1) throw new ArchiveError('the zip has no central directory');
	const count = u16(tail, end + 10),
		size = u32(tail, end + 12),
		offset = u32(tail, end + 16);
	if (count === 0xffff || offset === 0xffffffff) throw new ArchiveError('a zip64 archive is not supported');
	if (count > ARCHIVE.entries) throw new ArchiveError(`the archive has over ${ARCHIVE.entries} files`);
	const b = await range(file, offset, size);
	const entries: ZipEntry[] = [];
	for (let at = 0, n = 0; n < count; n++) {
		if (u32(b, at) !== 0x02014b50) throw new ArchiveError('the zip directory is damaged');
		const nameLength = u16(b, at + 28),
			path = utf8.decode(b.subarray(at + 46, at + 46 + nameLength));
		const entry = {
			path,
			flags: u16(b, at + 8),
			method: u16(b, at + 10),
			packed: u32(b, at + 20),
			size: u32(b, at + 24),
			local: u32(b, at + 42)
		};
		at += 46 + nameLength + u16(b, at + 30) + u16(b, at + 32);
		if (!path.endsWith('/')) entries.push(entry);
	}
	return entries;
};
/** One zip entry inflated as a stream into `to`: its local header by range, then its data, counted as it flows. */
const zipExtract = async (file: string, entry: ZipEntry, to: string) => {
	if ((entry.flags & 1) === 1) throw new ArchiveError(`${entry.path} is encrypted`);
	if (entry.method !== 0 && entry.method !== 8)
		throw new ArchiveError(`${entry.path} uses compression method ${entry.method}`);
	if (entry.size > ARCHIVE.entryBytes) throw new ArchiveError(`${entry.path} is over ${ARCHIVE.entryBytes / MiB} MiB unpacked`);
	if (entry.method === 8 && entry.size > Math.max(entry.packed, 1) * ARCHIVE.ratio)
		throw new ArchiveError(`${entry.path} inflates over ${ARCHIVE.ratio} times: refused as a zip bomb`);
	const local = await range(file, entry.local, 30);
	if (u32(local, 0) !== 0x04034b50) throw new ArchiveError(`${entry.path} is damaged`);
	const start = entry.local + 30 + u16(local, 26) + u16(local, 28);
	if (entry.packed === 0) return writeFile(to, '');
	const source = createReadStream(file, { start, end: start + entry.packed - 1 }),
		limit = capped(Math.min(entry.size, ARCHIVE.entryBytes), entry.path),
		out = createWriteStream(to);
	await (entry.method === 8 ? pipeline(source, createInflateRaw(), limit, out) : pipeline(source, limit, out)).catch(
		(cause: unknown) => {
			throw cause instanceof ArchiveError ? cause : new ArchiveError(`${entry.path} is damaged`);
		}
	);
};

const field = (b: Uint8Array, at: number, length: number) => {
	const raw = b.subarray(at, at + length),
		nul = raw.indexOf(0);
	return utf8.decode(nul === -1 ? raw : raw.subarray(0, nul));
};
const paxPath = (body: Uint8Array) => /(?:^|\n)\d+ path=([^\n]*)\n/.exec(utf8.decode(body))?.[1];
/** What takes an entry's body a chunk at a time. */
type Sink = { readonly write: (chunk: Buffer) => void; readonly end: () => void };
/**
 * A tar's regular files as a stream of headers: `visit` sees each one's path and size and answers a sink for its body,
 * or undefined to skip it (a body skipped is never held). Pax and GNU long names apply; only their own small bodies are kept.
 */
const tarWalk = (visit: (entry: Listed) => Sink | undefined) => {
	let pending: Buffer = Buffer.alloc(0),
		long: string | undefined,
		header: { path: string; size: number; type: string } | undefined,
		left = 0,
		pad = 0,
		meta: Buffer[] = [],
		sink: Sink | undefined,
		ended = false,
		files = 0;
	return new Writable({
		write(chunk: Buffer, _, done) {
			if (ended) return done();
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			const step = () => {
				for (;;) {
					if (header !== undefined) {
						if (left > 0) {
							if (pending.length === 0) return;
							const part = pending.subarray(0, left);
							pending = pending.subarray(part.length);
							left -= part.length;
							if (header.type === 'x' || header.type === 'L') meta.push(part);
							else sink?.write(part);
							continue;
						}
						if (pending.length < pad) return;
						pending = pending.subarray(pad);
						if (header.type === 'x' || header.type === 'L') {
							const body = Buffer.concat(meta);
							long = header.type === 'x' ? (paxPath(body) ?? long) : field(body, 0, body.length);
						} else if (sink !== undefined) {
							sink.end();
							ended = true;
							return;
						}
						header = undefined;
						meta = [];
						continue;
					}
					if (pending.length < 512) return;
					const block = pending.subarray(0, 512);
					pending = pending.subarray(512);
					if (block.every((byte) => byte === 0)) {
						ended = true;
						return;
					}
					const size = parseInt(field(block, 124, 12).trim() || '0', 8),
						type = String.fromCharCode(block[156] ?? 0);
					if (!Number.isSafeInteger(size)) throw new ArchiveError('the tar is damaged');
					if ((type === 'x' || type === 'L') && size > MiB) throw new ArchiveError('the tar is damaged');
					const prefix = field(block, 345, 155),
						path = (type === 'x' || type === 'L' ? '' : (long ?? (prefix === '' ? '' : `${prefix}/`) + field(block, 0, 100))).replace(/^\.\//, '');
					if (type !== 'x' && type !== 'L') long = undefined;
					header = { path, size, type };
					left = size;
					pad = (512 - (size % 512)) % 512;
					sink = undefined;
					if ((type === '0' || type === '\0') && path !== '' && !path.endsWith('/')) {
						if (++files > ARCHIVE.entries) throw new ArchiveError(`the archive has over ${ARCHIVE.entries} files`);
						sink = visit({ path, size });
					}
				}
			};
			try {
				step();
				done();
			} catch (cause) {
				done(cause instanceof Error ? cause : new ArchiveError('the tar is damaged'));
			}
		}
	});
};
/** The tar (inflated first for tgz) streamed into `walk`, every byte counted against `ARCHIVE.bytes`. */
const tarPipe = (file: string, format: string, walk: Writable) =>
	(format === 'tgz'
		? pipeline(createReadStream(file), createGunzip(), capped(ARCHIVE.bytes, 'the archive'), walk)
		: pipeline(createReadStream(file), capped(ARCHIVE.bytes, 'the archive'), walk)
	).catch(fail('the tar'));
const tarList = async (file: string, format: string) => {
	const listed: Listed[] = [];
	await tarPipe(file, format, tarWalk((entry) => void listed.push(entry)));
	return listed;
};
const fail = (what: string) => (cause: unknown) => {
	throw cause instanceof ArchiveError ? cause : new ArchiveError(`${what} is damaged`);
};

/** An archive's files, by its format (`zip`, `tar` or `tgz`), at most `ARCHIVE.entries`: no entry's bytes are read. */
export const list = (file: string, format: string): Promise<Listed[]> =>
	format === 'zip' ? zipDirectory(file) : tarList(file, format);
/** The archive format a name has, or undefined. */
export const archiveFormat = (name: string): string | undefined => {
	const ext = /\.(zip|tar|tgz|gz)$/i.exec(name)?.[1]?.toLowerCase();
	return ext === 'gz' ? 'tgz' : ext;
};
/** Entry `path` of the archive at `file`, streamed into `to`; false when it has no such file. */
const extract = async (file: string, format: string, path: string, to: string): Promise<boolean> => {
	if (format === 'zip') {
		const entry = (await zipDirectory(file)).find((one) => one.path === path);
		if (entry === undefined) return false;
		await zipExtract(file, entry, to);
		return true;
	}
	let found = false;
	const fd = openSync(to, 'w');
	try {
		await tarPipe(
			file,
			format,
			tarWalk((entry) => {
				if (found || entry.path !== path) return undefined;
				if (entry.size > ARCHIVE.entryBytes) throw new ArchiveError(`${path} is over ${ARCHIVE.entryBytes / MiB} MiB unpacked`);
				found = true;
				return { write: (chunk) => void writeSync(fd, chunk), end: () => {} };
			})
		);
	} finally {
		closeSync(fd);
	}
	return found;
};

/**
 * What `path` names in the archive at `file`: a file (its name, streamed into a file of `scratch`), or a folder (the files
 * under it, listed). A path that runs on past an archive inside this one continues in it.
 */
export async function find(
	file: string,
	format: string,
	path: string,
	scratch: (name: string) => Promise<string>,
	depth = 0
): Promise<{ file: { name: string; path: string } } | { folder: Listed[] }> {
	const wanted = path.replace(/^\/+|\/+$/g, '');
	const all = await list(file, format);
	const name = (entry: string) => entry.split('/').pop() ?? entry;
	const exact = all.find((entry) => entry.path === wanted);
	if (exact !== undefined) {
		const to = await scratch(name(exact.path));
		await extract(file, format, exact.path, to);
		return { file: { name: name(exact.path), path: to } };
	}
	const inner = all.find((entry) => archiveFormat(entry.path) !== undefined && wanted.startsWith(`${entry.path}/`));
	if (inner !== undefined) {
		if (depth >= ARCHIVE.depth) throw new ArchiveError(`archives nest over ${ARCHIVE.depth} deep`);
		const to = await scratch(name(inner.path));
		await extract(file, format, inner.path, to);
		return find(to, archiveFormat(inner.path) ?? '', wanted.slice(inner.path.length + 1), scratch, depth + 1);
	}
	const under = all.filter((entry) => entry.path.startsWith(`${wanted}/`));
	if (wanted === '' || under.length > 0) return { folder: wanted === '' ? all : under };
	throw new ArchiveError(`the archive has no '${wanted}'`);
}
