// The build checks tsc cannot carry (§3.3.9 "Where each literal is checked", rules 6, 14, 33a, 38, 38d, 50, 52): numeric
// ranges, `seq` patterns, labels naming an id, calendar days declared as instants, state names and reachability, search
// index widths, cron strings, event inputs, rates, IP limits, visitor grants and refs, masked search fields, layer maps
// (a model's read and write layers, a policy's grant layers), syncs (their connection, parsers, cadence and instance), embedding
// origins; and, over the model sources, a write callback reading inside a loop and a notice sent through a connection that
// carries no conversation. Each finding names the declaring file.
import { Array, Predicate, Result } from 'effect';
import ts from 'typescript';
import { LIMITS } from '../../engine/contracts.ts';
import type { EngineManifest, GrantData } from '../../engine/manifest.ts';
import { layerModels } from '../../decl/model.ts';
import { scopeObject } from '../../engine/access/authority.ts';
import { parseRate } from '../../engine/access/rate.ts';
import { sizeBytes } from '../../engine/callables/upload.ts';
import { DRIVERS, type IntegrationSpec } from '../../decl/runtime/integration.ts';
import { SYSTEM } from '../../system/index.ts';
import { clockDefault } from '@norbital-ai/std/vars';

export type Finding = { code: string; path: string; message: string; line?: number };
const isList = <T>(v: T | readonly T[]): v is readonly T[] => Array.isArray(v);
const list = <T>(v: T | readonly T[] | undefined): readonly T[] =>
	v === undefined ? [] : isList<T>(v) ? v : [v];
const OPS = ['create', 'update', 'delete'] as const;
const isOp = (v: string): v is (typeof OPS)[number] => OPS.some((op) => op === v);
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

/** The fields a read grant's root layer admits (an identity grant's beside its `read`); `undefined`: every field. */
const readFields = (c: string, g: GrantData): readonly string[] | undefined => {
	if (g.fields !== undefined) return g.fields;
	const root = Predicate.isObject(g.read) ? g.read[c] : undefined;
	return Predicate.isObject(root) && strings(root.fields) ? root.fields : undefined;
};
/** The columns a create or update grant names on layer `path`; `undefined`: every declared one. */
const grantColumns = (g: GrantData['create'], path: string): readonly string[] | undefined =>
	typeof g === 'object' ? g.columns?.[path] : undefined;
const SYSTEM_COLUMNS = ['id', 'revision', 'created_at', 'created_by', 'updated_at', 'updated_by'];

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
		const { model, match } = signup.party;
		const fields = m.models[model]?.fields;
		if (fields === undefined)
			at(
				'workspace/signup',
				'workspace',
				'workspace',
				`signup: party model '${model}' has no model`
			);
		else
			for (const f of [match.email, match.phone])
				if (f !== undefined && fields[f]?.kind !== 'text')
					at(
						'workspace/signup',
						'workspace',
						'workspace',
						`signup: party match '${model}.${f}' is not a text field`
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

/** Whether an inline value's shape holds a polymorphic ref at any depth. */
const nestedArc = (k: unknown): boolean => {
	if (typeof k !== 'object' || k === null) return false;
	if (Array.isArray(k)) return k.some(nestedArc);
	const o: { readonly [key: string]: unknown } = { ...k };
	if (o['kind'] === 'ref') return Array.isArray(o['to']);
	const values = (v: unknown): readonly unknown[] =>
		typeof v === 'object' && v !== null ? Object.values(v) : [];
	return (
		nestedArc(o['shape']) ||
		nestedArc(o['of']) ||
		nestedArc(o['rest']) ||
		values(o['fields']).some(nestedArc) ||
		values(o['arms']).some((arm) => values(arm).some(nestedArc))
	);
};

function modelRules({ m, bodies, at }: RuleContext): void {
	for (const [model, spec] of Object.entries(m.models)) {
		for (const [f, k] of Object.entries(spec.fields)) {
			const range = (message: string) => at('model/range', 'model', model, `${f}: ${message}`);
			// an arc's `{ model, id }` is stored as `{ collection, id }` only in its own columns: inside an inline value
			// the stored JSON and the API would disagree, so the declaration is refused
			if (nestedArc(k))
				at(
					'model/inline-ref',
					'model',
					model,
					`${f}: a ref to several models (to: [...]) cannot sit inside a json, list, object, record or union value; declare it as its own field`
				);
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
			// a clock default is a `{ var }` the database evaluates per row (`today`, `now + hours(1)`); any other object would
			// be stored as one fixed value, the build day's
			const d: unknown = 'default' in k ? k.default : undefined;
			if (
				(k.kind === 'date' || k.kind === 'instant') &&
				Predicate.isObject(d) &&
				!(Object.keys(d).length === 1 && typeof d['var'] === 'string' && clockDefault(d['var']) !== undefined)
			)
				at(
					'model/default',
					'model',
					model,
					`${f}: a ${k.kind} default is a literal or a clock { var: '${k.kind === 'date' ? 'today' : 'now'}' } (a shift like ' + days(1)'), not ${JSON.stringify(d)}`
				);
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
		// a link in search.text searches the linked row's own search text, so the model it links to must declare one
		for (const f of spec.search?.text ?? []) {
			const rel = m.relationships[`${model}.${f}`];
			const silent = list(rel?.to ?? []).find((to) => !(m.models[to]?.search?.text.length ?? 0));
			if (silent !== undefined)
				at(
					'model/search',
					'model',
					model,
					`search.text '${f}' links to '${silent}', which declares no search.text to match`
				);
		}
		// the search reads each linked row's own search text, and through its links theirs: every link on the way is a
		// layer the model's read declares, read under its policies
		const read = m.exposures[model]?.read;
		const undeclared = (at: string, of: string, seen: readonly string[]): string[] =>
			(m.models[of]?.search?.text ?? []).flatMap((f) => {
				const rel = m.relationships[`${of}.${f}`];
				if (rel === undefined) return [];
				const path = `${at}.${f}`;
				const deeper = list(rel.to).flatMap((to) =>
					seen.includes(to) ? [] : undeclared(path, to, [...seen, to])
				);
				return read?.[path] === undefined ? [path, ...deeper] : deeper;
			});
		if (read !== undefined)
			for (const path of undeclared(model, model, [model]))
				at(
					'model/search',
					'model',
					model,
					`search.text crosses '${path}', a link its read does not declare: add that layer to the read (with the linked model's search fields)`
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
		// a custom index is a hidden vector column with an HNSW index: its width is pgvector's, its rerank page a small multiple
		for (const [index, x] of Object.entries(spec.search?.indexes ?? {})) {
			const range = (message: string) =>
				at('model/range', 'model', model, `search.indexes.${index}: ${message}`);
			if (index === 'semantic')
				range("'semantic' is the platform's meaning search; name the index");
			if (!(Number.isInteger(x.dim) && x.dim >= 1 && x.dim <= 2000)) range('dim is 1 to 2,000');
			if (
				x.candidates !== undefined &&
				!(Number.isInteger(x.candidates) && x.candidates >= 1 && x.candidates <= 16)
			)
				range('candidates is 1 to 16');
			if (x.field !== undefined) {
				const v = spec.fields[x.field];
				if (v?.kind !== 'vector' || v.dim !== x.dim)
					range(`vector '${x.field}' is a vector field of dim ${x.dim}`);
			}
		}
	}
}

/**
 * Layer maps (decision 1): each model's read and write paths resolve segment by segment (`layerModels`); a layer names
 * fields its model has, a write layer only writable columns and never the FK that ties its rows to the layer above
 * (the engine sets it); `filled` stays within `create.columns`. A policy's read and write layers are paths and fields
 * its model declares, and it grants a write verb only beside the model's own.
 */
function layerRules({ m, at }: RuleContext): void {
	const relationships = { ...SYSTEM.relationships, ...m.relationships };
	const modelOf = (name: string) => m.models[name] ?? SYSTEM.models[name];
	const fieldsOf = (model: string): readonly string[] => {
		const spec = modelOf(model);
		return [
			...Object.keys(spec?.fields ?? {}),
			...Object.keys(spec?.computed ?? {}),
			...Object.keys(relationships)
				.filter((k) => k.startsWith(`${model}.`))
				.map((k) => k.slice(model.length + 1)),
			...SYSTEM_COLUMNS
		];
	};
	const writable = (model: string): readonly string[] => {
		const spec = modelOf(model);
		return [
			...Object.entries(spec?.fields ?? {})
				.filter(([, k]) => k.kind !== 'seq' && k.kind !== 'sum' && k.kind !== 'count')
				.map(([f]) => f),
			...Object.keys(relationships)
				.filter((k) => k.startsWith(`${model}.`))
				.map((k) => k.slice(model.length + 1))
		];
	};
	/** The FK on a child layer's model that runs back to the layer above. */
	const backFk = (above: string, rel: string): string | undefined => {
		const key = Object.keys(relationships).find((k) => {
			const r = relationships[k]!;
			return (
				r.inverse === rel && (typeof r.to === 'string' ? r.to === above : r.to.includes(above))
			);
		});
		return key?.slice(key.indexOf('.') + 1);
	};
	const resolved: { [model: string]: { readonly [path: string]: string } } = {};
	for (const [model, c] of Object.entries(m.exposures)) {
		const { models, errors } = layerModels(model, c, relationships);
		resolved[model] = models;
		for (const e of errors) at('model/layer', 'model', model, e);
		const unknown = (
			where: string,
			path: string,
			names: readonly string[],
			known: readonly string[]
		) => {
			for (const f of names)
				if (!known.includes(f))
					at(
						'model/layer',
						'model',
						model,
						`${where}: '${f}' is no ${where === 'read' ? 'field' : 'writable column'} of ${path} (${models[path]})`
					);
		};
		for (const [path, layer] of Object.entries(c.read))
			if (models[path] !== undefined && layer.fields !== 'all')
				unknown('read', path, layer.fields, fieldsOf(models[path]));
		for (const [verb, map] of [
			['create', c.create?.columns],
			['update', c.update?.columns]
		] as const)
			for (const [path, cols] of Object.entries(map ?? {})) {
				const target = models[path];
				if (target === undefined) continue;
				unknown(verb, path, cols, writable(target));
				const dot = path.lastIndexOf('.');
				const fk =
					dot < 0 ? undefined : backFk(models[path.slice(0, dot)] ?? '', path.slice(dot + 1));
				if (fk !== undefined && cols.includes(fk))
					at(
						'model/layer',
						'model',
						model,
						`${verb}: ${path} lists '${fk}', the key the engine sets from its parent row`
					);
			}
		for (const [path, cols] of Object.entries(c.create?.filled ?? {}))
			for (const f of cols)
				if (!(c.create?.columns[path] ?? []).includes(f))
					at(
						'model/layer',
						'model',
						model,
						`create.filled: '${f}' is not among create.columns of ${path}`
					);
	}
	for (const [p, spec] of Object.entries(m.policies))
		for (const [c, g] of Object.entries(spec.grants)) {
			const declared = m.exposures[c] ?? SYSTEM.exposures[c];
			if (declared === undefined) continue;
			const bad = (message: string) => at('access/layer', 'policy', p, `${c}: ${message}`);
			if (Predicate.isObject(g.read) && g.fields === undefined)
				for (const [path, layer] of Object.entries(g.read)) {
					const exposed = declared.read[path];
					if (exposed === undefined) {
						bad(`read names '${path}', which ${c} does not declare as a read layer`);
						continue;
					}
					const fields = Predicate.isObject(layer) && strings(layer.fields) ? layer.fields : [];
					const known =
						exposed.fields === 'all'
							? fieldsOf(resolved[c]?.[path] ?? c)
							: [...exposed.fields, ...SYSTEM_COLUMNS];
					for (const f of fields)
						if (!known.includes(f))
							bad(`read ${path} admits '${f}', which that layer does not expose`);
				}
			for (const verb of ['create', 'update', 'delete'] as const) {
				if (g[verb] === undefined) continue;
				if (declared[verb] === undefined) {
					bad(`${/^[aeiou]/.test(verb) ? 'an' : 'a'} ${verb} grant, but ${c} declares no ${verb}`);
					continue;
				}
				if (verb === 'delete') continue;
				for (const path of Object.keys(
					typeof g[verb] === 'object' ? (g[verb].columns ?? {}) : {}
				)) {
					const own = declared[verb]?.columns[path];
					if (own === undefined)
						bad(`${verb} names '${path}', which ${c}'s ${verb} does not declare`);
					else
						for (const col of grantColumns(g[verb], path) ?? [])
							if (!own.includes(col))
								bad(`${verb} ${path} admits '${col}', which ${c}'s ${verb} does not declare there`);
				}
			}
		}
}

function automationRules({ m, bodies, at }: RuleContext): void {
	for (const [name, a] of Object.entries(m.automations)) {
		const delegated = new Set<string>();
		for (const declaration of a.delegations ?? []) {
			const dot = declaration.verb.lastIndexOf('.'),
				model = declaration.verb.slice(0, dot),
				verb = declaration.verb.slice(dot + 1);
			const grant = m.policies[declaration.policy]?.grants[model];
			const key = declaration.verb + '\0' + declaration.policy;
			if (
				!isOp(verb) ||
				m.exposures[model] === undefined ||
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
			at(
				'automation/no-body',
				'automation',
				name,
				`declare its run body inline: automation('${name}', { …, run: function* (input, ctx) { … } })`
			);
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
				Array.isArray<typeof a.runAs>(a.runAs) &&
				!a.runAs.some((p) => {
					const g = m.policies[p]?.grants[c];
					return g !== undefined && g.read !== undefined;
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
			const fields = readFields(c, g),
				search = m.models[c]?.search?.text ?? [];
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
		// history, create and update lists its fields, and nothing deletes. Broad grants are
		// unrepresentable here by construction.
		const explicit = (
			c: string,
			g: GrantData,
			op: 'read' | 'history' | 'create' | 'update'
		): boolean =>
			((op === 'read'
				? readFields(c, g)
				: op === 'history'
					? scopeObject(m, c, g.history)?.fields
					: grantColumns(g[op], c)
			)?.length ?? 0) > 0;
		for (const p of policies) {
			const held = m.policies[p];
			if (held === undefined) continue;
			const narrow = (message: string) =>
				at('access/kiosk-grant', 'policy', p, `kiosk '${kiosk}': ${message}`);
			for (const [c, g] of Object.entries(held.grants)) {
				if (c.startsWith('sys_')) continue;
				for (const op of ['read', 'history', 'create', 'update'] as const)
					if (g[op] !== undefined && !explicit(c, g, op))
						narrow(`${c}.${op} lists its fields explicitly; a kiosk takes no open grant`);
				if (g.delete !== undefined) narrow(`${c}: a kiosk never deletes`);
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

/** A definition by name: the workspace's, or one of bolt's conversation definitions. */
const definition = (m: EngineManifest, name: string): IntegrationSpec | undefined =>
	m.integrations[name] ?? SYSTEM.integrations[name];
const conversational = (d: IntegrationSpec | undefined): boolean =>
	d !== undefined && 'conversation' in DRIVERS[d.driver];
const BUILTIN_PARSERS = ['xlsx', 'csv', 'tsv', 'json', 'ics'];
const MEDIA_TOPS = [
	'application',
	'audio',
	'font',
	'haptics',
	'image',
	'message',
	'model',
	'multipart',
	'text',
	'video'
];
/** The FK value a ref's `where` pins its `sys_integration` target to (`{ integration: { eq: '<definition>' } }`). */
const pinnedTo = (where: unknown): unknown =>
	Predicate.isObject(where) && Predicate.isObject(where['integration'])
		? where['integration']['eq']
		: undefined;

function syncRules({ m, at }: RuleContext): void {
	for (const [model, c] of Object.entries(m.exposures))
		for (const [name, sync] of Object.entries(c.syncs ?? {})) {
			const bad = (code: string, message: string) =>
				at(`sync/${code}`, 'model', model, `syncs.${name}: ${message}`);
			if (sync.with === 'file') {
				if (sync.every !== undefined || sync.partitions !== undefined)
					bad(
						'file',
						"a file sync runs on upload and export; every and partitions are a remote sync's"
					);
				for (const p of sync.parser ?? [])
					if (typeof p === 'string') {
						if (!BUILTIN_PARSERS.includes(p))
							bad('parser', `'${p}' is no built-in parser (${BUILTIN_PARSERS.join(', ')})`);
					} else {
						const [top = '', sub] = p.type.split('/');
						if (!MEDIA_TOPS.includes(top) || sub === undefined || !/^[\w.+-]+$/.test(sub))
							bad('parser', `'${p.type}' is no registered media type (type/subtype)`);
						if (p.extensions.length === 0 || p.extensions.some((e) => !/^\.[a-z0-9]+$/i.test(e)))
							bad('parser', `a custom parser lists its file extensions ('.ofx')`);
					}
				continue;
			}
			const d = definition(m, sync.with);
			if (d === undefined) {
				bad('with', `with '${sync.with}' is 'file' or an integration definition`);
				continue;
			}
			if (sync.parser !== undefined || sync.schema !== undefined || sync.context !== undefined)
				bad(
					'file',
					"parser, schema and context are a file sync's; a remote read returns rows itself"
				);
			if (sync.every !== undefined && !/^[1-9]\d*(s|min|h|d)$/.test(sync.every))
				bad('every', `'${sync.every}' is not a duration ('15min', '1h')`);
			if (sync.partitions !== undefined && d.configuration?.[sync.partitions] === undefined)
				bad('partitions', `'${sync.partitions}' is no configuration field of '${sync.with}'`);
			// an FK pinned to the definition picks the instance per row; else a write goes through its one named connection
			const pinned = Object.entries(m.relationships).some(
				([key, r]) =>
					key.startsWith(`${model}.`) &&
					r.to === 'sys_integration' &&
					pinnedTo(r.where) === sync.with
			);
			const slots = Object.values(m.connections).filter((x) => x.integration === sync.with).length;
			if (sync.write === true && !pinned && slots !== 1)
				bad(
					'instance',
					`a write goes through one instance of '${sync.with}': pin an FK to sys_integration (where: { integration: { eq: '${sync.with}' } }) or declare exactly one connection of it (there are ${slots})`
				);
		}
}

const ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;
function embedRules({ m, at }: RuleContext): void {
	const origins = (
		code: string,
		role: string,
		name: string,
		list: readonly string[] | undefined
	) => {
		for (const o of list ?? [])
			if (!ORIGIN.test(o))
				at(
					code,
					role,
					name,
					`embed: '${o}' is an origin, https://host[:port] (no path, no wildcard)`
				);
	};
	for (const [kiosk, spec] of Object.entries(m.kiosks ?? {}))
		origins('kiosk/embed', 'kiosk', kiosk, spec.embed);
	for (const [app, spec] of Object.entries(m.apps))
		for (const [page, p] of Object.entries(spec.pages ?? {})) {
			origins('app/embed', 'app', app, p.embed);
			if (p.embed !== undefined && p.portal !== true)
				at(
					'app/embed',
					'app',
					app,
					`page '${page}': only a portal page (portal: true) may be embedded`
				);
		}
}

const RULES = [
	workspaceRules,
	modelRules,
	layerRules,
	automationRules,
	policyRules,
	visitorRules,
	kioskRules,
	syncRules,
	embedRules
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
		missing: (model: string, column: string, target: string) => string;
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
				const fields = readFields(c, g);
				const label = list(m.models[c]?.label);
				if (fields === undefined) bad(`${c}: a ${options.title} read grant lists its fields`);
				else if (label.some((l) => !fields.includes(l)))
					bad(`${c}: the read fields include the label (${label.join(', ')})`);
				if (creates.has(c))
					bad(`${c}: a ${options.title} never reads a model ${options.creates} creates`);
			}
			if (g.create !== undefined)
				for (const col of m.exposures[c]?.create?.columns[c] ?? []) {
					const rel = m.relationships[`${c}.${col}`];
					if (rel === undefined || rel.default !== undefined) continue;
					for (const to of list(rel.to))
						if (!reads.has(to)) options.ref(p, options.missing(c, col, to));
				}
		}
	}
}

const LOOPS = new Set([
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement
]);
const ITERATORS = new Set([
	'map',
	'flatMap',
	'forEach',
	'filter',
	'reduce',
	'some',
	'every',
	'find'
]);
/** The property a function literal is the value of (`transform: function* …`, `*transform(…)`), and its object. */
function slot(fn: ts.Node): { name: string; object: ts.Node } | undefined {
	const at = ts.isMethodDeclaration(fn) ? fn : fn.parent;
	if (at === undefined || !(ts.isPropertyAssignment(at) || ts.isMethodDeclaration(at)))
		return undefined;
	return ts.isIdentifier(at.name) || ts.isStringLiteral(at.name)
		? { name: at.name.text, object: at.parent }
		: undefined;
}
/** The property an object literal is the value of (`create: { … }`). */
const owner = (object: ts.Node): string | undefined =>
	ts.isObjectLiteralExpression(object) &&
	ts.isPropertyAssignment(object.parent) &&
	(ts.isIdentifier(object.parent.name) || ts.isStringLiteral(object.parent.name))
		? object.parent.name.text
		: undefined;
/** `create.transform`, `update.transform` or `delete.check`. */
const writeCallback = (fn: ts.Node): boolean => {
	const s = slot(fn);
	if (s === undefined) return false;
	const verb = owner(s.object);
	return s.name === 'check'
		? verb === 'delete'
		: s.name === 'transform' && (verb === 'create' || verb === 'update');
};
/** `ctx.db.query(…)` or `ctx.db.after(…)`. */
const workspaceRead = (node: ts.Expression): boolean => {
	while (ts.isParenthesizedExpression(node)) node = node.expression;
	if (!ts.isCallExpression(node)) return false;
	const callee = node.expression;
	return (
		ts.isPropertyAccessExpression(callee) &&
		(callee.name.text === 'query' || callee.name.text === 'after') &&
		ts.isPropertyAccessExpression(callee.expression) &&
		callee.expression.name.text === 'db'
	);
};
/** A function passed to an array iteration (`rows.map(…)`, `forEach`, …). */
const iteration = (fn: ts.Node): boolean =>
	ts.isCallExpression(fn.parent) &&
	fn.parent.arguments.some((a) => a === fn) &&
	ts.isPropertyAccessExpression(fn.parent.expression) &&
	ITERATORS.has(fn.parent.expression.name.text);

/**
 * The checks over the model sources (`src/data/model/<m>/+model.ts`), which see what the evaluated literal cannot:
 * `write/read-in-loop`, a `yield*` of `ctx.db.query`/`ctx.db.after` inside a loop or an array iteration in a write callback
 * (a write callback reads at most twice per call, whatever the batch: read once with `{ in }` or a keyed batch, then map);
 * and `notify/via`, a notice's `via` naming anything but a connection of a conversation definition.
 */
export function sourceRules(
	m: EngineManifest,
	sources: readonly { path: string; text: string }[]
): Finding[] {
	const out: Finding[] = [];
	for (const { path, text } of sources) {
		const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const report = (code: string, node: ts.Node, message: string) => {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
			out.push({ code, path, line, message: `${path}:${line}: ${message}` });
		};
		const visit = (node: ts.Node): void => {
			if (
				ts.isYieldExpression(node) &&
				node.asteriskToken !== undefined &&
				node.expression !== undefined &&
				workspaceRead(node.expression)
			) {
				let looped = false;
				for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
					if (LOOPS.has(at.kind)) looped = true;
					if (!ts.isFunctionLike(at)) continue;
					if (writeCallback(at)) {
						if (looped)
							report(
								'write/read-in-loop',
								node,
								"a write callback reads inside a loop over its rows, and a call reads at most twice: read every row's data once (`{ in }` or a keyed batch), then map"
							);
						break;
					}
					if (iteration(at)) looped = true;
				}
			}
			if (
				ts.isPropertyAssignment(node) &&
				ts.isIdentifier(node.name) &&
				node.name.text === 'via' &&
				ts.isArrayLiteralExpression(node.initializer)
			) {
				let notify = false;
				for (let at: ts.Node | undefined = node.parent; at !== undefined && !notify; at = at.parent)
					notify = ts.isFunctionLike(at) && slot(at)?.name === 'notify';
				if (notify)
					for (const e of node.initializer.elements)
						if (
							ts.isStringLiteralLike(e) &&
							!conversational(definition(m, m.connections[e.text]?.integration ?? ''))
						)
							report(
								'notify/via',
								e,
								`a notice goes through a connection of a conversation definition (the inbox always gets it); '${e.text}' is not one`
							);
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	return out;
}
