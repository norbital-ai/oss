// The cell's globals (compute model §14): the web surface Bolt's engine and Effect use, installed into a bare isolate
// before any engine module evaluates, over the kernel's system calls where they need the host (timers, random bytes,
// log lines). Nothing else: no `process`, `require`, `fs` or `fetch`. A runtime that has its own globals (Node, a
// browser) keeps them: nothing is installed there.
//
// Also installed, because Effect needs them where Bolt hands it a body or a log: `console` (its loggers) and a
// `ReadableStream` (`HttpServerResponse.toWeb` streams, `HttpServerRequest.stream` reads).
// No runtime import: in a cell this module evaluates first, so Effect and the engine find their globals installed.
import type { Kernel } from './cell.ts';

export type CellGlobals = {
	/** The kernel's system calls, from `open` on; before it a system call throws. */
	readonly attach: (kernel: Kernel) => void;
	/** A timer the kernel fired (an entry). */
	readonly fire: (timer: number) => void;
};

/** A Request's or Response's unread body bytes, where this realm holds them: the membrane sends them inline. */
export const BODY_BYTES = Symbol.for('norbital.bolt.bodyBytes');

const named = (name: string, message: string) => {
	const error = new Error(message);
	error.name = name;
	return error;
};
/**
 * The realm boundary's one object guard: values here arrive from another isolate or from guest code, as anything.
 * Shared with the membrane; Effect's `Predicate` is unavailable because this module evaluates before any import.
 */
export const isObject = (value: unknown): value is object =>
	typeof value === 'object' && value !== null;
const isIterable = (value: unknown): value is Iterable<unknown> =>
	isObject(value) && typeof Reflect.get(value, Symbol.iterator) === 'function';
const field = (init: unknown, key: string): unknown =>
	isObject(init) ? Reflect.get(init, key) : undefined;
const ignore = () => undefined;

// ── UTF-8 (and windows-1252 under its WHATWG labels, for latin1 files and bank exports) ──
const encodeUtf8Into = (input: string, out: Uint8Array) => {
	let read = 0,
		written = 0;
	while (read < input.length) {
		let c = input.charCodeAt(read),
			units = 1;
		if (c >= 0xd800 && c <= 0xdbff && read + 1 < input.length) {
			const d = input.charCodeAt(read + 1);
			if (d >= 0xdc00 && d <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
				units = 2;
			}
		}
		if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
		const size = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
		if (written + size > out.length) break;
		if (size === 1) out[written++] = c;
		else if (size === 2) {
			out[written++] = 0xc0 | (c >> 6);
			out[written++] = 0x80 | (c & 63);
		} else if (size === 3) {
			out[written++] = 0xe0 | (c >> 12);
			out[written++] = 0x80 | ((c >> 6) & 63);
			out[written++] = 0x80 | (c & 63);
		} else {
			out[written++] = 0xf0 | (c >> 18);
			out[written++] = 0x80 | ((c >> 12) & 63);
			out[written++] = 0x80 | ((c >> 6) & 63);
			out[written++] = 0x80 | (c & 63);
		}
		read += units;
	}
	return { read, written };
};
const encodeUtf8 = (input: string) => {
	const out = new Uint8Array(input.length * 3);
	return out.slice(0, encodeUtf8Into(input, out).written);
};
const bytesOf = (input: unknown): Uint8Array => {
	if (input === undefined) return new Uint8Array(0);
	if (input instanceof Uint8Array) return input;
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	if (ArrayBuffer.isView(input))
		return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	throw new TypeError('expected an ArrayBuffer or an ArrayBuffer view');
};
const fromCodes = (codes: number[]) => {
	let out = '';
	for (let i = 0; i < codes.length; i += 8192)
		out += String.fromCharCode(...codes.slice(i, i + 8192));
	return out;
};
const UTF8_LABELS = [
	'unicode-1-1-utf-8',
	'unicode11utf8',
	'unicode20utf8',
	'utf-8',
	'utf8',
	'x-unicode20utf8'
];
const CP1252_LABELS = [
	'ansi_x3.4-1968',
	'ascii',
	'cp1252',
	'cp819',
	'csisolatin1',
	'ibm819',
	'iso-8859-1',
	'iso-ir-100',
	'iso8859-1',
	'iso88591',
	'iso_8859-1',
	'iso_8859-1:1987',
	'l1',
	'latin1',
	'us-ascii',
	'windows-1252',
	'x-cp1252'
];
// 0x80–0x9f; the rest of windows-1252 is the byte's own code point
const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
	0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
	0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
];
class TextEncoder {
	get encoding() {
		return 'utf-8';
	}
	encode(input: unknown = '') {
		return encodeUtf8(String(input));
	}
	encodeInto(input: unknown, out: Uint8Array) {
		return encodeUtf8Into(String(input), out);
	}
}
class TextDecoder {
	readonly #fatal: boolean;
	readonly #ignoreBOM: boolean;
	readonly #encoding: 'utf-8' | 'windows-1252';
	#pending = new Uint8Array(0);
	#started = false;
	constructor(label: unknown = 'utf-8', options: unknown = {}) {
		const l = String(label).trim().toLowerCase();
		if (UTF8_LABELS.includes(l)) this.#encoding = 'utf-8';
		else if (CP1252_LABELS.includes(l)) this.#encoding = 'windows-1252';
		else throw new RangeError('TextDecoder: only utf-8 and windows-1252 are supported');
		this.#fatal = field(options, 'fatal') === true;
		this.#ignoreBOM = field(options, 'ignoreBOM') === true;
	}
	get encoding() {
		return this.#encoding;
	}
	get fatal() {
		return this.#fatal;
	}
	get ignoreBOM() {
		return this.#ignoreBOM;
	}
	decode(input?: unknown, options?: unknown) {
		const stream = field(options, 'stream') === true,
			fresh = bytesOf(input);
		const u8 = this.#pending.length === 0 ? fresh : new Uint8Array([...this.#pending, ...fresh]);
		this.#pending = new Uint8Array(0);
		const codes: number[] = [];
		if (this.#encoding === 'windows-1252')
			for (const b of u8) codes.push(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b);
		else {
			const fatal = this.#fatal;
			const bad = () => {
				if (fatal) throw new TypeError('The encoded data was not valid utf-8');
				codes.push(0xfffd);
			};
			let cp = 0,
				need = 0,
				seen = 0,
				start = 0,
				lower = 0x80,
				upper = 0xbf;
			for (let i = 0; i < u8.length; i++) {
				const byte = u8[i]!;
				if (need === 0) {
					start = i;
					if (byte <= 0x7f) codes.push(byte);
					else if (byte >= 0xc2 && byte <= 0xdf) {
						cp = byte & 0x1f;
						need = 1;
					} else if (byte >= 0xe0 && byte <= 0xef) {
						cp = byte & 0x0f;
						need = 2;
						if (byte === 0xe0) lower = 0xa0;
						else if (byte === 0xed) upper = 0x9f;
					} else if (byte >= 0xf0 && byte <= 0xf4) {
						cp = byte & 0x07;
						need = 3;
						if (byte === 0xf0) lower = 0x90;
						else if (byte === 0xf4) upper = 0x8f;
					} else bad();
				} else if (byte < lower || byte > upper) {
					cp = need = seen = 0;
					lower = 0x80;
					upper = 0xbf;
					bad();
					i--;
				} else {
					lower = 0x80;
					upper = 0xbf;
					cp = (cp << 6) | (byte & 0x3f);
					if (++seen === need) {
						if (cp <= 0xffff) codes.push(cp);
						else {
							cp -= 0x10000;
							codes.push(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
						}
						cp = need = seen = 0;
					}
				}
			}
			if (need !== 0) {
				if (stream) this.#pending = u8.slice(start);
				else bad();
			}
		}
		let text = fromCodes(codes);
		if (!this.#ignoreBOM && !this.#started && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		this.#started = stream && (this.#started || text.length > 0);
		return text;
	}
}

// ── base64 ──
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const btoa = (input: unknown) => {
	const s = String(input);
	let out = '';
	for (let i = 0; i < s.length; i += 3) {
		const n = s.length - i,
			a = s.charCodeAt(i),
			b = n > 1 ? s.charCodeAt(i + 1) : 0,
			c = n > 2 ? s.charCodeAt(i + 2) : 0;
		if (a > 255 || b > 255 || c > 255)
			throw named('InvalidCharacterError', 'btoa: the string holds characters outside Latin1');
		const v = (a << 16) | (b << 8) | c;
		out +=
			B64[(v >> 18) & 63]! +
			B64[(v >> 12) & 63]! +
			(n > 1 ? B64[(v >> 6) & 63]! : '=') +
			(n > 2 ? B64[v & 63]! : '=');
	}
	return out;
};
const atob = (input: unknown) => {
	let s = String(input).replace(/[\t\n\f\r ]/g, '');
	if (s.length % 4 === 0) s = s.replace(/==?$/, '');
	if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s))
		throw named('InvalidCharacterError', 'atob: the string is not correctly encoded');
	let out = '',
		bits = 0,
		acc = 0;
	for (const ch of s) {
		acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out += String.fromCharCode((acc >> bits) & 255);
		}
	}
	return out;
};

// ── URL (WHATWG parsing for the URLs a cell handles; IDNA and IPv6 compression are not done here) ──
type Parts = {
	scheme: string;
	username: string;
	password: string;
	host: string | null;
	port: string;
	path: string;
	opaque: boolean;
	query: string | null;
	fragment: string | null;
};
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
	'ftp:': '21',
	'file:': '',
	'http:': '80',
	'https:': '443',
	'ws:': '80',
	'wss:': '443'
};
const isSpecial = (scheme: string) => Object.hasOwn(DEFAULT_PORTS, scheme);
type EncodeSet = (code: number) => boolean;
const C0: EncodeSet = (c) => c < 0x20 || c > 0x7e;
const FRAGMENT: EncodeSet = (c) =>
	C0(c) || c === 0x20 || c === 0x22 || c === 0x3c || c === 0x3e || c === 0x60;
const QUERY: EncodeSet = (c) =>
	C0(c) || c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c || c === 0x3e;
const SPECIAL_QUERY: EncodeSet = (c) => QUERY(c) || c === 0x27;
const PATH: EncodeSet = (c) =>
	QUERY(c) || c === 0x3f || c === 0x5e || c === 0x60 || c === 0x7b || c === 0x7d;
const USERINFO: EncodeSet = (c) =>
	PATH(c) ||
	c === 0x2f ||
	c === 0x3a ||
	c === 0x3b ||
	c === 0x3d ||
	c === 0x40 ||
	(c >= 0x5b && c <= 0x5d) ||
	c === 0x7c;
const hex2 = (byte: number) => '%' + (byte < 16 ? '0' : '') + byte.toString(16).toUpperCase();
const percentEncode = (input: string, set: EncodeSet) => {
	let out = '';
	for (const ch of input) {
		const code = ch.codePointAt(0)!;
		if (!set(code)) out += ch;
		else for (const byte of encodeUtf8(ch)) out += hex2(byte);
	}
	return out;
};
const percentDecode = (input: string): Uint8Array => {
	const bytes = encodeUtf8(input),
		out: number[] = [];
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		const pair = byte === 0x25 ? String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0) : '';
		if (/^[0-9a-fA-F]{2}$/.test(pair)) {
			out.push(parseInt(pair, 16));
			i += 2;
		} else out.push(byte);
	}
	return new Uint8Array(out);
};
const invalid = (input: string) => new TypeError(`Invalid URL: ${input}`);
const ipv4Part = (part: string, input: string) => {
	const [digits, radix]: readonly [string, number] = /^0[xX]/.test(part)
		? [part.slice(2), 16]
		: part.length > 1 && part.startsWith('0')
			? [part.slice(1), 8]
			: [part, 10];
	if (
		part === '' ||
		!(radix === 16 ? /^[0-9a-fA-F]*$/ : radix === 8 ? /^[0-7]*$/ : /^[0-9]+$/).test(digits)
	)
		throw invalid(input);
	return digits === '' ? 0 : parseInt(digits, radix);
};
const endsInNumber = (domain: string) => {
	const parts = domain.split('.');
	if (parts.at(-1) === '' && parts.length > 1) parts.pop();
	const last = parts.at(-1) ?? '';
	return /^[0-9]+$/.test(last) || /^0[xX][0-9a-fA-F]*$/.test(last);
};
const ipv4 = (domain: string, input: string) => {
	const parts = domain.split('.');
	if (parts.at(-1) === '' && parts.length > 1) parts.pop();
	if (parts.length > 4) throw invalid(input);
	const numbers = parts.map((part) => ipv4Part(part, input));
	const last = numbers.pop()!;
	if (numbers.some((n) => n > 255) || last >= 256 ** (4 - numbers.length)) throw invalid(input);
	let address = last;
	numbers.forEach((n, i) => (address += n * 256 ** (3 - i)));
	return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join('.');
};
const parseHost = (text: string, special: boolean, input: string): string => {
	if (text.startsWith('[')) {
		if (!/^\[[0-9a-fA-F:.]+\]$/.test(text)) throw invalid(input);
		return text.toLowerCase();
	}
	if (!special) {
		if (/[\u0000\t\n\r #/:<>?@[\\\]^|]/.test(text)) throw invalid(input);
		return percentEncode(text, C0);
	}
	const domain = new TextDecoder().decode(percentDecode(text)).toLowerCase();
	// ponytail: no IDNA (punycode) in the cell; an internationalized host name is refused, add tr46 if one is needed
	if (/[^\u0000-\u007f]/.test(domain) || /[\u0000- #%/:<>?@[\\\]^|\u007f]/.test(domain))
		throw invalid(input);
	return endsInNumber(domain) ? ipv4(domain, input) : domain;
};
const parsePort = (text: string, scheme: string, input: string) => {
	if (text === '') return '';
	if (!/^[0-9]+$/.test(text) || Number(text) > 65535) throw invalid(input);
	const port = String(Number(text));
	return DEFAULT_PORTS[scheme] === port ? '' : port;
};
const normalizePath = (text: string, special: boolean) => {
	const segments = text.split(special ? /[/\\]/ : '/'),
		out: string[] = [];
	segments.forEach((segment, i) => {
		if (i === 0) return;
		const last = i === segments.length - 1,
			lower = segment.toLowerCase();
		if (lower === '..' || lower === '.%2e' || lower === '%2e.' || lower === '%2e%2e') {
			out.pop();
			if (last) out.push('');
		} else if (lower === '.' || lower === '%2e') {
			if (last) out.push('');
		} else out.push(percentEncode(segment, PATH));
	});
	return '/' + out.join('/');
};
/** Path, query and fragment of what follows the authority (or of a relative reference). */
const tail = (text: string, special: boolean) => {
	const hash = text.indexOf('#'),
		beforeHash = hash < 0 ? text : text.slice(0, hash),
		question = beforeHash.indexOf('?');
	return {
		path: question < 0 ? beforeHash : beforeHash.slice(0, question),
		query:
			question < 0
				? null
				: percentEncode(beforeHash.slice(question + 1), special ? SPECIAL_QUERY : QUERY),
		fragment: hash < 0 ? null : percentEncode(text.slice(hash + 1), FRAGMENT)
	};
};
const withAuthority = (scheme: string, rest: string, input: string): Parts => {
	const special = isSpecial(scheme);
	const end = rest.search(special ? /[/\\?#]/ : /[/?#]/),
		authority = end < 0 ? rest : rest.slice(0, end),
		after = end < 0 ? '' : rest.slice(end);
	const at = authority.lastIndexOf('@'),
		info = at < 0 ? '' : authority.slice(0, at),
		hostPort = at < 0 ? authority : authority.slice(at + 1),
		colon = info.indexOf(':');
	const bracket = hostPort.lastIndexOf(']'),
		portAt = hostPort.lastIndexOf(':');
	const hasPort = portAt > bracket;
	const host = parseHost(hasPort ? hostPort.slice(0, portAt) : hostPort, special, input);
	if (special && host === '') throw invalid(input);
	const { path, query, fragment } = tail(after, special);
	return {
		scheme,
		username: percentEncode(colon < 0 ? info : info.slice(0, colon), USERINFO),
		password: colon < 0 ? '' : percentEncode(info.slice(colon + 1), USERINFO),
		host,
		port: hasPort ? parsePort(hostPort.slice(portAt + 1), scheme, input) : '',
		path:
			special || path !== ''
				? normalizePath(path.startsWith('/') || path.startsWith('\\') ? path : '/' + path, special)
				: '',
		opaque: false,
		query,
		fragment
	};
};
const relative = (text: string, base: Parts, input: string): Parts => {
	if (base.opaque) {
		if (!text.startsWith('#')) throw invalid(input);
		return { ...base, fragment: percentEncode(text.slice(1), FRAGMENT) };
	}
	const special = isSpecial(base.scheme),
		slash = (ch: string | undefined) => ch === '/' || (special && ch === '\\');
	if (slash(text[0]) && slash(text[1])) return withAuthority(base.scheme, text.slice(2), input);
	const { path, query, fragment } = tail(text, special);
	if (path === '') return { ...base, query: text.startsWith('?') ? query : base.query, fragment };
	const merged = slash(path[0]) ? path : base.path.slice(0, base.path.lastIndexOf('/') + 1) + path;
	return {
		...base,
		path: normalizePath(merged.startsWith('/') ? merged : '/' + merged, special),
		query,
		fragment
	};
};
const parse = (raw: string, base?: Parts): Parts => {
	const input = raw.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
	if (scheme === null) {
		if (base === undefined) throw invalid(raw);
		return relative(input, base, raw);
	}
	const name = scheme[1]!.toLowerCase() + ':',
		rest = input.slice(scheme[0].length);
	if (name === 'file:') {
		if (/^[/\\]{2}/.test(rest)) {
			const after = rest.slice(2),
				end = after.search(/[/\\?#]/),
				hostText = end < 0 ? after : after.slice(0, end);
			const host = hostText === '' ? '' : parseHost(hostText, true, raw);
			const { path, query, fragment } = tail(end < 0 ? '' : after.slice(end), true);
			return {
				scheme: name,
				username: '',
				password: '',
				host: host === 'localhost' ? '' : host,
				port: '',
				path: normalizePath(path === '' ? '/' : path, true),
				opaque: false,
				query,
				fragment
			};
		}
		if (base?.scheme === name) return relative(rest, base, raw);
		const { path, query, fragment } = tail(rest, true);
		return {
			scheme: name,
			username: '',
			password: '',
			host: '',
			port: '',
			path: normalizePath(path.startsWith('/') ? path : '/' + path, true),
			opaque: false,
			query,
			fragment
		};
	}
	if (isSpecial(name)) {
		if (base?.scheme === name && !/^[/\\]/.test(rest)) return relative(rest, base, raw);
		return withAuthority(name, rest.replace(/^[/\\]*/, ''), raw);
	}
	if (rest.startsWith('//')) return withAuthority(name, rest.slice(2), raw);
	const { path, query, fragment } = tail(rest, false);
	return path.startsWith('/')
		? {
				scheme: name,
				username: '',
				password: '',
				host: null,
				port: '',
				path: normalizePath(path, false),
				opaque: false,
				query,
				fragment
			}
		: {
				scheme: name,
				username: '',
				password: '',
				host: null,
				port: '',
				path: percentEncode(path, C0),
				opaque: true,
				query,
				fragment
			};
};
const serialize = (parts: Parts) => {
	let out = parts.scheme;
	if (parts.host !== null) {
		out += '//';
		if (parts.username !== '' || parts.password !== '')
			out += parts.username + (parts.password === '' ? '' : ':' + parts.password) + '@';
		out += parts.host + (parts.port === '' ? '' : ':' + parts.port);
	} else if (!parts.opaque && parts.path.startsWith('//')) out += '/.';
	out += parts.path;
	if (parts.query !== null) out += '?' + parts.query;
	if (parts.fragment !== null) out += '#' + parts.fragment;
	return out;
};

// application/x-www-form-urlencoded
const formEncode = (text: string) => {
	let out = '';
	for (const byte of encodeUtf8(text))
		out +=
			byte === 0x20
				? '+'
				: /[A-Za-z0-9*\-._]/.test(String.fromCharCode(byte))
					? String.fromCharCode(byte)
					: hex2(byte);
	return out;
};
const formDecode = (text: string) =>
	new TextDecoder().decode(percentDecode(text.replace(/\+/g, ' ')));
const formParse = (query: string): [string, string][] =>
	(query.startsWith('?') ? query.slice(1) : query)
		.split('&')
		.filter((piece) => piece !== '')
		.map((piece) => {
			const eq = piece.indexOf('=');
			return eq < 0
				? [formDecode(piece), '']
				: [formDecode(piece.slice(0, eq)), formDecode(piece.slice(eq + 1))];
		});
let replaceList: (params: URLSearchParams, query: string) => void = ignore;
let bindOwner: (params: URLSearchParams, update: (query: string | null) => void) => void = ignore;
class URLSearchParams {
	#list: [string, string][] = [];
	#owner: ((query: string | null) => void) | undefined;
	static {
		replaceList = (params, query) => {
			params.#list = formParse(query);
		};
		bindOwner = (params, update) => {
			params.#owner = update;
		};
	}
	constructor(init: unknown = '') {
		if (typeof init === 'string') this.#list = formParse(init);
		else if (init instanceof URLSearchParams) this.#list = init.#list.map(([k, v]) => [k, v]);
		else if (isIterable(init))
			for (const pair of init) {
				const items = isIterable(pair) ? Array.from(pair) : [];
				if (items.length !== 2)
					throw new TypeError('URLSearchParams: each pair needs a name and a value');
				this.#list.push([String(items[0]), String(items[1])]);
			}
		else if (isObject(init))
			for (const key of Object.keys(init)) this.#list.push([key, String(Reflect.get(init, key))]);
	}
	#changed() {
		const query = this.toString();
		this.#owner?.(query === '' ? null : query);
	}
	get size() {
		return this.#list.length;
	}
	append(name: unknown, value: unknown) {
		this.#list.push([String(name), String(value)]);
		this.#changed();
	}
	delete(name: unknown, value?: unknown) {
		this.#list = this.#list.filter(
			([k, v]) => !(k === String(name) && (value === undefined || v === String(value)))
		);
		this.#changed();
	}
	get(name: unknown) {
		return this.#list.find(([k]) => k === String(name))?.[1] ?? null;
	}
	getAll(name: unknown) {
		return this.#list.filter(([k]) => k === String(name)).map(([, v]) => v);
	}
	has(name: unknown, value?: unknown) {
		return this.#list.some(
			([k, v]) => k === String(name) && (value === undefined || v === String(value))
		);
	}
	set(name: unknown, value: unknown) {
		const key = String(name),
			at = this.#list.findIndex(([k]) => k === key);
		if (at < 0) this.#list.push([key, String(value)]);
		else {
			this.#list[at] = [key, String(value)];
			this.#list = this.#list.filter(([k], i) => i <= at || k !== key);
		}
		this.#changed();
	}
	sort() {
		this.#list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		this.#changed();
	}
	forEach(fn: (value: string, name: string, self: URLSearchParams) => void, self?: unknown) {
		for (const [k, v] of this.#list) fn.call(self, v, k, this);
	}
	entries() {
		return this.#list.map(([k, v]): [string, string] => [k, v])[Symbol.iterator]();
	}
	keys() {
		return this.#list.map(([k]) => k)[Symbol.iterator]();
	}
	values() {
		return this.#list.map(([, v]) => v)[Symbol.iterator]();
	}
	[Symbol.iterator]() {
		return this.entries();
	}
	toString() {
		return this.#list.map(([k, v]) => formEncode(k) + '=' + formEncode(v)).join('&');
	}
}
class URL {
	#parts: Parts;
	readonly #params = new URLSearchParams();
	constructor(input: unknown, base?: unknown) {
		this.#parts = parse(String(input), base === undefined ? undefined : parse(String(base)));
		replaceList(this.#params, this.#parts.query ?? '');
		bindOwner(this.#params, (query) => {
			this.#parts.query = query;
		});
	}
	static canParse(input: unknown, base?: unknown) {
		return URL.parse(input, base) !== null;
	}
	static parse(input: unknown, base?: unknown): URL | null {
		try {
			return new URL(input, base);
		} catch {
			return null;
		}
	}
	get href() {
		return serialize(this.#parts);
	}
	set href(value: string) {
		this.#parts = parse(String(value));
		replaceList(this.#params, this.#parts.query ?? '');
	}
	get origin(): string {
		const { scheme, host, port } = this.#parts;
		if (scheme === 'blob:') return URL.parse(this.#parts.path)?.origin ?? 'null';
		return isSpecial(scheme) && scheme !== 'file:' && host !== null
			? `${scheme}//${host}${port === '' ? '' : ':' + port}`
			: 'null';
	}
	get protocol() {
		return this.#parts.scheme;
	}
	set protocol(value: string) {
		const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*/.exec(String(value))?.[0]?.toLowerCase();
		if (scheme === undefined || isSpecial(scheme + ':') !== isSpecial(this.#parts.scheme)) return;
		this.#parts.scheme = scheme + ':';
		if (DEFAULT_PORTS[this.#parts.scheme] === this.#parts.port) this.#parts.port = '';
	}
	get username() {
		return this.#parts.username;
	}
	set username(value: string) {
		if (this.#parts.host !== null && this.#parts.host !== '')
			this.#parts.username = percentEncode(String(value), USERINFO);
	}
	get password() {
		return this.#parts.password;
	}
	set password(value: string) {
		if (this.#parts.host !== null && this.#parts.host !== '')
			this.#parts.password = percentEncode(String(value), USERINFO);
	}
	get host() {
		const { host, port } = this.#parts;
		return host === null ? '' : host + (port === '' ? '' : ':' + port);
	}
	set host(value: string) {
		if (this.#parts.opaque) return;
		const text = String(value),
			bracket = text.lastIndexOf(']'),
			colon = text.lastIndexOf(':');
		const special = isSpecial(this.#parts.scheme);
		try {
			const hasPort = colon > bracket;
			const host = parseHost(hasPort ? text.slice(0, colon) : text, special, text);
			if (special && host === '') return;
			this.#parts.host = host;
			if (hasPort) this.#parts.port = parsePort(text.slice(colon + 1), this.#parts.scheme, text);
		} catch {
			return;
		}
	}
	get hostname() {
		return this.#parts.host ?? '';
	}
	set hostname(value: string) {
		if (this.#parts.opaque) return;
		try {
			const host = parseHost(String(value), isSpecial(this.#parts.scheme), String(value));
			if (!(isSpecial(this.#parts.scheme) && host === '')) this.#parts.host = host;
		} catch {
			return;
		}
	}
	get port() {
		return this.#parts.port;
	}
	set port(value: string) {
		if (this.#parts.host === null || this.#parts.host === '' || this.#parts.scheme === 'file:')
			return;
		const digits = /^[0-9]*/.exec(String(value))?.[0] ?? '';
		try {
			this.#parts.port = parsePort(digits, this.#parts.scheme, digits);
		} catch {
			return;
		}
	}
	get pathname() {
		return this.#parts.path;
	}
	set pathname(value: string) {
		if (this.#parts.opaque) return;
		const special = isSpecial(this.#parts.scheme),
			text = String(value);
		this.#parts.path =
			!special && text === ''
				? ''
				: normalizePath(
						text.startsWith('/') || (special && text.startsWith('\\')) ? text : '/' + text,
						special
					);
	}
	get search() {
		const query = this.#parts.query;
		return query === null || query === '' ? '' : '?' + query;
	}
	set search(value: string) {
		const text = String(value).replace(/^\?/, '');
		this.#parts.query =
			text === ''
				? null
				: percentEncode(text, isSpecial(this.#parts.scheme) ? SPECIAL_QUERY : QUERY);
		replaceList(this.#params, text);
	}
	get searchParams() {
		return this.#params;
	}
	get hash() {
		const fragment = this.#parts.fragment;
		return fragment === null || fragment === '' ? '' : '#' + fragment;
	}
	set hash(value: string) {
		const text = String(value).replace(/^#/, '');
		this.#parts.fragment = text === '' ? null : percentEncode(text, FRAGMENT);
	}
	toString() {
		return this.href;
	}
	toJSON() {
		return this.href;
	}
}

// ── abort ──
const abortError = () => named('AbortError', 'This operation was aborted');
type Listener = { readonly listener: unknown; readonly once: boolean };
const SIGNAL = Symbol('signal');
let fireAbort: (signal: AbortSignal, reason: unknown) => void = ignore;
const callListener = (listener: unknown, self: unknown, event: unknown) => {
	if (typeof listener === 'function') Reflect.apply(listener, self, [event]);
	else if (isObject(listener)) {
		const handle: unknown = Reflect.get(listener, 'handleEvent');
		if (typeof handle === 'function') Reflect.apply(handle, listener, [event]);
	}
};
class AbortSignal {
	#aborted = false;
	#reason: unknown = undefined;
	#listeners: Listener[] = [];
	onabort: unknown = null;
	constructor(key: unknown) {
		if (key !== SIGNAL) throw new TypeError('Illegal constructor');
	}
	static {
		fireAbort = (signal, reason) => {
			if (signal.#aborted) return;
			signal.#aborted = true;
			signal.#reason = reason === undefined ? abortError() : reason;
			const event = { type: 'abort', target: signal },
				listeners = signal.#listeners;
			signal.#listeners = listeners.filter((l) => !l.once);
			for (const l of listeners) callListener(l.listener, signal, event);
			callListener(signal.onabort, signal, event);
		};
	}
	get aborted() {
		return this.#aborted;
	}
	get reason() {
		return this.#reason;
	}
	throwIfAborted() {
		if (this.#aborted) throw this.#reason;
	}
	addEventListener(type: unknown, listener: unknown, options?: unknown) {
		if (
			type !== 'abort' ||
			listener === null ||
			this.#listeners.some((l) => l.listener === listener)
		)
			return;
		this.#listeners.push({ listener, once: field(options, 'once') === true });
	}
	removeEventListener(type: unknown, listener: unknown) {
		if (type === 'abort') this.#listeners = this.#listeners.filter((l) => l.listener !== listener);
	}
	static abort(reason?: unknown) {
		const controller = new AbortController();
		controller.abort(reason);
		return controller.signal;
	}
	static timeout(ms: unknown) {
		const controller = new AbortController();
		globalThis.setTimeout(
			() => controller.abort(named('TimeoutError', 'The operation timed out.')),
			Number(ms)
		);
		return controller.signal;
	}
	static any(signals: Iterable<AbortSignal>) {
		const controller = new AbortController();
		for (const signal of signals) {
			if (signal.aborted) {
				controller.abort(signal.reason);
				break;
			}
			signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
		}
		return controller.signal;
	}
}
class AbortController {
	readonly #signal = new AbortSignal(SIGNAL);
	get signal() {
		return this.#signal;
	}
	abort(reason?: unknown) {
		fireAbort(this.#signal, reason);
	}
}

// ── streams: a pull source behind a default reader; enough for Effect's `toReadableStream` and `fromReadableStream` ──
type ReadResult<R> =
	{ readonly done: false; readonly value: R } | { readonly done: true; readonly value: undefined };
type Read<R> = {
	readonly resolve: (result: ReadResult<R>) => void;
	readonly reject: (error: unknown) => void;
};
type ControllerOps<R> = {
	readonly enqueue: (chunk: R) => void;
	readonly close: () => void;
	readonly error: (error: unknown) => void;
	readonly desiredSize: () => number | null;
};
class ReadableStreamDefaultController<R> {
	readonly #ops: ControllerOps<R>;
	constructor(ops: ControllerOps<R>, key: unknown) {
		if (key !== SIGNAL) throw new TypeError('Illegal constructor');
		this.#ops = ops;
	}
	get desiredSize() {
		return this.#ops.desiredSize();
	}
	enqueue(chunk: R) {
		this.#ops.enqueue(chunk);
	}
	close() {
		this.#ops.close();
	}
	error(error?: unknown) {
		this.#ops.error(error);
	}
}
type ReaderOps<R> = {
	readonly read: () => Promise<ReadResult<R>>;
	readonly release: () => void;
	readonly cancel: (reason: unknown) => Promise<void>;
	readonly closed: Promise<void>;
};
class ReadableStreamDefaultReader<R> {
	readonly #ops: ReaderOps<R>;
	constructor(ops: ReaderOps<R>, key: unknown) {
		if (key !== SIGNAL) throw new TypeError('Use stream.getReader()');
		this.#ops = ops;
	}
	get closed() {
		return this.#ops.closed;
	}
	read() {
		return this.#ops.read();
	}
	releaseLock() {
		this.#ops.release();
	}
	cancel(reason?: unknown) {
		return this.#ops.cancel(reason);
	}
}
const released = () => new TypeError('The reader was released');
class ReadableStream<R = unknown> {
	#queue: { readonly chunk: R }[] = [];
	#state: 'readable' | 'closed' | 'errored' = 'readable';
	#error: unknown = undefined;
	#reads: Read<R>[] = [];
	#locked = false;
	#closing = false;
	#started = false;
	#pulling = false;
	#pullAgain = false;
	#closed: PromiseWithResolvers<void> | undefined;
	readonly #highWaterMark: number;
	readonly #source: unknown;
	readonly #controller: ReadableStreamDefaultController<R>;
	constructor(source: unknown = {}, strategy: unknown = {}) {
		const mark = Number(field(strategy, 'highWaterMark') ?? 1);
		this.#highWaterMark = Number.isNaN(mark) ? 1 : mark;
		this.#source = source;
		this.#controller = new ReadableStreamDefaultController<R>(
			{
				enqueue: (chunk) => this.#enqueue(chunk),
				close: () => this.#requestClose(),
				error: (error) => this.#fail(error),
				desiredSize: () =>
					this.#state === 'errored'
						? null
						: this.#state === 'closed'
							? 0
							: this.#highWaterMark - this.#queue.length
			},
			SIGNAL
		);
		Promise.resolve(this.#call('start', this.#controller)).then(
			() => {
				this.#started = true;
				this.#pull();
			},
			(error: unknown) => this.#fail(error)
		);
	}
	#call(name: 'start' | 'pull' | 'cancel', argument: unknown): unknown {
		const method = field(this.#source, name);
		return typeof method === 'function'
			? Reflect.apply(method, this.#source, [argument])
			: undefined;
	}
	#enqueue(chunk: R) {
		if (this.#closing || this.#state !== 'readable') throw new TypeError('The stream is closed');
		const read = this.#reads.shift();
		if (read !== undefined) read.resolve({ done: false, value: chunk });
		else this.#queue.push({ chunk });
		this.#pull();
	}
	#requestClose() {
		if (this.#closing || this.#state !== 'readable') throw new TypeError('The stream is closed');
		this.#closing = true;
		if (this.#queue.length === 0) this.#finish();
	}
	#finish() {
		this.#state = 'closed';
		for (const read of this.#reads.splice(0)) read.resolve({ done: true, value: undefined });
		this.#closed?.resolve();
	}
	#fail(error: unknown) {
		if (this.#state !== 'readable') return;
		this.#state = 'errored';
		this.#error = error;
		this.#queue = [];
		for (const read of this.#reads.splice(0)) read.reject(error);
		this.#closed?.reject(error);
	}
	#pull() {
		if (!this.#started || this.#state !== 'readable' || this.#closing) return;
		if (this.#reads.length === 0 && this.#highWaterMark - this.#queue.length <= 0) return;
		if (this.#pulling) {
			this.#pullAgain = true;
			return;
		}
		this.#pulling = true;
		Promise.resolve()
			.then(() => this.#call('pull', this.#controller))
			.then(
				() => {
					this.#pulling = false;
					if (!this.#pullAgain) return;
					this.#pullAgain = false;
					this.#pull();
				},
				(error: unknown) => this.#fail(error)
			);
	}
	#read(): Promise<ReadResult<R>> {
		const next = this.#queue.shift();
		if (next !== undefined) {
			if (this.#closing && this.#queue.length === 0) this.#finish();
			else this.#pull();
			return Promise.resolve({ done: false, value: next.chunk });
		}
		if (this.#state === 'closed') return Promise.resolve({ done: true, value: undefined });
		if (this.#state === 'errored') return Promise.reject(this.#error);
		return new Promise((resolve, reject) => {
			this.#reads.push({ resolve, reject });
			this.#pull();
		});
	}
	#cancel(reason: unknown): Promise<void> {
		if (this.#state === 'closed') return Promise.resolve();
		if (this.#state === 'errored') return Promise.reject(this.#error);
		this.#queue = [];
		this.#finish();
		return Promise.resolve()
			.then(() => this.#call('cancel', reason))
			.then(ignore);
	}
	get locked() {
		return this.#locked;
	}
	cancel(reason?: unknown) {
		return this.#locked
			? Promise.reject(new TypeError('The stream is locked'))
			: this.#cancel(reason);
	}
	getReader(options?: unknown) {
		if (field(options, 'mode') !== undefined)
			throw new TypeError('Only default readers exist in a cell');
		if (this.#locked) throw new TypeError('The stream is locked');
		this.#locked = true;
		const closed = Promise.withResolvers<void>();
		closed.promise.catch(ignore);
		if (this.#state === 'closed') closed.resolve();
		else if (this.#state === 'errored') closed.reject(this.#error);
		this.#closed = closed;
		let held = true;
		return new ReadableStreamDefaultReader<R>(
			{
				read: () => (held ? this.#read() : Promise.reject(released())),
				release: () => {
					if (!held) return;
					held = false;
					this.#locked = false;
					this.#closed = undefined;
					for (const read of this.#reads.splice(0)) read.reject(released());
				},
				cancel: (reason) => (held ? this.#cancel(reason) : Promise.reject(released())),
				closed: closed.promise
			},
			SIGNAL
		);
	}
	tee(): [ReadableStream<R>, ReadableStream<R>] {
		const reader = this.getReader(),
			branches: (ReadableStreamDefaultController<R> | undefined)[] = [undefined, undefined],
			canceled = [false, false];
		let reading = false;
		const pull = () => {
			if (reading) return;
			reading = true;
			reader.read().then(
				(result) => {
					reading = false;
					branches.forEach((controller, i) => {
						if (controller === undefined || canceled[i] === true) return;
						if (result.done) controller.close();
						else controller.enqueue(result.value);
					});
				},
				(error: unknown) => branches.forEach((controller) => controller?.error(error))
			);
		};
		const branch = (i: number) =>
			new ReadableStream<R>({
				start: (controller: ReadableStreamDefaultController<R>) => {
					branches[i] = controller;
				},
				pull,
				cancel: (reason: unknown) => {
					canceled[i] = true;
					return canceled[0] === true && canceled[1] === true ? reader.cancel(reason) : undefined;
				}
			});
		return [branch(0), branch(1)];
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<R, void, undefined> {
		const reader = this.getReader();
		try {
			for (;;) {
				const result = await reader.read();
				if (result.done) return;
				yield result.value;
			}
		} finally {
			reader.releaseLock();
		}
	}
}

// ── headers, bodies, requests and responses: what `HttpServerRequest.fromWeb` and `HttpServerResponse.toWeb` use ──
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const headerName = (name: unknown) => {
	const text = String(name);
	if (!TOKEN.test(text)) throw new TypeError(`Invalid header name: ${text}`);
	return text.toLowerCase();
};
const headerValue = (value: unknown) => {
	const text = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
	if (/[\0\r\n]/.test(text)) throw new TypeError('Invalid header value');
	return text;
};
class Headers {
	#list: [string, string][] = [];
	constructor(init?: unknown) {
		if (init === undefined || init === null) return;
		if (init instanceof Headers) this.#list = init.#list.map(([k, v]) => [k, v]);
		else if (isIterable(init))
			for (const pair of init) {
				const items = isIterable(pair) ? Array.from(pair) : [];
				if (items.length !== 2) throw new TypeError('Headers: each pair needs a name and a value');
				this.append(items[0], items[1]);
			}
		else if (isObject(init))
			for (const key of Object.keys(init)) this.append(key, Reflect.get(init, key));
		else throw new TypeError('Headers: unsupported init');
	}
	append(name: unknown, value: unknown) {
		this.#list.push([headerName(name), headerValue(value)]);
	}
	delete(name: unknown) {
		const key = headerName(name);
		this.#list = this.#list.filter(([k]) => k !== key);
	}
	get(name: unknown) {
		const key = headerName(name),
			values = this.#list.filter(([k]) => k === key).map(([, v]) => v);
		return values.length === 0 ? null : values.join(', ');
	}
	getSetCookie() {
		return this.#list.filter(([k]) => k === 'set-cookie').map(([, v]) => v);
	}
	has(name: unknown) {
		const key = headerName(name);
		return this.#list.some(([k]) => k === key);
	}
	set(name: unknown, value: unknown) {
		const key = headerName(name),
			text = headerValue(value),
			at = this.#list.findIndex(([k]) => k === key);
		if (at < 0) this.#list.push([key, text]);
		else {
			this.#list[at] = [key, text];
			this.#list = this.#list.filter(([k], i) => i <= at || k !== key);
		}
	}
	forEach(fn: (value: string, name: string, self: Headers) => void, self?: unknown) {
		for (const [k, v] of this.entries()) fn.call(self, v, k, this);
	}
	*entries(): Generator<[string, string], void, undefined> {
		for (const name of [...new Set(this.#list.map(([k]) => k))].sort()) {
			if (name === 'set-cookie') for (const value of this.getSetCookie()) yield [name, value];
			else yield [name, this.get(name) ?? ''];
		}
	}
	*keys(): Generator<string, void, undefined> {
		for (const [k] of this.entries()) yield k;
	}
	*values(): Generator<string, void, undefined> {
		for (const [, v] of this.entries()) yield v;
	}
	[Symbol.iterator]() {
		return this.entries();
	}
}
type Source = null | Uint8Array | ReadableStream<Uint8Array>;
const extract = (body: unknown): { readonly source: Source; readonly type: string | null } => {
	if (body === undefined || body === null) return { source: null, type: null };
	if (typeof body === 'string')
		return { source: encodeUtf8(body), type: 'text/plain;charset=UTF-8' };
	if (body instanceof URLSearchParams)
		return {
			source: encodeUtf8(body.toString()),
			type: 'application/x-www-form-urlencoded;charset=UTF-8'
		};
	if (body instanceof ReadableStream) return { source: body, type: null };
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
		return { source: bytesOf(body).slice(), type: null };
	throw new TypeError('This body type is not supported in a cell');
};
const chunkOf = (value: unknown) =>
	typeof value === 'string' ? encodeUtf8(value) : bytesOf(value);
const streamOfBytes = (bytes: Uint8Array) =>
	new ReadableStream<Uint8Array>({
		start: (controller: ReadableStreamDefaultController<Uint8Array>) => {
			if (bytes.length > 0) controller.enqueue(bytes);
			controller.close();
		}
	});
let takeSource: (body: Body) => Source = () => null;
let cloneSource: (body: Body) => Source = () => null;
class Body {
	#source: Source;
	#used = false;
	constructor(source: Source) {
		this.#source = source;
	}
	static {
		takeSource = (body) => {
			const source = body.#source;
			body.#used = true;
			return source;
		};
		cloneSource = (body) => {
			if (!(body.#source instanceof ReadableStream)) return body.#source;
			const [own, copy] = body.#source.tee();
			body.#source = own;
			return copy;
		};
		// the membrane sends unread bytes inline instead of streaming them
		Object.defineProperty(Body.prototype, BODY_BYTES, {
			get(this: Body) {
				return !this.#used && this.#source instanceof Uint8Array ? this.#source : undefined;
			}
		});
	}
	get body() {
		if (this.#source instanceof Uint8Array) this.#source = streamOfBytes(this.#source);
		return this.#source;
	}
	get bodyUsed() {
		return this.#used || (this.#source instanceof ReadableStream && this.#source.locked);
	}
	async #consume(): Promise<Uint8Array> {
		if (this.bodyUsed) throw new TypeError('Body is unusable: it was already read');
		this.#used = true;
		const source = this.#source;
		if (source === null) return new Uint8Array(0);
		if (source instanceof Uint8Array) return source;
		const reader = source.getReader(),
			chunks: Uint8Array[] = [];
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			chunks.push(chunkOf(result.value));
		}
		const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
		let at = 0;
		for (const chunk of chunks) {
			out.set(chunk, at);
			at += chunk.length;
		}
		return out;
	}
	async arrayBuffer() {
		return (await this.#consume()).slice().buffer;
	}
	async bytes() {
		return (await this.#consume()).slice();
	}
	async text() {
		return new TextDecoder().decode(await this.#consume());
	}
	async json(): Promise<unknown> {
		return JSON.parse(await this.text());
	}
	async blob(): Promise<never> {
		throw new TypeError('Blob bodies are not supported in a cell');
	}
	async formData(): Promise<never> {
		throw new TypeError('FormData bodies are not supported in a cell');
	}
}
const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
class Request extends Body {
	readonly method: string;
	readonly url: string;
	readonly headers: Headers;
	readonly signal: AbortSignal;
	readonly redirect: string;
	constructor(input: unknown, init: unknown = {}) {
		const from = input instanceof Request ? input : undefined;
		const raw = String(field(init, 'method') ?? from?.method ?? 'GET'),
			method = METHODS.includes(raw.toUpperCase()) ? raw.toUpperCase() : raw;
		if (!TOKEN.test(method)) throw new TypeError(`Invalid method: ${method}`);
		const headers = new Headers(field(init, 'headers') ?? from?.headers),
			body = field(init, 'body');
		let source: Source = null;
		if (body !== undefined && body !== null) {
			if (method === 'GET' || method === 'HEAD')
				throw new TypeError('A GET or HEAD request has no body');
			const extracted = extract(body);
			source = extracted.source;
			if (extracted.type !== null && !headers.has('content-type'))
				headers.set('content-type', extracted.type);
		} else if (from !== undefined && body === undefined) source = takeSource(from);
		super(source);
		const signal = field(init, 'signal');
		this.method = method;
		this.url = from === undefined ? new URL(String(input)).href : from.url;
		this.headers = headers;
		this.signal =
			signal instanceof AbortSignal ? signal : (from?.signal ?? new AbortController().signal);
		this.redirect = String(field(init, 'redirect') ?? from?.redirect ?? 'follow');
	}
	clone() {
		return new Request(this.url, {
			method: this.method,
			headers: this.headers,
			signal: this.signal,
			redirect: this.redirect,
			body: cloneSource(this)
		});
	}
}
class Response extends Body {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Headers;
	readonly type: string;
	readonly url: string;
	readonly redirected: boolean;
	constructor(body?: unknown, init: unknown = {}) {
		const status = Number(field(init, 'status') ?? 200);
		if (!Number.isInteger(status) || status < 200 || status > 599)
			throw new RangeError(`Invalid response status: ${status}`);
		const headers = new Headers(field(init, 'headers')),
			extracted = extract(body);
		if (extracted.source !== null && [204, 205, 304].includes(status))
			throw new TypeError(`A ${status} response has no body`);
		if (extracted.type !== null && !headers.has('content-type'))
			headers.set('content-type', extracted.type);
		super(extracted.source);
		this.status = status;
		this.statusText = String(field(init, 'statusText') ?? '');
		this.headers = headers;
		this.type = 'default';
		this.url = '';
		this.redirected = false;
	}
	get ok() {
		return this.status >= 200 && this.status <= 299;
	}
	clone() {
		return new Response(cloneSource(this), {
			status: this.status,
			statusText: this.statusText,
			headers: this.headers
		});
	}
	static json(data: unknown, init: unknown = {}) {
		const headers = new Headers(field(init, 'headers'));
		if (!headers.has('content-type')) headers.set('content-type', 'application/json');
		return new Response(JSON.stringify(data), {
			status: field(init, 'status'),
			statusText: field(init, 'statusText'),
			headers
		});
	}
	static redirect(url: unknown, status: unknown = 302) {
		return new Response(null, { status, headers: { location: new URL(String(url)).href } });
	}
}

// ── structuredClone ──
const structuredClone = (value: unknown): unknown => {
	const seen = new Map<object, unknown>();
	const keep = <T>(from: object, to: T): T => {
		seen.set(from, to);
		return to;
	};
	const clone = (v: unknown): unknown => {
		if (typeof v === 'function' || typeof v === 'symbol')
			throw named('DataCloneError', `${typeof v} could not be cloned`);
		if (!isObject(v)) return v;
		if (seen.has(v)) return seen.get(v);
		if (Array.isArray(v)) {
			const out = keep<unknown[]>(v, []);
			const items: readonly unknown[] = v;
			items.forEach((item, i) => (out[i] = clone(item)));
			return out;
		}
		if (v instanceof Map) {
			const out = keep(v, new Map<unknown, unknown>());
			const items: ReadonlyMap<unknown, unknown> = v;
			for (const [k, item] of items) out.set(clone(k), clone(item));
			return out;
		}
		if (v instanceof Set) {
			const out = keep(v, new Set<unknown>());
			const items: ReadonlySet<unknown> = v;
			for (const item of items) out.add(clone(item));
			return out;
		}
		if (v instanceof Date) return keep(v, new Date(v.getTime()));
		if (v instanceof RegExp) return keep(v, new RegExp(v.source, v.flags));
		if (v instanceof ArrayBuffer) return keep(v, v.slice(0));
		if (v instanceof DataView)
			return keep(v, new DataView(v.buffer.slice(0), v.byteOffset, v.byteLength));
		if (ArrayBuffer.isView(v))
			return keep(
				v,
				Reflect.construct(v.constructor, [
					v.buffer.slice(0),
					v.byteOffset,
					Reflect.get(v, 'length')
				])
			);
		if (v instanceof Error) {
			const out = keep(v, new Error(v.message));
			out.name = v.name;
			return out;
		}
		const out = keep<Record<string, unknown>>(v, {});
		for (const key of Object.keys(v)) out[key] = clone(Reflect.get(v, key));
		return out;
	};
	return clone(value);
};

// ── the install: timers, the clock, randomness and log lines over the kernel's system calls ──
const show = (part: unknown): string => {
	if (typeof part === 'string') return part;
	if (part instanceof Error) return part.stack ?? `${part.name}: ${part.message}`;
	try {
		return JSON.stringify(part) ?? String(part);
	} catch {
		return String(part);
	}
};
const INTEGER_ARRAYS = [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	BigInt64Array,
	BigUint64Array
];
/** Random bytes are drawn from the kernel a page at a time. */
const POOL = 4096;
const install = (): CellGlobals => {
	let kernel: Kernel | undefined;
	const sys = () => {
		if (kernel === undefined) throw new Error('The cell is not open: it has no system calls yet');
		return kernel;
	};
	const say =
		(level: string) =>
		(...parts: readonly unknown[]) => {
			kernel?.log(level, parts.map(show).join(' '));
		};
	const report = say('error');
	const tasks = new Map<number, { readonly run: () => void; readonly every: number | undefined }>();
	let timers = 0;
	const schedule = (task: unknown, delay: unknown, args: readonly unknown[], repeat: boolean) => {
		if (typeof task !== 'function') throw new TypeError('A timer takes a function');
		const id = ++timers,
			ms = Math.max(0, Number(delay) || 0);
		tasks.set(id, {
			run: () => Reflect.apply(task, undefined, args),
			every: repeat ? ms : undefined
		});
		sys().timer(id, ms);
		return id;
	};
	const clear = (id: unknown) => {
		if (typeof id === 'number' && tasks.delete(id)) sys().clear(id);
	};
	let pool = new Uint8Array(0),
		used = 0;
	const random = (size: number) => {
		if (size > POOL) return sys().random(size);
		if (size > pool.length - used) {
			pool = sys().random(POOL);
			used = 0;
		}
		used += size;
		return pool.subarray(used - size, used);
	};
	const getRandomValues = (array: unknown) => {
		if (!INTEGER_ARRAYS.some((type) => array instanceof type) || !ArrayBuffer.isView(array))
			throw named('TypeMismatchError', 'getRandomValues takes an integer typed array');
		if (array.byteLength > 65536)
			throw named('QuotaExceededError', 'getRandomValues takes at most 65536 bytes');
		new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(random(array.byteLength));
		return array;
	};
	const randomUUID = () => {
		const b = random(16).slice();
		b[6] = (b[6]! & 0x0f) | 0x40;
		b[8] = (b[8]! & 0x3f) | 0x80;
		const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
	};
	const origin = Date.now();
	const globals: Readonly<Record<string, unknown>> = {
		console: {
			log: say('log'),
			info: say('info'),
			warn: say('warn'),
			error: say('error'),
			debug: say('debug'),
			trace: say('debug'),
			dir: say('log'),
			table: say('log'),
			assert: (ok: unknown, ...parts: readonly unknown[]) => {
				if (!ok) say('error')('Assertion failed', ...parts);
			},
			group: ignore,
			groupCollapsed: ignore,
			groupEnd: ignore,
			time: ignore,
			timeEnd: ignore,
			timeLog: ignore,
			count: ignore,
			countReset: ignore,
			clear: ignore
		},
		setTimeout: (task: unknown, delay?: unknown, ...args: readonly unknown[]) =>
			schedule(task, delay, args, false),
		setInterval: (task: unknown, delay?: unknown, ...args: readonly unknown[]) =>
			schedule(task, delay, args, true),
		clearTimeout: clear,
		clearInterval: clear,
		queueMicrotask: (task: unknown) => {
			if (typeof task !== 'function') throw new TypeError('queueMicrotask takes a function');
			Promise.resolve()
				.then(() => Reflect.apply(task, undefined, []))
				.catch(report);
		},
		// Work scheduled now runs in the entry that scheduled it, so its CPU is that entry's unit's: Effect's dispatcher
		// takes `setImmediate` when there is one, and would otherwise share one timer between every unit's fibers. Only
		// answers and real timers start later entries.
		setImmediate: (task: unknown, ...args: readonly unknown[]) => {
			if (typeof task !== 'function') throw new TypeError('setImmediate takes a function');
			const handle = { cancelled: false };
			Promise.resolve()
				.then(() => (handle.cancelled ? undefined : Reflect.apply(task, undefined, args)))
				.catch(report);
			return handle;
		},
		clearImmediate: (handle: unknown) => {
			if (isObject(handle) && 'cancelled' in handle) Reflect.set(handle, 'cancelled', true);
		},
		performance: { timeOrigin: origin, now: () => Date.now() - origin },
		crypto: { getRandomValues, randomUUID },
		structuredClone,
		atob,
		btoa,
		TextEncoder,
		TextDecoder,
		URL,
		URLSearchParams,
		Headers,
		Request,
		Response,
		ReadableStream,
		ReadableStreamDefaultReader,
		ReadableStreamDefaultController,
		AbortController,
		AbortSignal
	};
	for (const [name, value] of Object.entries(globals))
		Object.defineProperty(globalThis, name, {
			value,
			writable: true,
			configurable: true,
			enumerable: false
		});
	return {
		attach: (next) => {
			kernel = next;
		},
		fire: (id) => {
			const task = tasks.get(id);
			if (task === undefined) return;
			if (task.every === undefined) tasks.delete(id);
			else sys().timer(id, task.every);
			try {
				task.run();
			} catch (error) {
				report(error);
			}
		}
	};
};

/** Installed when this module evaluates in a bare isolate (a cell), before the engine's modules; elsewhere nothing. */
export const cellGlobals: CellGlobals | undefined =
	typeof globalThis.setTimeout === 'function' ? undefined : install();
