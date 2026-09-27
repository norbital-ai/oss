// Rule 6: the guest's global surface beyond ECMAScript, exactly what the prelude installs. Self-contained (no DOM or
// node types), so the guest program is typed against this and nothing else. The parity test checks it both ways.
type Bytes = ArrayBuffer | ArrayBufferView;
interface GuestURLSearchParams extends Iterable<[string, string]> {
	readonly size: number;
	append(name: string, value: string): void; delete(name: string, value?: string): void; get(name: string): string | null;
	getAll(name: string): string[]; has(name: string, value?: string): boolean; set(name: string, value: string): void; sort(): void;
	forEach(fn: (value: string, name: string, self: GuestURLSearchParams) => void): void;
	entries(): IterableIterator<[string, string]>; keys(): IterableIterator<string>; values(): IterableIterator<string>; toString(): string;
}
interface GuestURL {
	readonly href: string; readonly origin: string; readonly searchParams: GuestURLSearchParams; search: string;
	protocol: string; username: string; password: string; host: string; hostname: string; port: string; pathname: string; hash: string;
	toString(): string; toJSON(): string;
}
interface GuestAbortSignal {
	readonly aborted: boolean; readonly reason: unknown; onabort: ((event: { type: 'abort'; target: GuestAbortSignal }) => void) | null;
	throwIfAborted(): void;
	addEventListener(type: 'abort', listener: (event: { type: 'abort'; target: GuestAbortSignal }) => void, options?: { once?: boolean }): void;
	removeEventListener(type: 'abort', listener: (event: { type: 'abort'; target: GuestAbortSignal }) => void): void;
}
export type IsolateGlobals = {
	console: { log(...parts: unknown[]): void; info(...parts: unknown[]): void; warn(...parts: unknown[]): void; error(...parts: unknown[]): void; debug(...parts: unknown[]): void };
	URL: { new (input: string | GuestURL, base?: string | GuestURL): GuestURL; canParse(input: string, base?: string): boolean; parse(input: string, base?: string): GuestURL | null };
	URLSearchParams: new (init?: string | GuestURLSearchParams | readonly (readonly [string, string])[] | { readonly [name: string]: string }) => GuestURLSearchParams;
	TextEncoder: new () => { readonly encoding: 'utf-8'; encode(input?: string): Uint8Array };
	/** UTF-8, and windows-1252 under its WHATWG labels (`latin1`, `iso-8859-1`, `ascii`, …); any other label is a `RangeError`. */
	TextDecoder: new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => { readonly encoding: 'utf-8' | 'windows-1252'; readonly fatal: boolean; readonly ignoreBOM: boolean; decode(input?: Bytes): string };
	AbortController: new () => { readonly signal: GuestAbortSignal; abort(reason?: unknown): void };
	/** No `timeout`: the guest has no clock. */
	AbortSignal: { abort(reason?: unknown): GuestAbortSignal; any(signals: Iterable<GuestAbortSignal>): GuestAbortSignal };
	crypto: {
		getRandomValues<T extends Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | BigInt64Array | BigUint64Array>(array: T): T;
		randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
		/** `digest` only (SHA-1, SHA-256, SHA-384, SHA-512); signing and keys are host concerns. */
		subtle: { digest(algorithm: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512' | { name: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512' }, data: Bytes): Promise<ArrayBuffer> };
	};
	structuredClone<T>(value: T): T;
	atob(data: string): string;
	btoa(data: string): string;
	queueMicrotask(task: () => void): void;
	/** Runs `task` as a later task of the same invocation; any `delay` above 0 throws a `BoltError` coded `timerDelay`. */
	setTimeout<A extends unknown[]>(task: (...args: A) => void, delay?: 0, ...args: A): number;
	clearTimeout(id: number | undefined): void;
};
