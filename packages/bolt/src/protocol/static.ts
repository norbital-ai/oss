// A workspace's pages as every host serves them (`bolt dev`, bolt-server, a hosting platform): the artifact's client build, its own
// `assets/**` at `/assets/*`, then the document under the workspace's frame policy. A host adds only its own wrapping
// (a base path, a bundle digest) and the response.
import { Effect, FileSystem, Path, Result } from 'effect';
import { framePolicy, type ShellManifest } from '../shell/nav.ts';
import { BOLT } from './wire.ts';

/** The content type of each file kind a client build and a workspace's assets carry; anything else is `application/octet-stream`. */
export const MIME: { readonly [ext: string]: string } = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.map': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.avif': 'image/avif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.onnx': 'application/octet-stream',
	'.mp3': 'audio/mpeg',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json'
};

/** What a host answers at a path of a workspace's pages: the file to send and its headers. */
export type ClientPage = {
	readonly file: string;
	readonly document: boolean;
	readonly headers: { readonly [name: string]: string };
};

/**
 * The file at the request `path` under `root`, never outside it: the joined path is normalized, so a `..` that leaves
 * `root` shows in its prefix. A path that does not decode, or holds a backslash, a NUL or a trailing `/`, names none.
 */
const under = Effect.fn('Protocol.clientPath')(function* (root: string, path: string) {
	const rel = Result.getOrUndefined(Result.try(() => decodeURIComponent(path)));
	const { join } = yield* Path.Path;
	const file =
		rel === undefined || /[\\\0]/.test(rel) || rel.endsWith('/') ? undefined : join(root, rel);
	if (file === undefined || !file.startsWith(`${root}/`)) return undefined;
	const fs = yield* FileSystem.FileSystem;
	return (yield* fs.exists(file)) && (yield* fs.stat(file)).type === 'File' ? file : undefined;
});

/**
 * `path` of the pages of the artifact at `dir`: a file of its client build, else (under `/assets/`) of its workspace
 * assets, else the document; `undefined` when the artifact carries no client pages. `/assets/*` is cached for good;
 * everything else, the document first, revalidates.
 */
export const clientPage = Effect.fn('Protocol.clientPage')(function* (
	dir: string,
	path: string,
	manifest: ShellManifest
) {
	if (path === BOLT || path.startsWith(`${BOLT}/`)) return undefined;
	const fs = yield* FileSystem.FileSystem;
	const { extname, join } = yield* Path.Path;
	const client = join(dir, 'client'),
		index = join(client, 'index.html');
	const assets = path.startsWith('/assets/');
	const file =
		(yield* under(client, path)) ??
		(assets ? yield* under(join(dir, 'assets'), path.slice('/assets'.length)) : undefined);
	if (file !== undefined && file !== index) {
		const page: ClientPage = {
			file,
			document: false,
			headers: {
				'content-type': MIME[extname(file)] ?? 'application/octet-stream',
				'cache-control': assets ? 'public, max-age=31536000, immutable' : 'no-cache'
			}
		};
		return page;
	}
	if (yield* fs.exists(index)) {
		const page: ClientPage = {
			file: index,
			document: true,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-cache',
				'content-security-policy': framePolicy(manifest, path)
			}
		};
		return page;
	}
	return undefined;
});
