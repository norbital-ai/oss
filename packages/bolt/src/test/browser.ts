// `@norbital-ai/bolt/test/browser` (§3.7, G5): `sweep(t)` mounts the real workspace shell in a DOM test environment
// (happy-dom or a browser) over the kit's workspace, once per policy as a staff member, once per policy as an external
// member when an app admits externals, and once per public app as its visitor, and opens every page that actor's
// navigation offers plus their shell surfaces. A page that logs a console error or throws, or a live view the host
// refuses as over budget (rule 64: `subscriptionTooLarge`, `tooManySubscriptions`, `cellBudget`) or as malformed
// (`invalid`: a read the page itself built wrong, which a browser only shows as a view's error text), is a finding;
// any finding rejects the sweep with the list.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unmount } from 'svelte';
import type { Authority, TransportPort } from '../engine/contracts.ts';
import { RateWindows } from '../engine/access/rate.ts';
import { Authorities } from '../engine/identity/actor.ts';
import { loadKeys, loggedPhone, mint, signupOf, type IdentityHost } from '../engine/identity/session.ts';
import { boltHandler } from '../protocol/http.ts';
import { PATHS, type Frame, type LiveReply } from '../protocol/wire.ts';
import { devTurnstile, shellHost } from '../shell/host.ts';
import { mountShell, type ShellMountConfig } from '../shell/mount.ts';
import { audienceOf, COOKIES, nav, surfaces, type AppSpec, type NavNode } from '../shell/nav.ts';
import type { TestWorkspace } from './index.ts';

/**
 * Whom a sweep signs in as: a member holding `policies` (optionally external), a visitor of a public app, or the administrator.
 */
export type SweepActor = { policies: readonly string[]; external?: boolean } | { visitor: string } | { admin: true };
/**
 * What `sweep` visits: the build's pages, messages and representations, the actors, the apps, and how long a page may take to go quiet.
 */
export type SweepOptions = {
	/** The build's page chunks (`'<app>/<page>'`); a page without one renders the shell's not-found, which is still swept. */
	pages?: ShellMountConfig['pages'];
	messages?: ShellMountConfig['messages'];
	/** hook:ui-shell — the build's representations: each is mounted in the record sheet on a new and a stored record. */
	representations?: ShellMountConfig['representations'];
	/** Who to sweep; default one staff member per policy, one external per policy, one visitor per public app. */
	as?: readonly SweepActor[];
	/** Only these apps' pages. */
	apps?: readonly string[];
	/** The longest a page may take to go quiet (no request in flight), in ms; default 2,000. */
	quietMs?: number;
};
/**
 * One problem a sweep saw on a page: a console message, an uncaught error, a read budget refusal or a malformed read,
 * with who saw it where.
 */
export type SweepFinding = { who: string; path: string; kind: 'console' | 'error' | 'budget' | 'read'; message: string };
/** Every page a sweep visited, by whom, and what it found. */
export type SweepReport = { visited: { who: string; path: string }[]; findings: SweepFinding[] };

const ORIGIN = 'http://localhost';
const BUDGET = new Set(['subscriptionTooLarge', 'tooManySubscriptions', 'cellBudget']);
/** A refusal that can only mean the page built its read wrong: never a matter of who is looking. */
const MALFORMED = new Set(['invalid']);
const refusal = (code: string) => BUDGET.has(code) ? 'budget' as const : MALFORMED.has(code) ? 'read' as const : null;
const flat = (nodes: readonly NavNode[]): string[] => nodes.flatMap((n) => n.kind === 'group' ? flat(n.children) : n.pages.map((p) => p.href));
const label = (a: SweepActor) => 'visitor' in a ? `visitor of ${a.visitor}` : 'admin' in a ? 'administrator' : `${a.external ? 'external' : 'member'} [${a.policies.join(', ')}]`;

/**
 * Visits every page of every app as each actor (default: a member per policy, an external member per policy, a visitor per public app) and throws with the report when any page logs an error, throws or exceeds a read budget.
 */
export async function sweep(t: TestWorkspace, o: SweepOptions = {}): Promise<SweepReport> {
	const m = t.manifest;
	const apps = Object.entries(m.apps as { readonly [app: string]: AppSpec }).filter(([name]) => o.apps === undefined || o.apps.includes(name));
	const externalApps = apps.some(([, a]) => audienceOf(a) === 'external' || audienceOf(a) === 'all');
	const who: readonly SweepActor[] = o.as ?? [
		...Object.keys(m.policies).map((p) => ({ policies: [p] })),
		...(externalApps ? Object.keys(m.policies).map((p) => ({ policies: [p], external: true })) : []),
		...apps.filter(([, a]) => audienceOf(a) === 'public').map(([name]) => ({ visitor: name })),
	];
	const mail: TransportPort = { send: async () => ({ providerId: 'sweep' }), subscribe: () => () => {} };
	const identity: IdentityHost = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db), mail, sms: mail, devSink: true, publicUrl: ORIGIN,
		phone: loggedPhone(() => {}, true), // the dev code for a mobile number too
		...(signupOf(m) === undefined ? {} : { signup: signupOf(m)! }) };
	const authorities = new Authorities(m, 'sweep');
	const shell = shellHost({ manifest: m, identity, authorities, workspace: { name: 'Sweep', handle: 'sweep' }, ip: () => '203.0.113.50', turnstile: devTurnstile,
		secure: false, ...(t.engine.runs === undefined ? {} : { runs: t.engine.runs }) });
	const bolt = boltHandler({ engine: t.engine, session: shell.authority, uuid: () => crypto.randomUUID(),
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: m.workspace.tz, params: {} }) });
	const report: SweepReport = { visited: [], findings: [] };
	const quietMs = o.quietMs ?? 2_000;

	for (const actor of who) {
		const name = label(actor);
		// the actor: a real member with a session, or a visitor (no session; the page names its app)
		const jar = new Map<string, string>();
		let auth: Authority;
		if ('visitor' in actor) auth = authorities.visitor(actor.visitor, crypto.randomUUID());
		else {
			const id = crypto.randomUUID(), admin = 'admin' in actor;
			await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, $2, $3, $4, $5)`,
				params: [id, `sweep-${id}@sweep.test`, name, !admin && actor.external ? 'external' : 'staff', admin] });
			for (const p of admin ? [] : actor.policies)
				await t.db.write({ text: `INSERT INTO sys_assignment (id, principal_type, principal, policy) VALUES ($1, 'sys_user', $2, $3)`, params: [crypto.randomUUID(), id, p] });
			const s = await mint(identity, id);
			if (!s.ok) throw new Error(`sweep could not sign in ${name}: ${s.message}`);
			jar.set(COOKIES.session, s.value.token);
			auth = (await authorities.member(t.db, id))!;
		}
		const s = surfaces(m, auth.actor, auth.admin);
		const paths = [...flat(nav(m, auth)).filter((p) => o.apps === undefined || o.apps.some((a) => p.startsWith(`/app/${a}/`))),
			...(s.inbox ? ['/inbox'] : []), ...(s.runs ? ['/runs'] : []), ...(s.settings ? ['/settings'] : [])];
		// hook:ui-shell — every representation in the record sheet over the first page: a new record, and the first row the actor reads
		for (const c of 'visitor' in actor ? [] : Object.keys(o.representations ?? {})) {
			const row = (await t.as(auth).read(c, { limit: 1 }).catch(() => ({ rows: [] }))).rows[0];
			paths.push(...[`${c}/new`, ...(row === undefined ? [] : [`${c}/${String(row['id'])}`])].map((r) => `${paths[0] ?? '/inbox'}?record=${r}`));
		}

		for (const path of paths) {
			const found = (kind: SweepFinding['kind'], message: string) => report.findings.push({ who: name, path, kind, message });
			let inflight = 0, last = Date.now();
			const streams: (() => void)[] = [];
			const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
				inflight++;
				try {
					const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, ORIGIN);
					const request = () => {
						const r = new Request(url, init);
						// set after construction: a DOM `Request` drops a `cookie` header given in its init, and `clone()` drops it too
						if (jar.size > 0) r.headers.set('cookie', [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '));
						return r;
					};
					const res = await shell.handle(request()) ?? await bolt(request()) ?? new Response(null, { status: 404 });
					for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const at = pair!.indexOf('='); jar.set(pair!.slice(0, at), decodeURIComponent(pair!.slice(at + 1))); }
					if (url.pathname === PATHS.live && init.method === 'POST' && res.ok)
						for (const e of ((await res.clone().json()) as LiveReply).errors) { const k = refusal(e.code); if (k !== null) found(k, `${e.view}: ${e.code}${k === 'read' ? ` ${e.message}` : ''}`); }
					return res;
				} finally {
					inflight--;
					last = Date.now();
				}
			}) as typeof globalThis.fetch;
			/** The live stream over the handler's SSE body; an over-budget answer on it is a finding too. */
			const openStream = (url: string) => {
				const source = { onmessage: null as ((e: MessageEvent<string>) => void) | null, onerror: null as ((event: Event) => void) | null, close: () => {} };
				const abort = new AbortController();
				source.close = () => abort.abort();
				streams.push(source.close);
				void (async () => {
					try {
						const reader = (await fetch(url, { signal: abort.signal })).body!.getReader();
						const text = new TextDecoder();
						let buffer = '';
						for (;;) {
							const { value, done } = await reader.read();
							if (done) return;
							buffer += text.decode(value, { stream: true });
							for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
								const data = buffer.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
								buffer = buffer.slice(i + 2);
								if (data === '') continue;
								const frame = JSON.parse(data) as Frame;
								if (frame.t === 'error' && refusal(frame.code) !== null) found(refusal(frame.code)!, `${frame.view}: ${frame.code}${refusal(frame.code) === 'read' ? ` ${frame.message}` : ''}`);
								source.onmessage?.(new MessageEvent('message', { data }));
							}
						}
					} catch { /* closed */ }
				})();
				return source;
			};

			const consoleError = console.error;
			console.error = (...args: unknown[]) => found('console', args.map(String).join(' '));
			const onError = (e: ErrorEvent) => found('error', e.message);
			window.addEventListener('error', onError);
			(window as unknown as { happyDOM?: { setURL(url: string): void } }).happyDOM?.setURL(`${ORIGIN}${path}`) ?? history.replaceState(null, '', path);
			const target = document.createElement('div');
			document.body.append(target);
			let view: ReturnType<typeof mountShell> | undefined;
			try {
				view = mountShell(target, { manifest: m, pages: o.pages ?? {}, fetch, openStream, ...(o.messages === undefined ? {} : { messages: o.messages }),
					...(o.representations === undefined ? {} : { representations: o.representations }) });
				// quiet: nothing in flight for 50 ms, or the page's allowance is spent
				const until = Date.now() + quietMs;
				await new Promise((r) => setTimeout(r, 20));
				while (Date.now() < until && (inflight > 0 || Date.now() - last < 50)) await new Promise((r) => setTimeout(r, 10));
			} catch (e) {
				found('error', e instanceof Error ? e.message : String(e));
				// a page its actor may open never bounces to sign-in
				if (location.pathname.startsWith('/sign-in')) found('error', `redirected to ${location.pathname}`);
			} finally {
				if (view !== undefined) await unmount(view);
				for (const close of streams) close();
				target.remove();
				window.removeEventListener('error', onError);
				console.error = consoleError;
			}
			report.visited.push({ who: name, path });
		}
	}
	if (report.findings.length > 0)
		throw Object.assign(new Error(`sweep found ${report.findings.length} problem(s):\n${report.findings.map((f) => `  ${f.who} ${f.path} ${f.kind}: ${f.message}`).join('\n')}`), { report });
	return report;
}

/** `PLAYWRIGHT_HEADED=1` opts a run into visible windows (the visibility rows); anything else is headless (L-BOLT-1011). */
export const headed = (): boolean => process.env['PLAYWRIGHT_HEADED'] === '1';

/**
 * Chromium for a workspace's end-to-end tests, from the workspace's own `playwright` (a devDependency the kit never
 * installs): headless unless `headed()` or `{ headed }`, and loopback only — every hostname but `localhost` resolves to
 * nothing, so a page under test reaches no network. `B` is the caller's `import('playwright').Browser`.
 */
export async function chromium<B = unknown>(o: { headed?: boolean } = {}): Promise<B> {
	let pw: { chromium: { launch(options: { headless: boolean; args: string[] }): Promise<B> } };
	try {
		pw = await import(pathToFileURL(createRequire(join(process.cwd(), 'package.json')).resolve('playwright')).href) as typeof pw;
	} catch {
		throw new Error('test/browser: playwright is not installed in this workspace (add it as a devDependency, then `playwright install chromium`)');
	}
	return pw.chromium.launch({ headless: !(o.headed ?? headed()), args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
}
