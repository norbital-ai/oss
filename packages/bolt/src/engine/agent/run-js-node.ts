// A file run's virtual Node (compute model §3, "Running a file"): guest source appended to the bundle, so the bundle's
// source map keeps its lines. It defines `globalThis[Symbol.for('norbital.node')]` — `builtin(name)` for the bundle's
// built-in imports, `run(input, load)` for its entry — and the globals a Node script expects: `Buffer`, `process` (an
// empty `env`), `global` and a `require` of the built-ins. `fs` works over the mounts the run is handed by one crossing
// (`mounts`): the tree read-only at /app (the working directory), the named conversation files read-only at /in;
// /out is write-only and crosses back once (`out`) when the program ends. `fetch` (only for a run granted HTTP) is the
// `fetch` crossing. No clock, sockets or other programs: the guest prelude's globals are all there is.
// Kept as `String.raw` with no backtick and no `${`.
export const NODE_SHIM = String.raw`
;(() => {
'use strict';
const G = globalThis, call = G[Symbol.for('norbital.bolt.call')];
const OUT_BYTES = 64 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(code + ': ' + message), { code });

// ── path: posix, relative to /app ──
const cwd = '/app';
const normalize = (p) => {
	const absolute = p.startsWith('/'), parts = [];
	for (const s of p.split('/')) {
		if (s === '' || s === '.') continue;
		if (s === '..') { if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop(); else if (!absolute) parts.push('..'); }
		else parts.push(s);
	}
	return (absolute ? '/' : '') + parts.join('/') || (absolute ? '/' : '.');
};
const path = {
	sep: '/', delimiter: ':', normalize, isAbsolute: (p) => String(p).startsWith('/'),
	join: (...a) => normalize(a.filter((s) => s !== '').join('/')),
	resolve: (...a) => { let r = ''; for (let i = a.length - 1; i >= 0 && !r.startsWith('/'); i--) if (a[i]) r = a[i] + (r ? '/' + r : ''); return normalize(r.startsWith('/') ? r : cwd + '/' + r); },
	relative: (from, to) => { const f = path.resolve(from).split('/').filter(Boolean), t = path.resolve(to).split('/').filter(Boolean); let i = 0; while (i < f.length && f[i] === t[i]) i++; return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/'); },
	dirname: (p) => { const n = normalize(String(p)), i = n.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : n.slice(0, i); },
	basename: (p, ext) => { const b = normalize(String(p)).split('/').pop() || ''; return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b; },
	extname: (p) => { const b = path.basename(p), i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
	parse: (p) => { const base = path.basename(p), ext = path.extname(p); return { root: String(p).startsWith('/') ? '/' : '', dir: path.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; },
	format: (o) => (o.dir ? o.dir + '/' : o.root || '') + (o.base || (o.name || '') + (o.ext || ''))
};
path.posix = path;

// ── Buffer: a Uint8Array with Node's encodings and readers ──
const ENCODINGS = ['utf8', 'utf-8', 'hex', 'base64', 'base64url', 'latin1', 'binary', 'ascii', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le'];
const encodingOf = (e) => { const n = String(e || 'utf8').toLowerCase(); if (!ENCODINGS.includes(n)) throw new TypeError('Unknown encoding: ' + e); return n === 'utf-8' ? 'utf8' : n === 'binary' ? 'latin1' : n === 'ucs-2' || n === 'utf16le' || n === 'utf-16le' ? 'ucs2' : n; };
const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; };
const encode = (s, e) => {
	switch (encodingOf(e)) {
		case 'utf8': return new TextEncoder().encode(s);
		case 'hex': { const out = new Uint8Array(s.length >> 1); for (let i = 0; i < out.length; i++) { const b = parseInt(s.substr(i * 2, 2), 16); if (Number.isNaN(b)) return out.subarray(0, i); out[i] = b; } return out; }
		case 'base64': case 'base64url': { const t = s.replace(/[^A-Za-z0-9+/\-_]/g, '').replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '==='.slice((t.length + 3) % 4)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
		case 'ucs2': { const out = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i * 2] = c & 255; out[i * 2 + 1] = c >> 8; } return out; }
		default: { const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255; return out; }
	}
};
const decode = (b, e) => {
	switch (encodingOf(e)) {
		case 'utf8': return new TextDecoder().decode(b);
		case 'hex': return Array.from(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
		case 'base64': return btoa(latin1(b));
		case 'base64url': return btoa(latin1(b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		case 'ascii': return latin1(b.map((x) => x & 127));
		case 'ucs2': { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s; }
		default: return latin1(b);
	}
};
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
class Buffer extends Uint8Array {
	static from(value, encodingOrOffset, length) {
		if (typeof value === 'string') return Buffer.wrap(encode(value, encodingOrOffset));
		if (value instanceof ArrayBuffer) return new Buffer(value, encodingOrOffset || 0, length === undefined ? value.byteLength - (encodingOrOffset || 0) : length);
		if (ArrayBuffer.isView(value)) return Buffer.wrap(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
		if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.wrap(Uint8Array.from(value.data));
		if (value && typeof value.length === 'number') return Buffer.wrap(Uint8Array.from(value, (x) => x & 255));
		throw new TypeError('Buffer.from takes a string, an array, an ArrayBuffer or a view');
	}
	static wrap(bytes) { return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
	static alloc(size, fill, encoding) { const b = new Buffer(size); if (fill !== undefined) b.fill(fill, 0, size, encoding); return b; }
	static allocUnsafe(size) { return new Buffer(size); }
	static allocUnsafeSlow(size) { return new Buffer(size); }
	static isBuffer(b) { return b instanceof Buffer; }
	static isEncoding(e) { return ENCODINGS.includes(String(e).toLowerCase()); }
	static byteLength(s, e) { return typeof s === 'string' ? encode(s, e).length : s.byteLength; }
	static concat(list, total) {
		const size = total === undefined ? list.reduce((n, b) => n + b.length, 0) : total, out = Buffer.alloc(size);
		let at = 0;
		for (const b of list) { if (at >= size) break; out.set(b.subarray(0, size - at), at); at += b.length; }
		return out;
	}
	static compare(a, b) { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return a.length === b.length ? 0 : a.length < b.length ? -1 : 1; }
	toString(encoding, start = 0, end = this.length) { return decode(this.subarray(start, end), encoding); }
	toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
	equals(other) { return Buffer.compare(this, other) === 0; }
	compare(other) { return Buffer.compare(this, other); }
	slice(start, end) { return this.subarray(start, end); }
	fill(value, offset = 0, end = this.length, encoding) {
		if (typeof value === 'string') { const bytes = value.length === 1 && encoding === undefined ? [value.charCodeAt(0) & 255] : encode(value, encoding); for (let i = offset; i < end; i++) this[i] = bytes[(i - offset) % bytes.length]; return this; }
		return super.fill(value, offset, end);
	}
	write(string, offset = 0, length = this.length - offset, encoding) {
		if (typeof offset === 'string') { encoding = offset; offset = 0; length = this.length; }
		const bytes = encode(string, encoding).subarray(0, Math.min(length, this.length - offset));
		this.set(bytes, offset);
		return bytes.length;
	}
	copy(target, targetStart = 0, start = 0, end = this.length) { const part = this.subarray(start, Math.min(end, start + target.length - targetStart)); target.set(part, targetStart); return part.length; }
	indexOf(value, from = 0, encoding) { if (typeof value === 'number') return super.indexOf(value & 255, from); const needle = typeof value === 'string' ? encode(value, encoding) : value; outer: for (let i = from; i <= this.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer; return i; } return -1; }
	includes(value, from, encoding) { return this.indexOf(value, from, encoding) !== -1; }
	readUInt8(o = 0) { return view(this).getUint8(o); }
	readInt8(o = 0) { return view(this).getInt8(o); }
	readUInt16LE(o = 0) { return view(this).getUint16(o, true); }
	readUInt16BE(o = 0) { return view(this).getUint16(o, false); }
	readInt16LE(o = 0) { return view(this).getInt16(o, true); }
	readInt16BE(o = 0) { return view(this).getInt16(o, false); }
	readUInt32LE(o = 0) { return view(this).getUint32(o, true); }
	readUInt32BE(o = 0) { return view(this).getUint32(o, false); }
	readInt32LE(o = 0) { return view(this).getInt32(o, true); }
	readInt32BE(o = 0) { return view(this).getInt32(o, false); }
	readFloatLE(o = 0) { return view(this).getFloat32(o, true); }
	readFloatBE(o = 0) { return view(this).getFloat32(o, false); }
	readDoubleLE(o = 0) { return view(this).getFloat64(o, true); }
	readDoubleBE(o = 0) { return view(this).getFloat64(o, false); }
	readBigUInt64LE(o = 0) { return view(this).getBigUint64(o, true); }
	readBigUInt64BE(o = 0) { return view(this).getBigUint64(o, false); }
	writeUInt8(v, o = 0) { view(this).setUint8(o, v); return o + 1; }
	writeInt8(v, o = 0) { view(this).setInt8(o, v); return o + 1; }
	writeUInt16LE(v, o = 0) { view(this).setUint16(o, v, true); return o + 2; }
	writeUInt16BE(v, o = 0) { view(this).setUint16(o, v, false); return o + 2; }
	writeInt16LE(v, o = 0) { view(this).setInt16(o, v, true); return o + 2; }
	writeInt16BE(v, o = 0) { view(this).setInt16(o, v, false); return o + 2; }
	writeUInt32LE(v, o = 0) { view(this).setUint32(o, v, true); return o + 4; }
	writeUInt32BE(v, o = 0) { view(this).setUint32(o, v, false); return o + 4; }
	writeInt32LE(v, o = 0) { view(this).setInt32(o, v, true); return o + 4; }
	writeInt32BE(v, o = 0) { view(this).setInt32(o, v, false); return o + 4; }
	writeFloatLE(v, o = 0) { view(this).setFloat32(o, v, true); return o + 4; }
	writeDoubleLE(v, o = 0) { view(this).setFloat64(o, v, true); return o + 8; }
}
for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
	const lower = name.replace('UInt', 'Uint');
	if (lower !== name) Buffer.prototype[lower] = Buffer.prototype[name];
}
const bytesOf = (data, encoding) => typeof data === 'string' ? encode(data, encoding) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : encode(String(data), encoding);
const buffer = { Buffer, kMaxLength: 2 ** 31 - 1, constants: { MAX_LENGTH: 2 ** 31 - 1 } };

// ── fs over the mounts ──
const files = new Map(), out = new Map();
let written = 0;
const where = (p) => path.resolve(String(p && typeof p === 'object' && 'pathname' in p ? p.pathname : p));
const inOut = (p) => p === '/out' || p.startsWith('/out/');
const isDirectory = (p) => p === '/' || p === '/app' || p === '/in' || p === '/out' || [...files.keys(), ...out.keys()].some((k) => k.startsWith(p + '/'));
const options = (o) => typeof o === 'string' ? { encoding: o } : o || {};
const read = (p) => {
	const at = where(p);
	if (inOut(at)) throw failure('EACCES', "'" + p + "' is write-only: /out holds what the run returns");
	const bytes = files.get(at);
	if (bytes !== undefined) return bytes;
	if (isDirectory(at)) throw failure('EISDIR', "'" + p + "' is a directory");
	// /in holds only the conversation files the call names: say so where a run reads one it did not name
	throw failure('ENOENT', "no such file '" + p + "'" + (at.startsWith('/in/') ? '; /in holds only the conversation files named in files' : ''));
};
const write = (p, data, o, append) => {
	const at = where(p);
	if (!at.startsWith('/out/')) throw failure('EROFS', "'" + p + "' is read-only; write to /out");
	const bytes = bytesOf(data, options(o).encoding);
	if (written + bytes.length > OUT_BYTES) throw failure('EFBIG', 'outputs over ' + OUT_BYTES + ' bytes');
	written += bytes.length;
	const before = append ? out.get(at) : undefined;
	out.set(at, before === undefined ? bytes : Buffer.concat([before, bytes]));
};
const stats = (p) => {
	const at = where(p), bytes = files.get(at) ?? out.get(at), dir = bytes === undefined && isDirectory(at);
	if (bytes === undefined && !dir) throw failure('ENOENT', "no such file or directory '" + p + "'");
	const epoch = new Date(0);
	return { size: bytes === undefined ? 0 : bytes.length, mode: dir ? 0o40555 : 0o100444, mtime: epoch, ctime: epoch, atime: epoch, birthtime: epoch, mtimeMs: 0,
		isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false };
};
const listing = (p, o) => {
	const at = where(p);
	if (!isDirectory(at)) throw failure(files.has(at) ? 'ENOTDIR' : 'ENOENT', "no such directory '" + p + "'");
	const prefix = at === '/' ? '/' : at + '/', names = new Set(at === '/' ? ['app', 'in', 'out'] : []);
	for (const k of [...files.keys(), ...out.keys()]) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
	const sorted = [...names].sort();
	if (!options(o).withFileTypes) return sorted;
	return sorted.map((name) => { const s = stats(prefix + name); return { name, isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: () => false }; });
};
const fs = {
	constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
	readFileSync: (p, o) => { const b = Buffer.from(read(p)), e = options(o).encoding; return e ? b.toString(e) : b; },
	writeFileSync: (p, d, o) => write(p, d, o, false),
	appendFileSync: (p, d, o) => write(p, d, o, true),
	existsSync: (p) => { try { stats(p); return true; } catch { return false; } },
	accessSync: (p) => { stats(p); },
	statSync: stats,
	lstatSync: stats,
	readdirSync: listing,
	realpathSync: (p) => { stats(p); return where(p); },
	mkdirSync: (p) => { if (!inOut(where(p))) throw failure('EROFS', "'" + p + "' is read-only; write to /out"); return undefined; },
	unlinkSync: (p) => { const at = where(p); if (!inOut(at)) throw failure('EROFS', "'" + p + "' is read-only"); out.delete(at); },
	rmSync: (p) => { const at = where(p); if (!inOut(at)) throw failure('EROFS', "'" + p + "' is read-only"); for (const k of [...out.keys()]) if (k === at || k.startsWith(at + '/')) out.delete(k); }
};
fs.realpathSync.native = fs.realpathSync;
const ASYNC = { readFile: 'readFileSync', writeFile: 'writeFileSync', appendFile: 'appendFileSync', access: 'accessSync', stat: 'statSync', lstat: 'lstatSync', readdir: 'readdirSync', realpath: 'realpathSync', mkdir: 'mkdirSync', unlink: 'unlinkSync', rm: 'rmSync' };
const promises = { constants: fs.constants };
for (const [name, sync] of Object.entries(ASYNC)) {
	promises[name] = async (...a) => fs[sync](...a);
	// a callback last, as Node calls it: after the current task
	fs[name] = (...a) => { const done = typeof a[a.length - 1] === 'function' ? a.pop() : () => {}; let r, e = null; try { r = fs[sync](...a); } catch (x) { e = x; } queueMicrotask(() => done(e, r)); };
}
fs.exists = (p, done) => queueMicrotask(() => done(fs.existsSync(p)));
fs.promises = promises;

// ── process, util ──
class Exit { constructor(code) { this.code = code; } }
const streamOf = (say) => { let line = ''; return { isTTY: false, write: (s) => { line += String(s); const parts = line.split('\n'); line = parts.pop(); for (const p of parts) say(p); return true; }, end: () => { if (line !== '') say(line); line = ''; } }; };
const stdout = streamOf((s) => console.log(s)), stderr = streamOf((s) => console.error(s));
const process = {
	argv: [], argv0: 'node', execArgv: [], env: {}, exitCode: undefined, pid: 1, ppid: 0, title: 'node',
	platform: 'linux', arch: 'x64', version: 'v26.0.0', versions: { node: '26.0.0' }, release: { name: 'node' },
	cwd: () => cwd,
	exit: (code) => { throw new Exit(code === undefined ? (process.exitCode ?? 0) : code); },
	stdout, stderr,
	nextTick: (task, ...a) => queueMicrotask(() => task(...a)),
	emitWarning: (w) => console.warn(String(w && w.message ? w.message : w)),
	// no events reach a run: its listeners are kept by nobody
	on: () => process, once: () => process, off: () => process, removeListener: () => process, emit: () => false, listeners: () => []
};
const show = (v) => { if (typeof v === 'string') return v; if (v instanceof Error) return v.stack || String(v); try { const j = JSON.stringify(v); return j === undefined ? String(v) : j; } catch { return String(v); } };
const util = {
	format: (f, ...a) => {
		if (typeof f !== 'string') return [f, ...a].map(show).join(' ');
		let i = 0;
		const s = f.replace(/%[sdifjoO%]/g, (m) => { if (m === '%%') return '%'; if (i >= a.length) return m; const v = a[i++]; return m === '%d' || m === '%i' ? String(m === '%i' ? parseInt(v) : Number(v)) : m === '%f' ? String(parseFloat(v)) : m === '%s' ? String(v) : show(v); });
		return [s, ...a.slice(i).map(show)].join(' ');
	},
	inspect: show,
	promisify: (f) => (...a) => new Promise((ok, no) => f(...a, (e, v) => (e ? no(e) : ok(v)))),
	inherits: (child, parent) => { Object.setPrototypeOf(child.prototype, parent.prototype); Object.setPrototypeOf(child, parent); Object.defineProperty(child, 'super_', { value: parent }); },
	deprecate: (f) => f,
	isDeepStrictEqual: (a, b) => show(a) === show(b),
	types: { isUint8Array: (v) => v instanceof Uint8Array, isDate: (v) => v instanceof Date, isRegExp: (v) => v instanceof RegExp, isPromise: (v) => v instanceof Promise },
	TextEncoder, TextDecoder
};
const BUILTINS = { fs, 'fs/promises': promises, path, buffer, process, util };
const builtin = (name) => BUILTINS[String(name).replace(/^node:/, '')];
Object.defineProperty(G, 'Buffer', { value: Buffer, writable: true, configurable: true });
Object.defineProperty(G, 'process', { value: process, writable: true, configurable: true });
Object.defineProperty(G, 'global', { value: G, writable: true, configurable: true });
// a require() the bundle could not resolve ahead of time: built-ins only
Object.defineProperty(G, 'require', { writable: true, configurable: true, value: (id) => {
	const found = builtin(id);
	if (found !== undefined) return found;
	throw Object.assign(new Error("require('" + id + "') at run time is not available in run_js: a bundle holds only what its imports name"), { code: 'MODULE_NOT_FOUND' });
} });
// WebAssembly compiles on the isolate's own thread, so its CPU is metered and the program ends inside its run
const instantiate = (source, imports) => { const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source); const instance = new WebAssembly.Instance(module, imports); return source instanceof WebAssembly.Module ? instance : { module, instance }; };
WebAssembly.instantiate = async (source, imports) => instantiate(source, imports);
WebAssembly.compile = async (source) => new WebAssembly.Module(source);
delete WebAssembly.instantiateStreaming;
delete WebAssembly.compileStreaming;

const headersOf = (init) => {
	const h = {};
	if (init && typeof init.forEach === 'function' && !Array.isArray(init)) init.forEach((v, k) => { h[String(k).toLowerCase()] = String(v); });
	else for (const [k, v] of Array.isArray(init) ? init : Object.entries(init || {})) h[String(k).toLowerCase()] = String(v);
	return h;
};
const responseOf = (r, url) => {
	const body = r.body, headers = r.headers;
	return {
		ok: r.status >= 200 && r.status < 300, status: r.status, statusText: '', url, redirected: false,
		headers: { get: (n) => headers[String(n).toLowerCase()] ?? null, has: (n) => String(n).toLowerCase() in headers, forEach: (f) => { for (const [k, v] of Object.entries(headers)) f(v, k); }, entries: () => Object.entries(headers)[Symbol.iterator](), [Symbol.iterator]: () => Object.entries(headers)[Symbol.iterator]() },
		text: async () => new TextDecoder().decode(body),
		json: async () => JSON.parse(new TextDecoder().decode(body)),
		arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
		bytes: async () => body
	};
};
const fetch = async (resource, init = {}) => {
	const url = typeof resource === 'string' ? resource : resource && typeof resource.href === 'string' ? resource.href : resource && typeof resource.url === 'string' ? resource.url : String(resource);
	const request = { method: String(init.method || 'GET').toUpperCase(), url, headers: headersOf(init.headers) };
	if (init.body !== undefined && init.body !== null) request.body = bytesOf(init.body);
	let r;
	try { r = await call('fetch', [request]); } catch (e) { throw new TypeError('fetch failed: ' + e.message); }
	return responseOf(r, url);
};

Object.defineProperty(G, Symbol.for('norbital.node'), { value: Object.freeze({
	builtin,
	run: async (input, load) => {
		const mounted = await call('mounts', []);
		mounted.paths.forEach((p, i) => files.set(p, mounted.bytes[i]));
		process.argv = ['node', input.entry, ...input.args];
		if (input.http === true) Object.defineProperty(G, 'fetch', { value: fetch, writable: true, configurable: true });
		let exitCode = 0;
		try {
			await load();
			exitCode = process.exitCode ?? 0;
		} catch (e) {
			if (!(e instanceof Exit)) throw e;
			exitCode = Number(e.code) || 0;
		} finally {
			stdout.end();
			stderr.end();
			if (out.size > 0) await call('out', [{ files: [...out].map(([p, bytes]) => ({ path: p.slice('/out/'.length), bytes })) }]);
		}
		return { exitCode };
	}
}) });
})();
`;
