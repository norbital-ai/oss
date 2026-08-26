import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * What a workspace's indexed assets are served as.
 *
 * The bytes moved out of the artifact and into digest-named sidecar blobs, which are extensionless
 * by construction — `assets/3f2a…` says nothing about what it holds. The content type recorded here,
 * at index time, from the *source* filename, is therefore the only surviving statement of what a
 * blob is, and a host has nothing else to answer with.
 *
 * Read off the source rather than imported, because `WorkspaceCompiler` pulls in the whole compiler
 * — Vite, the artifact renderer, the schema planner — to answer a question about a filename. The
 * mapping is a table of string suffixes; asserting on the table is the same assertion at a fraction
 * of the cost, and it cannot drift, because there is only one table.
 *
 * The case that matters is `.wasm`. `WebAssembly.instantiateStreaming` checks the media type and
 * refuses anything that is not `application/wasm` — it will not fall back to sniffing the magic
 * bytes. PGlite ships its engine as `.wasm` inside the bundle, so an unlisted suffix served it as
 * `application/octet-stream` and the client replica failed with `Response has unsupported MIME
 * type`, from a file that downloaded perfectly. Nothing in that failure points at a lookup table.
 *
 * The general rule this pins: a suffix the table does not know is served as an opaque download.
 * That is the right default — guessing a type for unknown bytes is how a text/html response gets
 * executed — but it means every type the product actually ships has to be named here, and the cost
 * of forgetting one is a runtime error nowhere near this file.
 */
const source = readFileSync(new URL('../../src/compiler/sync.ts', import.meta.url), 'utf8');

const table = (() => {
	const start = source.indexOf('static readonly contentType');
	const end = source.indexOf('};', start);
	return source.slice(start, end);
})();

const servedAs = (suffix: string): string | undefined => {
	// Each arm is `if (path.endsWith('.x')) return '<type>';`, and a suffix may share an arm with
	// another (`.jpg`/`.jpeg`), so the match runs from the suffix to the `return` that follows it.
	const at = table.indexOf(`endsWith('${suffix}')`);
	if (at === -1) return undefined;
	return /return '([^']+)'/.exec(table.slice(at))?.[1];
};

describe('static asset media types', () => {
	it('serves WebAssembly as application/wasm, which the browser will not infer', () => {
		expect(servedAs('.wasm')).toBe('application/wasm');
	});

	it('names every media type a workspace bundle actually ships', () => {
		expect(servedAs('.html')).toBe('text/html; charset=utf-8');
		expect(servedAs('.js')).toBe('text/javascript; charset=utf-8');
		expect(servedAs('.css')).toBe('text/css; charset=utf-8');
		expect(servedAs('.json')).toBe('application/json; charset=utf-8');
		expect(servedAs('.svg')).toBe('image/svg+xml');
		expect(servedAs('.webp')).toBe('image/webp');
		expect(servedAs('.png')).toBe('image/png');
		expect(servedAs('.jpg')).toBe('image/jpeg');
		expect(servedAs('.gif')).toBe('image/gif');
		expect(servedAs('.woff2')).toBe('font/woff2');
	});

	it('keeps an unknown suffix an opaque download rather than guessing', () => {
		// The fallback is the last `return` in the block, and it must stay `application/octet-stream`:
		// a guessed type for unknown bytes is how an upload gets served as something executable.
		expect(table.trimEnd().endsWith("return 'application/octet-stream';")).toBe(true);
		expect(servedAs('.exe')).toBeUndefined();
	});
});
