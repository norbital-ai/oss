// The guest half of the runner (§5.8, rule 6): the isolate's globals and the `ctx` bridge, as source evaluated once per
// fresh context. It runs as an `evalClosure` body, so the host hooks ($0 log, $1 random, $2 digest, $3 asset) stay in its closure
// and never become globals; it returns `{ start, take, give }` for the host to call.
// Kept as `String.raw` so regex escapes survive; it must contain no backtick and no `${`.
export const PRELUDE = String.raw`
'use strict';
const hostLog = $0, hostRandom = $1, hostDigest = $2, hostAsset = $3;
const G = globalThis;
const define = (name, value) => Object.defineProperty(G, name, { value, writable: true, configurable: true, enumerable: false });
const named = (name, message) => { const e = new Error(message); e.name = name; return e; };

// ── console: guest lines are the host's to label (never impersonate host logs) ──
const show = (p) => { if (typeof p === 'string') return p; try { const j = JSON.stringify(p); return j === undefined ? String(p) : j; } catch { return String(p); } };
const say = (level) => (...parts) => { hostLog(level, parts.map(show).join(' ').slice(0, 8000)); };
define('console', { log: say('log'), info: say('info'), warn: say('warn'), error: say('error'), debug: say('debug') });

// ── base64 ──
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
define('btoa', function btoa(input) {
	const s = String(input); let out = '';
	for (let i = 0; i < s.length; i += 3) {
		const n = s.length - i, a = s.charCodeAt(i), b = n > 1 ? s.charCodeAt(i + 1) : 0, c = n > 2 ? s.charCodeAt(i + 2) : 0;
		if (a > 255 || b > 255 || c > 255) throw named('InvalidCharacterError', 'btoa: the string holds characters outside Latin1');
		const v = a << 16 | b << 8 | c;
		out += B64[v >> 18 & 63] + B64[v >> 12 & 63] + (n > 1 ? B64[v >> 6 & 63] : '=') + (n > 2 ? B64[v & 63] : '=');
	}
	return out;
});
define('atob', function atob(input) {
	let s = String(input).replace(/[\t\n\f\r ]/g, '');
	if (s.length % 4 === 0) s = s.replace(/==?$/, '');
	if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw named('InvalidCharacterError', 'atob: the string is not correctly encoded');
	let out = '', bits = 0, acc = 0;
	for (let i = 0; i < s.length; i++) {
		acc = (acc << 6 | B64.indexOf(s[i])) & 0xffffff; bits += 6;
		if (bits >= 8) { bits -= 8; out += String.fromCharCode(acc >> bits & 255); }
	}
	return out;
});

// ── text ──
const bytesOf = (input) => {
	if (input === undefined) return new Uint8Array(0);
	if (input instanceof Uint8Array) return input;
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	throw new TypeError('expected an ArrayBuffer or an ArrayBuffer view');
};
class TextEncoder {
	get encoding() { return 'utf-8'; }
	encode(input = '') {
		const s = String(input), out = new Uint8Array(s.length * 3); let n = 0;
		for (let i = 0; i < s.length; i++) {
			let c = s.charCodeAt(i);
			if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
				const d = s.charCodeAt(i + 1);
				if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + (c - 0xd800 << 10) + (d - 0xdc00); i++; }
			}
			if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
			if (c < 0x80) out[n++] = c;
			else if (c < 0x800) { out[n++] = 0xc0 | c >> 6; out[n++] = 0x80 | c & 63; }
			else if (c < 0x10000) { out[n++] = 0xe0 | c >> 12; out[n++] = 0x80 | c >> 6 & 63; out[n++] = 0x80 | c & 63; }
			else { out[n++] = 0xf0 | c >> 18; out[n++] = 0x80 | c >> 12 & 63; out[n++] = 0x80 | c >> 6 & 63; out[n++] = 0x80 | c & 63; }
		}
		return out.slice(0, n);
	}
}
const UTF8_LABELS = ['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8'];
// WHATWG: every one of these labels decodes as windows-1252 (latin1 files, bank exports)
const CP1252_LABELS = ['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591',
	'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252'];
// 0x80–0x9f; the rest of windows-1252 is the byte's own code point
const CP1252_HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
	0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
class TextDecoder {
	#fatal; #ignoreBOM; #encoding;
	constructor(label = 'utf-8', options = {}) {
		const l = String(label).trim().toLowerCase();
		if (UTF8_LABELS.includes(l)) this.#encoding = 'utf-8';
		else if (CP1252_LABELS.includes(l)) this.#encoding = 'windows-1252';
		else throw new RangeError('TextDecoder: only utf-8 and windows-1252 are supported');
		this.#fatal = !!options.fatal; this.#ignoreBOM = !!options.ignoreBOM;
	}
	get encoding() { return this.#encoding; }
	get fatal() { return this.#fatal; }
	get ignoreBOM() { return this.#ignoreBOM; }
	decode(input) {
		const u8 = bytesOf(input), fatal = this.#fatal, units = [];
		if (this.#encoding === 'windows-1252') {
			let out = '';
			for (let i = 0; i < u8.length; i++) {
				const b = u8[i];
				units.push(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
				if (units.length >= 8192) { out += String.fromCharCode.apply(null, units); units.length = 0; }
			}
			return out + String.fromCharCode.apply(null, units);
		}
		let out = '', cp = 0, need = 0, seen = 0, lower = 0x80, upper = 0xbf;
		const bad = () => { if (fatal) throw new TypeError('The encoded data was not valid utf-8'); units.push(0xfffd); };
		for (let i = 0; i < u8.length; i++) {
			const byte = u8[i];
			if (need === 0) {
				if (byte <= 0x7f) units.push(byte);
				else if (byte >= 0xc2 && byte <= 0xdf) { cp = byte & 0x1f; need = 1; }
				else if (byte >= 0xe0 && byte <= 0xef) { cp = byte & 0x0f; need = 2; if (byte === 0xe0) lower = 0xa0; else if (byte === 0xed) upper = 0x9f; }
				else if (byte >= 0xf0 && byte <= 0xf4) { cp = byte & 0x07; need = 3; if (byte === 0xf0) lower = 0x90; else if (byte === 0xf4) upper = 0x8f; }
				else bad();
			} else if (byte < lower || byte > upper) {
				cp = need = seen = 0; lower = 0x80; upper = 0xbf; bad(); i--;
			} else {
				lower = 0x80; upper = 0xbf; cp = cp << 6 | byte & 0x3f;
				if (++seen === need) {
					if (cp <= 0xffff) units.push(cp); else { cp -= 0x10000; units.push(0xd800 | cp >> 10, 0xdc00 | cp & 0x3ff); }
					cp = need = seen = 0;
				}
			}
			if (units.length >= 8192) { out += String.fromCharCode.apply(null, units); units.length = 0; }
		}
		if (need !== 0) bad();
		out += String.fromCharCode.apply(null, units);
		return !this.#ignoreBOM && out.charCodeAt(0) === 0xfeff ? out.slice(1) : out;
	}
}
define('TextEncoder', TextEncoder);
define('TextDecoder', TextDecoder);

// ── URL (search and href are live over searchParams: memory guest-url-shim-froze-href) ──
const formEncode = (s) => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const qDecode = (part) => decodeURIComponent(part.split('+').join(' '));
class URLSearchParams {
	#pairs = [];
	constructor(init) {
		if (typeof init === 'string') {
			const raw = init.charAt(0) === '?' ? init.slice(1) : init;
			for (const piece of raw.split('&')) {
				if (piece === '') continue;
				const eq = piece.indexOf('=');
				this.#pairs.push(eq < 0 ? [qDecode(piece), ''] : [qDecode(piece.slice(0, eq)), qDecode(piece.slice(eq + 1))]);
			}
		} else if (init instanceof URLSearchParams) for (const [k, v] of init) this.#pairs.push([k, v]);
		else if (Array.isArray(init)) for (const entry of init) this.#pairs.push([String(entry[0]), String(entry[1])]);
		else if (init && typeof init === 'object') for (const key of Object.keys(init)) this.#pairs.push([key, String(init[key])]);
	}
	get size() { return this.#pairs.length; }
	append(k, v) { this.#pairs.push([String(k), String(v)]); }
	delete(k, v) { this.#pairs = this.#pairs.filter((p) => !(p[0] === String(k) && (v === undefined || p[1] === String(v)))); }
	get(k) { const p = this.#pairs.find((p) => p[0] === String(k)); return p === undefined ? null : p[1]; }
	getAll(k) { return this.#pairs.filter((p) => p[0] === String(k)).map((p) => p[1]); }
	has(k, v) { return this.#pairs.some((p) => p[0] === String(k) && (v === undefined || p[1] === String(v))); }
	set(k, v) {
		const key = String(k), at = this.#pairs.findIndex((p) => p[0] === key);
		if (at < 0) { this.#pairs.push([key, String(v)]); return; }
		this.#pairs[at] = [key, String(v)];
		this.#pairs = this.#pairs.filter((p, i) => i <= at || p[0] !== key);
	}
	sort() { this.#pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }
	forEach(fn, self) { for (const [k, v] of this.#pairs) fn.call(self, v, k, this); }
	entries() { return this.#pairs.map((p) => [p[0], p[1]])[Symbol.iterator](); }
	keys() { return this.#pairs.map((p) => p[0])[Symbol.iterator](); }
	values() { return this.#pairs.map((p) => p[1])[Symbol.iterator](); }
	[Symbol.iterator]() { return this.entries(); }
	toString() { return this.#pairs.map((p) => formEncode(p[0]) + '=' + formEncode(p[1])).join('&'); }
}
class URL {
	#params;
	constructor(input, base) {
		const str = String(input), schemeEnd = str.indexOf('://');
		if (schemeEnd < 0 && base !== undefined) {
			const b = base instanceof URL ? base : new URL(String(base));
			const next = str.slice(0, 2) === '//' ? b.protocol + str
				: str.charAt(0) === '/' ? b.origin + str
				: str.charAt(0) === '?' || str.charAt(0) === '#' ? b.origin + b.pathname + str
				: b.origin + b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1) + str;
			return new URL(next);
		}
		if (schemeEnd < 0) throw new TypeError('Invalid URL: ' + str);
		this.protocol = str.slice(0, schemeEnd).toLowerCase() + ':';
		let rest = str.slice(schemeEnd + 3);
		const hashAt = rest.indexOf('#');
		this.hash = hashAt < 0 ? '' : rest.slice(hashAt);
		if (hashAt >= 0) rest = rest.slice(0, hashAt);
		const queryAt = rest.indexOf('?');
		this.#params = new URLSearchParams(queryAt < 0 ? '' : rest.slice(queryAt));
		if (queryAt >= 0) rest = rest.slice(0, queryAt);
		const pathAt = rest.indexOf('/');
		let authority = pathAt < 0 ? rest : rest.slice(0, pathAt);
		this.pathname = pathAt < 0 ? '/' : rest.slice(pathAt);
		this.username = ''; this.password = '';
		const at = authority.lastIndexOf('@');
		if (at >= 0) {
			const info = authority.slice(0, at), colon = info.indexOf(':');
			this.username = colon < 0 ? info : info.slice(0, colon);
			this.password = colon < 0 ? '' : info.slice(colon + 1);
			authority = authority.slice(at + 1);
		}
		if (authority === '') throw new TypeError('Invalid URL: ' + str);
		this.host = authority.toLowerCase();
		const portAt = this.host.lastIndexOf(':');
		this.hostname = portAt < 0 ? this.host : this.host.slice(0, portAt);
		this.port = portAt < 0 ? '' : this.host.slice(portAt + 1);
	}
	get origin() { return this.protocol + '//' + this.host; }
	get searchParams() { return this.#params; }
	get search() { const q = this.#params.toString(); return q === '' ? '' : '?' + q; }
	set search(value) { this.#params = new URLSearchParams(String(value)); }
	get href() { return this.origin + this.pathname + this.search + this.hash; }
	toString() { return this.href; }
	toJSON() { return this.href; }
	static canParse(input, base) { try { new URL(input, base); return true; } catch { return false; } }
	static parse(input, base) { try { return new URL(input, base); } catch { return null; } }
}
define('URL', URL);
define('URLSearchParams', URLSearchParams);

// ── structuredClone ──
define('structuredClone', function structuredClone(value) {
	const seen = new Map();
	const clone = (v) => {
		if (typeof v === 'function' || typeof v === 'symbol') throw named('DataCloneError', String(typeof v) + ' could not be cloned');
		if (v === null || typeof v !== 'object') return v;
		if (seen.has(v)) return seen.get(v);
		let out;
		if (Array.isArray(v)) { out = new Array(v.length); seen.set(v, out); for (let i = 0; i < v.length; i++) if (i in v) out[i] = clone(v[i]); return out; }
		if (v instanceof Map) { out = new Map(); seen.set(v, out); for (const [k, x] of v) out.set(clone(k), clone(x)); return out; }
		if (v instanceof Set) { out = new Set(); seen.set(v, out); for (const x of v) out.add(clone(x)); return out; }
		if (v instanceof Date) out = new Date(v.getTime());
		else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
		else if (v instanceof ArrayBuffer) out = v.slice(0);
		else if (v instanceof DataView) out = new DataView(clone(v.buffer), v.byteOffset, v.byteLength);
		else if (ArrayBuffer.isView(v)) out = new v.constructor(clone(v.buffer), v.byteOffset, v.length);
		else if (v instanceof Error) { out = new Error(v.message); out.name = v.name; }
		else { out = {}; seen.set(v, out); for (const k of Object.keys(v)) out[k] = clone(v[k]); return out; }
		seen.set(v, out);
		return out;
	};
	return clone(value);
});

// ── crypto: random from the host's per-invocation stream, digest host-side; neither is a crossing ──
const INTEGER_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];
const hex = (b) => Array.from(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
define('crypto', {
	getRandomValues(t) {
		if (!INTEGER_ARRAYS.some((C) => t instanceof C)) throw named('TypeMismatchError', 'getRandomValues takes an integer typed array');
		if (t.byteLength > 65536) throw named('QuotaExceededError', 'getRandomValues takes at most 65536 bytes');
		new Uint8Array(t.buffer, t.byteOffset, t.byteLength).set(hostRandom(t.byteLength));
		return t;
	},
	randomUUID() {
		const b = hostRandom(16); b[6] = b[6] & 0x0f | 0x40; b[8] = b[8] & 0x3f | 0x80;
		const h = hex(b);
		return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
	},
	subtle: {
		digest(algorithm, data) {
			try {
				const name = typeof algorithm === 'string' ? algorithm : algorithm && algorithm.name;
				return Promise.resolve(hostDigest(String(name), bytesOf(data).slice()).slice().buffer);
			} catch (e) { return Promise.reject(e); }
		}
	}
});

// ── abort: guest-side signals; an abort runs its listeners synchronously. No AbortSignal.timeout: the guest has no clock ──
const SIGNAL = Symbol('signal');
let fireAbort;
class AbortSignal {
	#aborted = false; #reason = undefined; #listeners = [];
	onabort = null;
	constructor(key) { if (key !== SIGNAL) throw new TypeError('Illegal constructor'); }
	get aborted() { return this.#aborted; }
	get reason() { return this.#reason; }
	throwIfAborted() { if (this.#aborted) throw this.#reason; }
	addEventListener(type, listener, options) {
		if (type !== 'abort' || typeof listener !== 'function' || this.#listeners.some((l) => l.listener === listener)) return;
		this.#listeners.push({ listener, once: !!(options && typeof options === 'object' && options.once) });
	}
	removeEventListener(type, listener) { if (type === 'abort') this.#listeners = this.#listeners.filter((l) => l.listener !== listener); }
	static abort(reason) { const c = new AbortController(); c.abort(reason); return c.signal; }
	static any(signals) {
		const c = new AbortController();
		for (const s of signals) {
			if (s.aborted) { c.abort(s.reason); break; }
			s.addEventListener('abort', () => c.abort(s.reason), { once: true });
		}
		return c.signal;
	}
	static {
		fireAbort = (signal, reason) => {
			if (signal.#aborted) return;
			signal.#aborted = true;
			signal.#reason = reason === undefined ? named('AbortError', 'This operation was aborted') : reason;
			const event = { type: 'abort', target: signal };
			const listeners = signal.#listeners;
			signal.#listeners = listeners.filter((l) => !l.once);
			for (const l of listeners) l.listener.call(signal, event);
			if (typeof signal.onabort === 'function') signal.onabort(event);
		};
	}
}
class AbortController {
	#signal = new AbortSignal(SIGNAL);
	get signal() { return this.#signal; }
	abort(reason) { fireAbort(this.#signal, reason); }
}
define('AbortController', AbortController);
define('AbortSignal', AbortSignal);

// ── server assets: an import of './x?bytes' reads the artifact's bytes by sha256, synchronously, host-side (§5.8) ──
Object.defineProperty(G, Symbol.for('norbital.bolt.asset'), { value: (sha) => {
	const bytes = typeof hostAsset === 'function' ? hostAsset(String(sha)) : undefined;
	if (!(bytes instanceof Uint8Array)) throw named('BoltError', 'the artifact has no server asset ' + String(sha));
	return bytes;
} });
define('fileRef', function fileRef(file) {
	return { id: file.id, name: file.name, mime: file.mime };
});

// ── tasks: microtasks, and zero-delay timers run one per drain by take(); the guest has no clock to wait on ──
const timers = new Map();
let timerId = 0;
define('queueMicrotask', function queueMicrotask(task) {
	if (typeof task !== 'function') throw new TypeError('queueMicrotask takes a function');
	Promise.resolve().then(() => task());
});
define('setTimeout', function setTimeout(task, delay, ...args) {
	if (typeof task !== 'function') throw new TypeError('setTimeout takes a function');
	if (Number(delay) > 0) throw Object.assign(named('BoltError', 'setTimeout: guest code has no clock to wait on; only a delay of 0 runs (rule 6)'), { code: 'timerDelay' });
	timers.set(++timerId, () => task(...args));
	return timerId;
});
define('clearTimeout', function clearTimeout(id) { timers.delete(id); });

// ── the ctx bridge (rule 12): calls queue until the microtask queue drains, then cross together ──
let queue = [], state = null, ids = 0;
const inflight = new Map();
const refusals = new WeakSet();
const frame = () => {
	for (const line of String(new Error().stack).split('\n').slice(1)) if (!line.includes('bolt:prelude')) return line.trim();
	return 'unknown';
};
const call = (member, args, mode) => {
	const bins = [];
	const json = JSON.stringify(args, function (key, value) {
		const raw = this[key];
		if (raw instanceof Uint8Array) { bins.push(raw.slice()); return { $bin: bins.length - 1 }; }
		return value;
	});
	const site = frame();
	return new Promise((resolve, reject) => queue.push({ id: ++ids, member, json, bins, site, mode, resolve, reject }));
};
const thrown = (error) => error && error.kind === 'bolt' ? Object.assign(named('BoltError', error.message), { code: error.code }) : error;
const settle = (c, answer) => {
	if (answer.ok) {
		const v = answer.value;
		if (c.mode === 'act' && v && v.kind !== 'committed' && v.kind !== 'pendingApproval') c.reject(v); else c.resolve(v);
	} else if (c.mode === 'try' || (c.mode === 'value' && answer.error.kind !== 'bolt')) c.resolve(answer.error);
	else c.reject(thrown(answer.error));
};
const fn = (member, mode = 'throw') => (...args) => call(member, args, mode);
const withTry = (member) => Object.assign(fn(member), { try: fn(member, 'try') });
const refuse = (message, at) => { const r = { message: String(message), field: at && at.field }; refusals.add(r); throw r; };
const todayIn = (now) => (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

function ctxFor(kind, c, invocationId) {
	const clock = { now: c.now, today: c.today, tz: c.tz, todayIn: todayIn(c.now) };
	const reads = { read: fn('read'), get: fn('get'), aggregate: fn('aggregate'), similar: fn('similar'), history: fn('history'), query: fn('query') };
	const writes = { act: Object.assign(fn('act', 'act'), { try: fn('act', 'try'), many: fn('acts', 'act') }), schedule: fn('schedule'), notify: fn('notify') };
	switch (kind) {
		case 'transform': return { ...clock, actor: c.actor, invocationId, policies: Object.freeze([...(c.policies || [])]), admin: c.admin === true, existing: (c.existing || []).map((r) => r === null ? undefined : r), staged: Object.freeze((c.staged || []).map((row) => Object.freeze({...row,path:Object.freeze([...row.path]),...(row.parent ? {parent:Object.freeze({...row.parent})} : {})}))), refuse,
			db: { read: fn('db.read'), get: fn('db.get'), aggregate: fn('db.aggregate'), after: fn('db.after'),prepareCreate:fn('db.prepareCreate') } };
		case 'projection': return { ...clock, actor: c.actor, invocationId, ...reads, refuse, admin: c.admin === true, policies: Object.freeze([...(c.policies || [])]), fields: Object.freeze([...(c.fields || [])]) };
		case 'query': return { ...clock, actor: c.actor, invocationId, ...reads, refuse }; // hook:ctx-types (refuse)
		case 'action': case 'tool': return { ...clock, actor: c.actor, policies: Object.freeze([...(c.policies || [])]), admin: c.admin === true, invocationId, ...reads, ...writes, target: c.row, refuse };
		case 'automation': return { ...clock, actor: c.actor, invocationId, cause: c.cause, ...reads, ...writes, send: fn('send'), progress: fn('progress'),
			http: (connection) => Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((m) => [m,
				Object.assign((path, request) => call('http.' + m, [connection, path, request], 'throw'),
					{ try: (path, request) => call('http.' + m, [connection, path, request], 'try') })])),
			web: { read: withTry('web.read') },
			files: Object.fromEntries(['meta', 'get', 'url', 'text', 'table', 'sheet', 'image', 'put'].map((m) => [m, withTry('files.' + m)])),
			convert: { document: withTry('convert.document') },
			ai: { sys_1: { decide: withTry('ai.sys_1.decide') }, sys_2: { infer: withTry('ai.sys_2.infer') }, embed: withTry('ai.embed'),
				transcribe: withTry('ai.transcribe'), speak: withTry('ai.speak') }, // hook:ai — P36, P39
			geo: { search: fn('geo.search', 'value'), reverse: fn('geo.reverse', 'value') } };
		case 'mapping': return { ...clock, read: reads.read, get: reads.get, aggregate: reads.aggregate };
		default: return undefined;
	}
}

const failure = (e) => {
	if (refusals.has(e)) return ['refused', e.message, e.field === undefined ? null : String(e.field)];
	if (e && typeof e === 'object' && e.kind === 'refused') return ['refused', String(e.message), e.field === undefined ? null : String(e.field)];
	if (e instanceof Error) return ['error', e.name, e.message, String(e.stack || '')];
	return ['error', 'Error', show(e), ''];
};

// ── values (§3.3.10): wire tags become std's values. A date and an instant are their branded ISO strings; a decimal is
// std/decimal's Decimal, which registers itself under this symbol when the bundle imports it. ponytail: a bundle that
// never imports std/decimal cannot call a Decimal method, so its decimals stay their exact text.
const DECIMAL = Symbol.for('norbital.std.Decimal');
function typed(k, v) {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
	const d = v.$d, t = v.$t, n = v.$dec;
	if (d === undefined && t === undefined && n === undefined) return v;
	for (const key in v) if (key !== '$d' && key !== '$t' && key !== '$dec') return v;
	if (typeof d === 'string') return d;
	if (typeof t === 'string') return t;
	const D = G[DECIMAL];
	return typeof n === 'string' && D ? D.of(n) : n;
}

function start(kind, path, inputJson, ctxJson, invocationId) {
	const ns = G.__boltGuest; delete G.__boltGuest;
	let body = ns && ns.default;
	for (const p of path) body = body !== null && typeof body === 'object' && Object.hasOwn(body, p) ? body[p] : undefined;
	if (typeof body !== 'function') { state = ['missing', path.join('.')]; return; }
	const input = JSON.parse(inputJson, typed), ctx = ctxFor(kind, JSON.parse(ctxJson, typed), invocationId);
	const args = kind === 'mapping' || kind === 'tool'
		? (Array.isArray(input) ? input : [input]).map((a) => a !== null && typeof a === 'object' && a.$ctx === true ? ctx : a)
		: ctx === undefined ? [input] : [input, ctx];
	// hook:reads — a rerank is one invocation over the candidate page: input is [query, rows], output one score per row
	// a validation is one invocation over every value of its kind in the act: one message (or undefined) per value
	// a mapping over many items ({ $each, with }: a pipeline's records) is one invocation: each item through the body
	const each = kind === 'mapping' && input !== null && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.$each);
	Promise.resolve().then(() => each ? Promise.all(input.$each.map((item) => body(item, input.with))) : kind === 'rerank' ? input[1].map((row) => body(input[0], row)) : kind === 'validation' ? input.map((v) => body(v)) : body(...args)).then(
		(v) => { state = ['ok', JSON.stringify(v === undefined ? null : v)]; },
		(e) => { state = failure(e); });
}
/**
 * After a drain: the body's end state (a call still queued then is unawaited), and the calls that cross now. With
 * neither, the oldest timer runs and true asks the host to drain and take again; an uncaught throw in it fails the body.
 */
function take() {
	if (state === null && queue.length === 0 && timers.size > 0) {
		const [id, task] = timers.entries().next().value;
		timers.delete(id);
		try { task(); } catch (e) { state = failure(e); }
		return [null, [], [], true];
	}
	const taken = queue; queue = [];
	for (const c of taken) inflight.set(c.id, c);
	return [state, taken.map((c) => [c.member, c.json, c.site, c.id]), taken.map((c) => c.bins), false];
}
/**
 * One batch's answers by call id (batches land in any order): one JSON text per call, parsed unconditionally (memory
 * ivm-bridge-answers-must-be-json); bytes ride beside it.
 */
function give(callIds, texts, bins) {
	callIds.forEach((id, i) => {
		const c = inflight.get(id);
		inflight.delete(id);
		settle(c, JSON.parse(texts[i], (k, v) => v !== null && typeof v === 'object' && typeof v.$bin === 'number' ? bins[i][v.$bin] : typed(k, v)));
	});
}
return { start, take, give };
`;

/**
 * The prelude as the first script of a guest snapshot (`bolt build`): host hooks cannot be serialized, so they are late-bound.
 * Until the host calls `__boltBind` (once, after the restore; it deletes itself) every hook refuses, so a bundle whose
 * evaluation logs, draws entropy, digests or reads an asset gets no snapshot and evaluates per invocation as before.
 */
export const SNAPSHOT_PRELUDE = `globalThis.__boltBind = (() => {
	const refuse = () => { throw new Error('guest.mjs calls the host while it evaluates'); };
	let h = [refuse, refuse, refuse, refuse];
	const hooks = (($0, $1, $2, $3) => { ${PRELUDE} })((a, b) => h[0](a, b), (n) => h[1](n), (a, b) => h[2](a, b), (s) => h[3](s));
	return (log, random, digest, asset) => { delete globalThis.__boltBind; h = [log, random, digest, asset]; return hooks; };
})();`;
