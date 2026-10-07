// The build checks tsc cannot carry (§3.3.9 "Where each literal is checked", rules 6, 14, 33a, 38, 38d, 50, 52): numeric
// ranges, `seq` patterns, labels naming an id, calendar days declared as instants, state names and reachability, cron strings, approval step counts, event inputs, rates, IP limits, visitor grants and
// refs, masked search fields, write grants over child rows and unreachable internal callables. Each finding names the declaring file.
import { LIMITS, type EngineManifest } from '../../engine/contracts.ts';
import { parseRate } from '../../engine/access/rate.ts';
import { sizeBytes } from '../../engine/callables/upload.ts';

export type Finding = { code: string; path: string; message: string };
type Obj = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = <T>(v: T | readonly T[] | undefined): readonly T[] =>
	v === undefined ? [] : Array.isArray(v) ? v : [v as T];

const DATE_UNITS = ['year', 'month', 'week', 'day'];
const MACROS = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly'];
const RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7]
] as const;
/** Five fields (minute hour day month weekday) of `*`, numbers, ranges, lists and steps, or a macro. ponytail: no month or day names. */
/** The signature schemes a webhook is verified by (`engine/runs/webhook.ts`). */
const WEBHOOK_SCHEMES: readonly string[] = [
	'bearer',
	'hmac-sha256',
	'svix',
	'stripe',
	'slack',
	'meta'
];
export function cronValid(s: string): boolean {
	if (MACROS.includes(s)) return true;
	const fields = s.trim().split(/\s+/);
	return (
		fields.length === 5 &&
		fields.every((field, i) =>
			field.split(',').every((part) => {
				const [range = '', step] = part.split('/');
				if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
				if (range === '*') return true;
				const [lo, hi] = RANGES[i]!,
					[a = '', b] = range.split('-');
				const n = (x: string) => /^\d+$/.test(x) && Number(x) >= lo && Number(x) <= hi;
				return n(a) && (b === undefined || (n(b) && Number(a) <= Number(b)));
			})
		)
	);
}

/** A grant value that is `{ where?, fields?, previous?, approval? }` (not a bare `Where` on a field of that name). */
const scopeObject = (m: EngineManifest, c: string, g: unknown): Obj | undefined =>
	isObj(g) &&
	Object.keys(g).length > 0 &&
	Object.keys(g).every(
		(k) =>
			['where', 'fields', 'previous', 'approval'].includes(k) &&
			m.models[c]?.fields[k] === undefined
	)
		? g
		: undefined;

/** The first many-relation a `Where` on `c` crosses, through `and`/`or`/`not`, one-relation `is` and polymorphic arms. */
function manyIn(m: EngineManifest, c: string, w: unknown): string | undefined {
	if (!isObj(w)) return undefined;
	for (const [k, v] of Object.entries(w)) {
		const hit =
			k === 'and' || k === 'or'
				? list(v as unknown[])
						.map((x) => manyIn(m, c, x))
						.find((x) => x !== undefined)
				: k === 'not'
					? manyIn(m, c, v)
					: Object.values(m.relationships).some((r) => r.inverse === k && [r.to].flat().includes(c))
						? k
						: m.relationships[`${c}.${k}`] === undefined || !isObj(v)
							? undefined
							: [m.relationships[`${c}.${k}`]!.to]
									.flat()
									.map((t) => manyIn(m, t, 'is' in v ? v.is : v[t]))
									.find((x) => x !== undefined);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

export function buildChecks(
	m: EngineManifest,
	bodies: { automations: readonly string[]; connects?: readonly string[] },
	path: (role: string, name: string) => string
): Finding[] {
	const out: Finding[] = [];
	const at = (code: string, role: string, name: string, message: string) =>
		out.push({ code, path: path(role, name), message: `${path(role, name)}: ${message}` });

	// self sign-up (§5.11.2): the policies a newcomer holds exist, and the record that is them is matched on text fields
	const signup = (
		m.workspace as {
			signup?: {
				policies: readonly string[];
				party?: { collection: string; match: { email?: string; phone?: string } };
			};
		}
	).signup;
	for (const p of signup?.policies ?? [])
		if (m.policies[p] === undefined)
			at('workspace/signup', 'workspace', 'workspace', `signup: there is no policy '${p}'`);
	if (signup?.party !== undefined) {
		const { collection, match } = signup.party;
		const fields = m.models[collection]?.fields as
			{ readonly [f: string]: { kind: string } } | undefined;
		if (fields === undefined)
			at(
				'workspace/signup',
				'workspace',
				'workspace',
				`signup: party collection '${collection}' has no model`
			);
		else
			for (const f of [match.email, match.phone])
				if (f !== undefined && fields[f]?.kind !== 'text')
					at(
						'workspace/signup',
						'workspace',
						'workspace',
						`signup: party match '${collection}.${f}' is not a text field`
					);
		if (match.email === undefined && match.phone === undefined)
			at(
				'workspace/signup',
				'workspace',
				'workspace',
				'signup: party matches on an email field, a phone field, or both'
			);
	}

	for (const [model, spec] of Object.entries(m.models)) {
		for (const [f, k] of Object.entries(spec.fields) as [string, Obj & { kind: string }][]) {
			const range = (message: string) => at('model/range', 'model', model, `${f}: ${message}`);
			if (
				k.kind === 'vector' &&
				!(Number.isInteger(k.dim) && Number(k.dim) >= 1 && Number(k.dim) <= 2000)
			)
				range('vector dim is 1 to 2,000');
			if (
				k.kind === 'text' &&
				k.max !== undefined &&
				!(Number.isInteger(k.max) && Number(k.max) > 0)
			)
				range('text max is a positive integer');
			if (
				k.kind === 'file' &&
				!(sizeBytes(String(k.max)) > 0 && sizeBytes(String(k.max)) <= LIMITS.storedFileBytes)
			)
				range('file max is at most 20MiB'); // hook:runtime
			// a precision the kind cannot hold (a JS manifest or a cast: tsc refuses it in a declaration)
			const units =
				k.kind === 'date' || (k.kind === 'period' && k.of === 'date')
					? DATE_UNITS
					: k.kind === 'instant' || k.kind === 'period'
						? [...DATE_UNITS, 'hour', 'minute']
						: k.kind === 'time'
							? ['hour', 'minute']
							: [];
			if (k.precision !== undefined && !units.includes(String(k.precision)))
				at(
					'model/precision',
					'model',
					model,
					`${f}: a ${k.kind === 'period' ? `${String(k.of)} period` : k.kind} takes ${units.length === 0 ? 'no precision' : `precision ${units.join(', ')}`}`
				);
			if (
				k.min !== undefined &&
				k.max !== undefined &&
				typeof k.min === 'number' &&
				Number(k.min) > Number(k.max)
			)
				range('min is above max');
			if (k.kind === 'seq') {
				const tokens = [...String(k.pattern ?? '{0}').matchAll(/\{([^}]*)\}/g)].map((x) => x[1]!);
				if (
					tokens.filter((t) => /^0+$/.test(t)).length !== 1 ||
					tokens.some((t) => !/^(0+|yyyy|yy|mm)$/.test(t))
				)
					at(
						'model/seq',
						'model',
						model,
						`${f}: a seq pattern holds one {0…} counter and only {yyyy} {yy} {mm} besides`
					);
				for (const p of list(k.per as string | readonly string[] | undefined))
					if (spec.fields[p] === undefined && m.relationships[`${model}.${p}`] === undefined)
						at('model/seq', 'model', model, `${f}: per '${p}' is not a field`);
			}
			if (k.kind === 'state') {
				const states = k.states as { readonly [s: string]: { to?: readonly string[] } };
				if (!Object.hasOwn(states, String(k.initial)))
					at(
						'model/state',
						'model',
						model,
						`${f}: initial '${String(k.initial)}' is not one of its states (${Object.keys(states).join(', ')})`
					);
				for (const [s, x] of Object.entries(states))
					for (const to of x.to ?? [])
						if (!Object.hasOwn(states, to))
							at(
								'model/state',
								'model',
								model,
								`${f}: '${s}' moves to '${to}', which is not a state`
							);
				// rule 41, §5.5: every state is reachable from `initial` along `to` edges (an unreachable state's edges are dead)
				const seen = new Set([String(k.initial)]);
				for (const s of seen) for (const to of states[s]?.to ?? []) seen.add(to);
				for (const s of Object.keys(states))
					if (!seen.has(s))
						at(
							'model/state',
							'model',
							model,
							`${f}: '${s}' is unreachable from '${String(k.initial)}'`
						);
			}
			// a calendar day named as one is a `date`: an instant shows a time and shifts a day across zones
			if (k.kind === 'instant' && /_(on|date)$/.test(f))
				at(
					'model/instant-date',
					'model',
					model,
					`${f}: a field named *_on or *_date is a calendar day; declare it { kind: 'date' }`
				);
		}
		// a label is what a person reads for the row: an id or a foreign key would show as a uuid
		for (const l of list(spec.label as string | readonly string[] | undefined))
			if (l === 'id' || m.relationships[`${model}.${l}`] !== undefined)
				at(
					'model/label',
					'model',
					model,
					`label '${l}' is ${l === 'id' ? 'the row id' : 'a foreign key'}; label with the row's own text fields (a computed field may join them)`
				);
		// the embedding column's width, stated: a guess would have to match the host's model class, which it cannot know
		const sem = (spec.search as { semantic?: { dim?: unknown } } | undefined)?.semantic;
		if (
			sem !== undefined &&
			!(Number.isInteger(sem.dim) && Number(sem.dim) >= 1 && Number(sem.dim) <= 2000)
		)
			at(
				'model/range',
				'model',
				model,
				`search.semantic: dim is 1 to 2,000 (the embedding column's width, and the width every probe asks the model for)`
			);
	}

	// rule 61: a custom channel is the workspace's own provider — it names the connection it sends through and ships its setup page
	for (const [name, ch] of Object.entries(m.channelTypes ?? {})) {
		const send = ch['send'];
		const inbound = ch['inbound'],
			poll = ch['poll'];
		if (ch['transport'] !== 'custom') {
			if (send !== undefined)
				at(
					'channel/send',
					'channel',
					name,
					`only a custom channel names a send connection; a ${String(ch['transport'])} channel's provider is chosen at setup`
				);
			if (inbound !== undefined || poll !== undefined)
				at(
					'channel/custom-inbound',
					'channel',
					name,
					`only a custom channel declares inbound or poll; a ${String(ch['transport'])} channel receives through its provider`
				);
			continue;
		}
		if (send !== undefined ? typeof send !== 'string' || m.connections?.[send] === undefined : ch['inbound'] === undefined && ch['poll'] === undefined)
			at(
				'channel/custom-send',
				'channel',
				name,
				`a custom channel names the connection it sends through: send: '<connection>' (src/connection/+<connection>.connection.ts)`
			);
		if (!(bodies.connects ?? []).includes(name))
			at(
				'channel/custom-connect',
				'channel',
				name,
				`a custom channel ships its setup page: add src/custom_channels/${name}/+channel.configuration.svelte`
			);
		// its inbound is one path: the channel's own webhook, verified with the sealed credential, and/or a poll of a connection
		if (inbound !== undefined) {
			const v = isObj(inbound) ? inbound['verify'] : undefined;
			if (
				!isObj(v) ||
				!WEBHOOK_SCHEMES.includes(String(v['scheme'])) ||
				typeof v['secret'] !== 'string' ||
				v['secret'] === ''
			)
				at(
					'channel/inbound-verify',
					'channel',
					name,
					`inbound.verify names a scheme (${WEBHOOK_SCHEMES.join(', ')}) and the field of what the connect page pairs with that holds its secret`
				);
			if (!isObj(inbound) || inbound['messages'] !== true)
				at(
					'channel/inbound-messages',
					'channel',
					name,
					'inbound maps the verified body: messages: ({ body, headers }) => [...]'
				);
		}
		if (poll !== undefined) {
			const p = isObj(poll) ? poll : {};
			if (typeof p['connection'] !== 'string' || m.connections?.[p['connection']] === undefined)
				at(
					'channel/poll-connection',
					'channel',
					name,
					`poll names the connection it reads through: connection: '<connection>' (src/connection/+<connection>.connection.ts)`
				);
			if (typeof p['cron'] !== 'string' || !cronValid(p['cron']))
				at(
					'channel/poll-cron',
					'channel',
					name,
					`poll.cron '${String(p['cron'])}' is not 5 cron fields or a macro`
				);
			if (typeof p['path'] !== 'string')
				at('channel/poll-path', 'channel', name, "poll names the path it reads: path: '/messages'");
			if (p['messages'] !== true)
				at(
					'channel/poll-messages',
					'channel',
					name,
					'poll maps the answer: messages: ({ body }) => [...]'
				);
		}
	}

	for (const [name, a] of Object.entries(m.automations)) {
        const delegated = new Set<string>();
        for (const declaration of a.delegations ?? []) {
            const dot=declaration.verb.lastIndexOf('.'), collection=declaration.verb.slice(0,dot), verb=declaration.verb.slice(dot+1);
            const grant=m.policies[declaration.policy]?.grants[collection];
            const key=declaration.verb+'\0'+declaration.policy;
            if(!['create','update','delete'].includes(verb)||m.collections[collection]===undefined||grant===undefined||Reflect.get(grant,verb)===undefined||delegated.has(key))
                at('automation/delegation','automation',name,'Delegation requires one unique existing policy and its exact native target verb grant.');
            delegated.add(key);
        }
		if (!bodies.automations.includes(name))
			at('automation/no-body', 'automation', name, 'attach the run body with a.run(…)');
		for (const on of list(a.on) as Obj[]) {
			if (typeof on.cron === 'string' && !cronValid(on.cron))
				at('automation/cron', 'automation', name, `'${on.cron}' is not 5 cron fields or a macro`);
			const c = (on.created ?? on.updated ?? on.deleted) as string | undefined;
			if (c === undefined) continue;
			const ids = a.input?.ids as Obj | undefined;
			if (
				a.input !== undefined &&
				!(
					ids?.kind === 'list' &&
					ids.optional === true &&
					isObj(ids.of) &&
					ids.of.kind === 'id' &&
					ids.of.of === c
				)
			)
				at(
					'automation/event-input',
					'automation',
					name,
					`an automation with both on and input declares ids: { kind: 'list', of: { kind: 'id', of: '${c}' }, optional: true } in its input`
				);
			if (
				Array.isArray(a.runAs) &&
				!a.runAs.some((p) => {
					const g = m.policies[p]?.grants[c];
					return g !== undefined && (g.read !== undefined || g.via !== undefined);
				})
			)
				at(
					'automation/runas-read',
					'automation',
					name,
					`its runAs policies cannot read '${c}', which triggers it`
				);
		}
	}

	const publicOf = new Map<string, string[]>(); // policy → apps naming it in audience.public
	for (const [app, spec] of Object.entries(m.apps)) {
		const aud = (spec as { audience?: unknown }).audience;
		if (isObj(aud) && Array.isArray(aud.public))
			for (const p of aud.public as string[]) publicOf.set(p, [...(publicOf.get(p) ?? []), app]);
	}
	// a kiosk open with no authentication runs its requests as its assigned policies, so those count as
	// public for per-ip limits just like an app's visitor policies.
	for (const [kiosk, spec] of Object.entries(m.kiosks ?? {})) {
		if ((spec as { auth?: unknown }).auth !== 'none') continue;
		for (const p of (spec as { policies?: readonly string[] }).policies ?? [])
			publicOf.set(p, [...(publicOf.get(p) ?? []), `kiosk:${kiosk}`]);
	}
	for (const [p, spec] of Object.entries(m.policies)) {
		for (const [c, g] of Object.entries(spec.grants)) {
			for (const op of ['create', 'update', 'delete'] as const)
				for (const route of list(scopeObject(m, c, g[op])?.approval) as Obj[]) {
					const steps = (route.steps as readonly (readonly string[])[] | undefined) ?? [];
					if (steps.length === 0 || steps.length > 8 || steps.some((s) => s.length === 0))
						at(
							'approval/steps',
							'policy',
							p,
							`${c}.${op}: an approval has 1 to 8 steps, each naming a team`
						);
				}
			// a write is judged on the rows it names, in the act: its grant cannot scope through child rows (`write/act.ts` refuses it)
			for (const op of ['create', 'update', 'delete'] as const) {
				const s = scopeObject(m, c, g[op]),
					rel = manyIn(m, c, s === undefined ? g[op] : s.where) ?? manyIn(m, c, s?.previous);
				if (rel !== undefined)
					at(
						'access/write-many',
						'policy',
						p,
						`${c}.${op}: a write grant cannot scope through the many-relation '${rel}'; refuse it in the collection's transform`
					);
			}
			const read = scopeObject(m, c, g.read),
				search = m.models[c]?.search?.text ?? [];
			const fields = read?.fields as readonly string[] | undefined;
			const hidden = fields === undefined ? undefined : search.find((f) => !fields.includes(f));
			if (hidden !== undefined)
				at(
					'access/masked-search',
					'policy',
					p,
					`${c}: the read grant masks '${hidden}', a searchable field (rule 14)`
				);
		}
		for (const [key, v] of Object.entries(spec.limits ?? {})) {
			// rule 38: a rate admits at least one request per window
			for (const x of list(v as unknown)) {
				const rate = String(isObj(x) ? x.rate : x);
				let ok = false;
				try {
					const r = parseRate(rate);
					ok = Number.isInteger(r.limit) && r.limit > 0 && r.windowMs > 0;
				} catch {
					/* unparsable */
				}
				if (!ok)
					at(
						'access/limit',
						'policy',
						p,
						`limit '${key}': '${rate}' is not a positive count per window`
					);
			}
			if (list(v as unknown).some((x) => isObj(x) && x.per === 'ip') && !publicOf.has(p))
				at(
					'access/ip-limit',
					'policy',
					p,
					`limit '${key}' counts per ip, which only a policy an app names in audience.public may do`
				);
		}
	}

	for (const [app, spec] of Object.entries(m.apps)) {
		const aud = (spec as { audience?: unknown }).audience;
		if (!isObj(aud) || !Array.isArray(aud.public)) continue;
		const policies = (aud.public as string[]).flatMap((p) =>
			m.policies[p] === undefined ? [] : [[p, m.policies[p]!] as const]
		);
		const creates = new Set(
			policies.flatMap(([, s]) =>
				Object.entries(s.grants)
					.filter(([, g]) => g.create !== undefined)
					.map(([c]) => c)
			)
		);
		const reads = new Set(
			policies.flatMap(([, s]) =>
				Object.entries(s.grants)
					.filter(([, g]) => g.read !== undefined)
					.map(([c]) => c)
			)
		);
		for (const [p, s] of policies) {
			const bad = (message: string) =>
				at('access/visitor-grant', 'policy', p, `public in app '${app}': ${message}`);
			for (const k of ['automations', 'capabilities'] as const)
				if (s[k] !== undefined) bad(`a visitor policy holds no ${k}`);
			for (const [c, g] of Object.entries(s.grants)) {
				if (c.startsWith('sys_')) {
					bad(`no grant on ${c}`);
					continue;
				}
				for (const k of Object.keys(g))
					if (k !== 'read' && k !== 'create')
						bad(`${c}: a visitor may only read or create, never ${k}`);
				if (g.read !== undefined) {
					const fields = scopeObject(m, c, g.read)?.fields as readonly string[] | undefined;
					const label = list(m.models[c]?.label as string | readonly string[] | undefined);
					if (fields === undefined) bad(`${c}: a visitor read grant lists its fields`);
					else if (label.some((l) => !fields.includes(l)))
						bad(`${c}: the read fields include the label (${label.join(', ')})`);
					if (creates.has(c))
						bad(`${c}: a visitor never reads a collection a public policy of the app creates`);
				}
				if (g.create !== undefined)
					for (const col of m.collections[c]?.create?.input.columns ?? []) {
						const rel = m.relationships[`${c}.${col}`];
						if (rel === undefined || rel.default !== undefined) continue;
						for (const to of list(rel.to))
							if (!reads.has(to))
								at(
									'access/visitor-ref',
									'policy',
									p,
									`${c}.${col}: no public policy of app '${app}' reads ${to}, so every submission would be refused (rule 36)`
								);
					}
			}
		}
	}

	for (const [kiosk, spec] of Object.entries(m.kiosks ?? {})) {
		const s = spec as { auth?: unknown; policies?: unknown; pages?: unknown };
		const policies = Array.isArray(s.policies) ? s.policies as string[] : [];
		for (const p of policies)
			if (m.policies[p] === undefined)
				at('kiosk/policy', 'kiosk', kiosk, `policies: there is no policy '${p}'`);
		if (s.auth !== undefined && s.auth !== 'members' && s.auth !== 'external' && s.auth !== 'all' && s.auth !== 'none')
			at('kiosk/auth', 'kiosk', kiosk, `auth is 'members', 'external', 'all' or 'none'`);
		if (Object.keys((s.pages ?? {}) as object).length === 0)
			at('kiosk/pages', 'kiosk', kiosk, 'a kiosk has at least one page');
		// A kiosk's authority is fixed and always on: its policies admit no open-ended grant. Every read,
		// history, create and update lists its fields, and nothing deletes — a removal is an action whose
		// transform refuses outside its scope. Broad grants are unrepresentable here by construction.
		const explicit = (c: string, g: unknown): boolean => {
			const fields = scopeObject(m, c, g)?.fields as readonly string[] | undefined;
			return Array.isArray(fields) && fields.length > 0;
		};
		for (const p of policies) {
			const held = m.policies[p];
			if (held === undefined) continue;
			const narrow = (message: string) => at('access/kiosk-grant', 'policy', p, `kiosk '${kiosk}': ${message}`);
			for (const [c, g] of Object.entries(held.grants)) {
				if (c.startsWith('sys_')) continue;
				for (const op of ['read', 'history', 'create', 'update'] as const)
					if (g[op] !== undefined && !explicit(c, g[op]))
						narrow(`${c}.${op} lists its fields explicitly; a kiosk takes no open grant`);
				if (g.delete !== undefined) narrow(`${c}: a kiosk never deletes; write an action instead`);
			}
		}
		// auth 'none': the kiosk is open with no requestor policy, so its assigned policies run
		// envoy-style inside — they hold the same visitor shape as a public app's policies.
		if (s.auth === 'none') {
			const held = policies.flatMap((p) => m.policies[p] === undefined ? [] : [[p, m.policies[p]!] as const]);
			const creates = new Set(held.flatMap(([, x]) => Object.entries(x.grants).filter(([, g]) => g.create !== undefined).map(([c]) => c)));
			const reads = new Set(held.flatMap(([, x]) => Object.entries(x.grants).filter(([, g]) => g.read !== undefined).map(([c]) => c)));
			for (const [p, x] of held) {
				const bad = (message: string) => at('access/kiosk-grant', 'policy', p, `kiosk '${kiosk}' (auth 'none'): ${message}`);
				for (const k of ['automations', 'capabilities'] as const)
					if (x[k] !== undefined) bad(`a public kiosk policy holds no ${k}`);
				for (const [c, g] of Object.entries(x.grants)) {
					if (c.startsWith('sys_')) { bad(`no grant on ${c}`); continue; }
					for (const k of Object.keys(g))
						if (k !== 'read' && k !== 'create') bad(`${c}: a public kiosk may only read or create, never ${k}`);
					if (g.read !== undefined) {
						const fields = scopeObject(m, c, g.read)?.fields as readonly string[] | undefined;
						const label = list(m.models[c]?.label as string | readonly string[] | undefined);
						if (fields === undefined) bad(`${c}: a public kiosk read grant lists its fields`);
						else if (label.some((l) => !fields.includes(l))) bad(`${c}: the read fields include the label (${label.join(', ')})`);
						if (creates.has(c)) bad(`${c}: a public kiosk never reads a collection a policy of the kiosk creates`);
					}
					if (g.create !== undefined)
						for (const col of m.collections[c]?.create?.input.columns ?? []) {
							const rel = m.relationships[`${c}.${col}`];
							if (rel === undefined || rel.default !== undefined) continue;
							for (const to of list(rel.to))
								if (!reads.has(to)) at('access/kiosk-ref', 'policy', p, `${c}.${col}: no policy of kiosk '${kiosk}' reads ${to}, so every submission would be refused (rule 36)`);
						}
				}
			}
		}
	}

	for (const [c, spec] of Object.entries(m.collections))
		for (const part of ['queries', 'actions'] as const) {
			for (const [name, x] of Object.entries(spec[part] ?? {}) as [string, { internal?: true }][]) {
				if (x.internal !== true) continue;
				if (
					!Object.values(m.policies).some((p) =>
						((p.grants[c]?.[part] as readonly string[] | undefined) ?? []).includes(name)
					)
				)
					at(
						'access/internal-unreachable',
						'collection',
						c,
						`internal ${part === 'queries' ? 'query' : 'action'} '${name}' is listed by no policy's grants.${c}.${part}`
					);
			}
		}
	return out;
}
