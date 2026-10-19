// The build checks tsc cannot carry (§3.3.9 "Where each literal is checked", rules 6, 14, 33a, 38, 38d, 50, 52): numeric
// ranges, `seq` patterns, labels naming an id, calendar days declared as instants, state names and reachability, cron strings, approval step counts, event inputs, rates, IP limits, visitor grants and
// refs, masked search fields, write grants over child rows and unreachable internal callables. Each finding names the declaring file.
import { Predicate, Result } from 'effect';
import { LIMITS } from '../../engine/contracts.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import { toPred } from '../../engine/access/pred.ts';
import { Chain, ownPredSql } from '../../engine/write/sql.ts';
import { parseRate } from '../../engine/access/rate.ts';
import { sizeBytes } from '../../engine/callables/upload.ts';

export type Finding = { code: string; path: string; message: string };
type Obj = { readonly [k: string]: unknown };
const isList = <T>(v: T | readonly T[]): v is readonly T[] => Array.isArray(v);
const list = <T>(v: T | readonly T[] | undefined): readonly T[] =>
	v === undefined ? [] : isList<T>(v) ? v : [v];
const strings = (v: unknown): v is readonly string[] =>
	Array.isArray(v) && v.every(Predicate.isString);

const DATE_UNITS = ['year', 'month', 'week', 'day'];
const PRECISION: Readonly<Record<string, readonly string[]>> = {
	date: DATE_UNITS,
	instant: [...DATE_UNITS, 'hour', 'minute'],
	time: ['hour', 'minute']
};
const MACROS = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly'];
const RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7]
] as const;
/** Five fields (minute hour day month weekday) of `*`, numbers, ranges, lists and steps, or a macro. ponytail: no month or day names. */
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

/** A grant value that is `{ where?, fields?, previous? }` (not a bare `Where` on a field of that name). */
const scopeObject = (m: EngineManifest, c: string, g: unknown): Obj | undefined =>
	Predicate.isObject(g) &&
	Object.keys(g).length > 0 &&
	Object.keys(g).every(
		(k) => ['where', 'fields', 'previous'].includes(k) && m.models[c]?.fields[k] === undefined
	)
		? g
		: undefined;

/** The first many-relation a `Where` on `c` crosses, through `and`/`or`/`not`, one-relation `is` and polymorphic arms. */
function manyIn(m: EngineManifest, c: string, w: unknown): string | undefined {
	if (!Predicate.isObject(w)) return undefined;
	for (const [k, v] of Object.entries(w)) {
		const relation = m.relationships[`${c}.${k}`];
		const hit =
			k === 'and' || k === 'or'
				? list(v)
						.map((x) => manyIn(m, c, x))
						.find((x) => x !== undefined)
				: k === 'not'
					? manyIn(m, c, v)
					: Object.values(m.relationships).some((r) => r.inverse === k && list(r.to).includes(c))
						? k
						: relation === undefined || !Predicate.isObject(v)
							? undefined
							: list(relation.to)
									.map((t) => manyIn(m, t, 'is' in v ? v.is : v[t]))
									.find((x) => x !== undefined);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

type RuleContext = {
	m: EngineManifest;
	bodies: { automations: readonly string[] };
	at: (code: string, role: string, name: string, message: string) => void;
};

function workspaceRules({ m, bodies, at }: RuleContext): void {
	// self sign-up (§5.11.2): the policies a newcomer holds exist, and the record that is them is matched on text fields
	const signup = m.workspace.signup;
	for (const p of signup?.policies ?? [])
		if (m.policies[p] === undefined)
			at('workspace/signup', 'workspace', 'workspace', `signup: there is no policy '${p}'`);
	if (signup?.party !== undefined) {
		const { collection, match } = signup.party;
		const fields = m.models[collection]?.fields;
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
}

function modelRules({ m, bodies, at }: RuleContext): void {
	for (const [model, spec] of Object.entries(m.models)) {
		for (const [f, k] of Object.entries(spec.fields)) {
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
			const units = PRECISION[k.kind === 'period' ? String(k.of) : k.kind] ?? [];
			if ('precision' in k && k.precision !== undefined && !units.includes(String(k.precision)))
				at(
					'model/precision',
					'model',
					model,
					`${f}: a ${k.kind === 'period' ? `${String(k.of)} period` : k.kind} takes ${units.length === 0 ? 'no precision' : `precision ${units.join(', ')}`}`
				);
			if (
				'min' in k &&
				'max' in k &&
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
				for (const p of list(k.per))
					if (spec.fields[p] === undefined && m.relationships[`${model}.${p}`] === undefined)
						at('model/seq', 'model', model, `${f}: per '${p}' is not a field`);
			}
			if (k.kind === 'state') {
				const states = k.states;
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
		for (const l of list(spec.label))
			if (l === 'id' || m.relationships[`${model}.${l}`] !== undefined)
				at(
					'model/label',
					'model',
					model,
					`label '${l}' is ${l === 'id' ? 'the row id' : 'a foreign key'}; label with the row's own text fields (a computed field may join them)`
				);
		// the embedding column's width, stated: a guess would have to match the host's model class, which it cannot know
		const sem = spec.search?.semantic;
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
}

function integrationRules({ m, bodies, at }: RuleContext): void {
	// a pulled feed runs on its cron (tsc counts the fields; this parses them)
	for (const [name, d] of Object.entries(m.integrations))
		for (const [feed, f] of Object.entries(d.feeds ?? {}))
			if ((f.from ?? 'read') === 'read' && (f.cron === undefined || !cronValid(f.cron)))
				at(
					'integration/cron',
					'integration_definition',
					name,
					`feed '${feed}': cron '${String(f.cron)}' is not 5 cron fields or a macro`
				);
	// an outbound `when` is decided inside the commit that writes the row, on that row alone: its own fields and literals
	for (const [name, d] of Object.entries(m.integrations))
		for (const [rule, o] of Object.entries(d.outbound ?? {}))
			if (o.when !== undefined) {
				const parsed = Result.try({
					try: () => ownPredSql(toPred(m, o.from, o.when), 'row', new Chain()),
					catch: (error) => (error instanceof Error ? error.message : String(error))
				});
				if (Result.isFailure(parsed)) {
					at(
						'integration/outbound-when',
						'integration_definition',
						name,
						`outbound '${rule}': its when tests the written row of '${o.from}' alone: ${parsed.failure}`
					);
				}
			}
}

function automationRules({ m, bodies, at }: RuleContext): void {
	for (const [name, a] of Object.entries(m.automations)) {
		const delegated = new Set<string>();
		for (const declaration of a.delegations ?? []) {
			const dot = declaration.verb.lastIndexOf('.'),
				collection = declaration.verb.slice(0, dot),
				verb = declaration.verb.slice(dot + 1);
			const grant = m.policies[declaration.policy]?.grants[collection];
			const key = declaration.verb + '\0' + declaration.policy;
			if (
				!['create', 'update', 'delete'].includes(verb) ||
				m.collections[collection] === undefined ||
				grant === undefined ||
				grant[verb] === undefined ||
				delegated.has(key)
			)
				at(
					'automation/delegation',
					'automation',
					name,
					'Delegation requires one unique existing policy and its exact native target verb grant.'
				);
			delegated.add(key);
		}
		if (!bodies.automations.includes(name))
			at('automation/no-body', 'automation', name, 'attach the run body with a.run(…)');
		for (const on of list(a.on)) {
			if ('cron' in on && typeof on.cron === 'string' && !cronValid(on.cron))
				at('automation/cron', 'automation', name, `'${on.cron}' is not 5 cron fields or a macro`);
			const c =
				'created' in on
					? on.created
					: 'updated' in on
						? on.updated
						: 'deleted' in on
							? on.deleted
							: undefined;
			if (c === undefined) continue;
			const ids = a.input?.ids;
			if (
				a.input !== undefined &&
				!(
					ids?.kind === 'list' &&
					ids.optional === true &&
					Predicate.isObject(ids.of) &&
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
}

function policyRules({ m, bodies, at }: RuleContext): void {
	const publicOf = new Map<string, string[]>(); // policy → apps naming it in audience.public
	for (const [app, spec] of Object.entries(m.apps)) {
		const aud = spec.audience;
		if (Predicate.isObject(aud) && Array.isArray(aud.public))
			for (const p of aud.public) publicOf.set(p, [...(publicOf.get(p) ?? []), app]);
	}
	// a kiosk open with no authentication runs its requests as its assigned policies, so those count as
	// public for per-ip limits just like an app's visitor policies.
	for (const [kiosk, spec] of Object.entries(m.kiosks ?? {})) {
		if (spec.auth !== 'none') continue;
		for (const p of spec.policies ?? [])
			publicOf.set(p, [...(publicOf.get(p) ?? []), `kiosk:${kiosk}`]);
	}
	for (const [p, spec] of Object.entries(m.policies)) {
		for (const [c, g] of Object.entries(spec.grants)) {
			for (const op of ['create', 'update', 'delete'] as const)
				for (const route of list(
					Predicate.isObject(g.approval) ? g.approval[op] : undefined
				).filter((x) => Predicate.isObject(x))) {
					const steps = list(route.steps);
					if (
						!Array.isArray(route.steps) ||
						steps.length === 0 ||
						steps.length > 8 ||
						steps.some((s) => !strings(s) || s.length === 0)
					)
						at(
							'approval/steps',
							'policy',
							p,
							`${c}.${op}: an approval has 1 to 8 steps, each naming a source team handle`
						);
					for (const handle of [
						...steps.filter(strings).flat(),
						...(typeof route['superseded_by'] === 'string'
							? [route['superseded_by']]
							: Array.isArray(route['superseded_by'])
								? route['superseded_by'].filter(
										(value: unknown): value is string => typeof value === 'string'
									)
								: [])
					])
						if (!Object.hasOwn(m.teams, handle))
							at(
								'approval/team',
								'policy',
								p,
								`${c}.${op}: approval names unknown source team '${handle}'`
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
			const declared = read?.fields;
			const fields = strings(declared) ? declared : undefined;
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
			for (const x of list(v)) {
				const rate = String(Predicate.isObject(x) ? x.rate : x);
				const parsed = Result.try(() => {
					const r = parseRate(rate);
					return Number.isInteger(r.limit) && r.limit > 0 && r.windowMs > 0;
				});
				if (Result.isFailure(parsed) || !parsed.success)
					at(
						'access/limit',
						'policy',
						p,
						`limit '${key}': '${rate}' is not a positive count per window`
					);
			}
			if (list(v).some((x) => Predicate.isObject(x) && x.per === 'ip') && !publicOf.has(p))
				at(
					'access/ip-limit',
					'policy',
					p,
					`limit '${key}' counts per ip, which only a policy an app names in audience.public may do`
				);
		}
	}
}

function visitorRules({ m, at }: RuleContext): void {
	for (const [app, spec] of Object.entries(m.apps)) {
		const aud = spec.audience;
		const publicPolicies: unknown = typeof aud === 'object' ? aud.public : undefined;
		if (!strings(publicPolicies)) continue;
		const policies = publicPolicies.flatMap((p) =>
			m.policies[p] === undefined ? [] : [[p, m.policies[p]] as const]
		);
		visitorShape(m, policies, {
			bad: (p, message) =>
				at('access/visitor-grant', 'policy', p, `public in app '${app}': ${message}`),
			ref: (p, message) => at('access/visitor-ref', 'policy', p, message),
			title: 'visitor',
			forbidden: 'visitor policy',
			creates: 'a public policy of the app',
			missing: (c, col, to) =>
				`${c}.${col}: no public policy of app '${app}' reads ${to}, so every submission would be refused (rule 36)`
		});
	}
}

function kioskRules({ m, bodies, at }: RuleContext): void {
	for (const [kiosk, spec] of Object.entries(m.kiosks ?? {})) {
		const s = spec;
		const policies = strings(spec.policies) ? spec.policies : [];
		for (const p of policies)
			if (m.policies[p] === undefined)
				at('kiosk/policy', 'kiosk', kiosk, `policies: there is no policy '${p}'`);
		if (
			s.auth !== undefined &&
			s.auth !== 'members' &&
			s.auth !== 'external' &&
			s.auth !== 'all' &&
			s.auth !== 'none'
		)
			at('kiosk/auth', 'kiosk', kiosk, `auth is 'members', 'external', 'all' or 'none'`);
		if (Object.keys(s.pages ?? {}).length === 0)
			at('kiosk/pages', 'kiosk', kiosk, 'a kiosk has at least one page');
		// A kiosk's authority is fixed and always on: its policies admit no open-ended grant. Every read,
		// history, create and update lists its fields, and nothing deletes — a removal is an action whose
		// transform refuses outside its scope. Broad grants are unrepresentable here by construction.
		const explicit = (c: string, g: unknown): boolean => {
			const fields = scopeObject(m, c, g)?.fields;
			return strings(fields) && fields.length > 0;
		};
		for (const p of policies) {
			const held = m.policies[p];
			if (held === undefined) continue;
			const narrow = (message: string) =>
				at('access/kiosk-grant', 'policy', p, `kiosk '${kiosk}': ${message}`);
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
			const held = policies.flatMap((p: string) =>
				m.policies[p] === undefined ? [] : [[p, m.policies[p]] as const]
			);
			visitorShape(m, held, {
				bad: (p, message) =>
					at('access/kiosk-grant', 'policy', p, `kiosk '${kiosk}' (auth 'none'): ${message}`),
				ref: (p, message) => at('access/kiosk-ref', 'policy', p, message),
				title: 'public kiosk',
				forbidden: 'public kiosk policy',
				creates: 'a policy of the kiosk',
				missing: (c, col, to) =>
					`${c}.${col}: no policy of kiosk '${kiosk}' reads ${to}, so every submission would be refused (rule 36)`
			});
		}
	}
}

function internalRules({ m, bodies, at }: RuleContext): void {
	for (const [c, spec] of Object.entries(m.collections))
		for (const part of ['queries', 'actions'] as const) {
			for (const [name, x] of Object.entries(spec[part] ?? {})) {
				if (!('internal' in x) || x.internal !== true) continue;
				if (
					!Object.values(m.policies).some((p) => {
						const granted = p.grants[c]?.[part];
						return strings(granted) && granted.includes(name);
					})
				)
					at(
						'access/internal-unreachable',
						'collection',
						c,
						`internal ${part === 'queries' ? 'query' : 'action'} '${name}' is listed by no policy's grants.${c}.${part}`
					);
			}
		}
}

const RULES = [
	workspaceRules,
	modelRules,
	integrationRules,
	automationRules,
	policyRules,
	visitorRules,
	kioskRules,
	internalRules
] as const;

export function checkRules(
	m: EngineManifest,
	bodies: { automations: readonly string[] },
	path: (role: string, name: string) => string
): Finding[] {
	const out: Finding[] = [];
	const at: RuleContext['at'] = (code, role, name, message) =>
		out.push({ code, path: path(role, name), message: `${path(role, name)}: ${message}` });
	for (const rule of RULES) rule({ m, bodies, at });
	return out;
}

function visitorShape(
	m: EngineManifest,
	policies: readonly (readonly [string, EngineManifest['policies'][string]])[],
	options: {
		bad: (policy: string, message: string) => void;
		ref: (policy: string, message: string) => void;
		title: string;
		forbidden: string;
		creates: string;
		missing: (collection: string, column: string, target: string) => string;
	}
): void {
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
		const bad = (message: string) => options.bad(p, message);
		for (const k of ['automations', 'capabilities'] as const)
			if (s[k] !== undefined) bad(`a ${options.forbidden} holds no ${k}`);
		for (const [c, g] of Object.entries(s.grants)) {
			if (c.startsWith('sys_')) {
				bad(`no grant on ${c}`);
				continue;
			}
			for (const k of Object.keys(g))
				if (k !== 'read' && k !== 'create')
					bad(`${c}: a ${options.title} may only read or create, never ${k}`);
			if (g.read !== undefined) {
				const declared = scopeObject(m, c, g.read)?.fields;
				const fields = strings(declared) ? declared : undefined;
				const label = list(m.models[c]?.label);
				if (fields === undefined) bad(`${c}: a ${options.title} read grant lists its fields`);
				else if (label.some((l) => !fields.includes(l)))
					bad(`${c}: the read fields include the label (${label.join(', ')})`);
				if (creates.has(c))
					bad(`${c}: a ${options.title} never reads a collection ${options.creates} creates`);
			}
			if (g.create !== undefined)
				for (const col of m.collections[c]?.create?.input.columns ?? []) {
					const rel = m.relationships[`${c}.${col}`];
					if (rel === undefined || rel.default !== undefined) continue;
					for (const to of list(rel.to))
						if (!reads.has(to)) options.ref(p, options.missing(c, col, to));
				}
		}
	}
}
