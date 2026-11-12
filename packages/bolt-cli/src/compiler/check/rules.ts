// The build checks tsc cannot carry (§3.3.9 "Where each literal is checked", rules 6, 14, 33a, 38, 38d, 50, 52): numeric
// ranges, `seq` patterns, labels naming an id, calendar days declared as instants, state names and reachability, search
// index widths, cron strings, event inputs, rates, IP limits, visitor grants and refs, layer maps and outputs
// (a model's read and write layers, a policy's grant layers), syncs (their connection, parsers, cadence and instance), embedding
// origins; and, over the model sources, a write callback reading inside a loop and a notice sent through a connection that
// carries no conversation. Each finding names the declaring file.
import { Array, Predicate, Result } from 'effect';
import { LIMITS, size_bytes } from '@norbital-ai/bolt/engine';
import type { EngineManifest, GrantData } from '@norbital-ai/bolt/engine';
import {
	FieldsSchema,
	layer_models,
	parse_cron,
	parse_rate,
	DRIVERS,
	SYSTEM
} from '@norbital-ai/bolt/tooling';
import { clock_default } from '@norbital-ai/std/vars';
import { label_expression, label_paths } from '@norbital-ai/std/label';

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

const grantedOutputs = (g: GrantData) => Object.entries(g.outputs ?? {});
/** The layer map output `output` of `c` declares (`undefined`: no such output). */
const outputLayers = (m: EngineManifest, c: string, output: string) => {
	const spec = m.exposures[c] ?? SYSTEM.exposures[c];
	return spec?.outputs[output];
};
/** The root fields output `output` of `c` lists; `undefined`: every field (`'all'`) or no such output. */
const outputFields = (
	m: EngineManifest,
	c: string,
	output: string
): readonly string[] | undefined => {
	const fields = outputLayers(m, c, output)?.[c]?.fields;
	return fields === undefined || fields === 'all' ? undefined : fields;
};
/** A read grant whose root `where` scopes to the requestor's own rows: `{ <sys_user ref>: { eq: { var: 'requestor.id' } } }`. */
const ownRows = (
	m: EngineManifest,
	c: string,
	read: NonNullable<GrantData['outputs']>[string]
): boolean => {
	const where = read.scopes?.[c];
	return (
		Predicate.isObject(where) &&
		Object.entries(where).some(
			([f, op]) =>
				list(m.relationships[`${c}.${f}`]?.to).includes('sys_user') &&
				Predicate.isObject(op) &&
				Predicate.isObject(op.eq) &&
				op.eq.var === 'requestor.id'
		)
	);
};
/** The columns a create or update grant names on layer `path`; `undefined`: every declared one. */
const grantColumns = (g: GrantData['create'], path: string): readonly string[] | undefined =>
	g?.columns?.[path];
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
			if (k.kind === 'file' && !(size_bytes(String(k.max)) > 0))
				range('file max is a positive size'); // hook:runtime
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
				const tokens = [...String(k.pattern ?? '{0}').matchAll(/\{([^}]*)\}/g)].map((x) => x[0].slice(1, -1));
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
				for (const [state, rule] of Object.entries(states))
					if (rule.stamp !== undefined && (spec.fields[rule.stamp]?.kind !== 'instant' || spec.fields[rule.stamp]?.many === true))
						at('model/state', 'model', model, `${f}.${state}: stamp '${rule.stamp}' must name one stored instant field`);
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
			const d = 'default' in k ? k.default : undefined;
			if (
				(k.kind === 'date' || k.kind === 'instant') &&
				Predicate.isObject(d) &&
				!(
					Object.keys(d).length === 1 &&
					typeof d['var'] === 'string' &&
					clock_default(d['var']) !== undefined
				)
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
		const identifier = spec.record_label;
		if (typeof identifier === 'string') {
			const program = label_expression(identifier);
			if ('error' in program) at('model/label', 'model', model, program.error);
		}
		for (const l of label_paths(identifier)) {
			const [field = l, ...tail] = l.split('.');
			const relation = m.relationships[`${model}.${field}`];
			if (relation === undefined) {
				if (spec.fields[field] === undefined && spec.computed?.[field] === undefined && field !== 'id')
					at('model/label', 'model', model, `label reads unknown field '${l}'`);
				const kind = spec.fields[field];
				if (tail.length > 0 && kind?.kind === 'ref' && kind.many === true)
					at('model/label', 'model', model, `label '${l}' must follow a to-one relation`);
			} else if (tail.length > 0) {
				const targets = list(relation.to), target = targets[0], leaf = tail[0];
				if (targets.length !== 1 || target === undefined) {
					at('model/label', 'model', model, `label '${l}' must follow a single-target to-one relation`);
					continue;
				}
				const own = m.models[target] ?? SYSTEM.models[target];
				if (leaf === undefined || (own?.fields[leaf] === undefined && own?.computed?.[leaf] === undefined && leaf !== 'id'))
					at('model/label', 'model', model, `label reads unknown field '${l}'`);
				if (leaf !== undefined && tail.length > 1 && (m.relationships[`${target}.${leaf}`] ?? SYSTEM.relationships[`${target}.${leaf}`]) !== undefined)
					at('model/label', 'model', model, `label '${l}' crosses more than one relation`);
			}
			if (l === 'id' || m.relationships[`${model}.${l}`] !== undefined)
				at(
					'model/label',
					'model',
					model,
					`label '${l}' is ${l === 'id' ? 'the row id' : 'a foreign key'}; label with the row's own text fields (a computed field may join them)`
				);
		}
		// a link in search.text searches the linked row's own search text, so the model it links to must declare one
		for (const f of spec.search?.text ?? []) {
			const rel = m.relationships[`${model}.${f}`];
			const silent = list(rel?.to ?? []).find((to) => {
				const target = m.models[to] ?? SYSTEM.models[to];
				return (
					target === undefined ||
					(target.record_label === undefined && !(target.search?.text.length ?? 0))
				);
			});
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
		const read = m.exposures[model]?.outputs.default;
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
 * Layer maps (decision 1): each model's read and write paths resolve segment by segment (`layer_models`); a layer names
 * fields its model has, a write layer only writable columns and never the FK that ties its rows to the layer above
 * (the engine sets it); `filled` stays within `create.columns`. A policy grants
 * outputs its model declares and filters only their paths, and it grants a write verb only beside the model's own.
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
		const entry = Object.entries(relationships).find(([, r]) => {
			return (
				r.inverse === rel && (typeof r.to === 'string' ? r.to === above : r.to.includes(above))
			);
		});
		return entry?.[0].slice(entry[0].indexOf('.') + 1);
	};
	const resolved: { [model: string]: { readonly [path: string]: string } } = {};
	for (const [model, c] of Object.entries(m.exposures)) {
		const { models, errors } = layer_models(model, c, relationships);
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
						`${where}: '${f}' is no ${where.startsWith('outputs.') ? 'field' : 'writable column'} of ${path} (${models[path]})`
					);
		};
		for (const [output, read] of Object.entries(c.outputs))
			for (const [path, layer] of Object.entries(read))
				if (models[path] !== undefined && layer.fields !== 'all')
					unknown(`outputs.${output}`, path, layer.fields, fieldsOf(models[path]));
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
			for (const [output, read] of grantedOutputs(g)) {
				const layers = outputLayers(m, c, output);
				if (layers === undefined) {
					bad(`grants output '${output}', which ${c} does not declare`);
					continue;
				}
				for (const path of Object.keys(read.scopes ?? {}))
					if (layers[path] === undefined)
						bad(
							`outputs.${output} names '${path}', which that output does not declare as a read layer`
						);
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

/** Rule 38: a rate admits at least one request per window. */
const validRate = (rate: string): boolean => {
	const parsed = Result.try(() => {
		const r = parse_rate(rate);
		return Number.isInteger(r.limit) && r.limit > 0 && r.windowMs > 0;
	});
	return Result.isSuccess(parsed) && parsed.success;
};

function automationRules({ m, bodies, at }: RuleContext): void {
	for (const [name, a] of Object.entries(m.automations)) {
		// a run holds exactly its declared policies: at least one, each declared
		const policies: readonly unknown[] = Array.isArray(a.policies) ? a.policies : [];
		if (policies.length === 0)
			at(
				'automation/policies',
				'automation',
				name,
				'policies: name at least one policy the run holds'
			);
		for (const p of policies)
			if (typeof p !== 'string' || m.policies[p] === undefined)
				at(
					'automation/policies',
					'automation',
					name,
					`policies: there is no policy '${String(p)}'`
				);
		for (const [field, kind] of Object.entries(a.input ?? {})) {
			if (kind.kind !== 'rows') continue;
			const model = m.exposures[kind.of] ?? SYSTEM.exposures[kind.of];
			if (kind.of === 'sys_run' || model === undefined)
				at('automation/rows', 'automation', name, `input.${field}: '${kind.of}' is no readable model`);
			else if (!a.policies.some((policy) => m.policies[policy]?.grants[kind.of]?.outputs?.['default'] !== undefined))
				at('automation/rows', 'automation', name, `input.${field}: the automation's policies must grant ${kind.of}'s default output`);
		}
		if (!bodies.automations.includes(name))
			at(
				'automation/no-body',
				'automation',
				name,
				'declare its run body inline: automation({ …, run: function* (input, ctx) { … } })'
			);
		for (const on of a.on ?? []) {
			if (!('cron' in on)) continue;
			const parsed = parse_cron(on.cron, on.tz ?? m.workspace.tz);
			if (Result.isFailure(parsed))
				at('automation/cron', 'automation', name, `'${on.cron}': ${parsed.failure.message}`);
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
	for (const [p, spec] of Object.entries(m.policies)) {
		for (const automation of spec.capabilities?.automations ?? [])
			if (m.automations[automation] === undefined)
				at('access/automation', 'policy', p, `'${automation}' is not an automation; manual sync controls use capabilities.syncs`);
		for (const key of spec.capabilities?.syncs ?? []) {
			const dot = key.lastIndexOf('.'), model = key.slice(0, dot), sync = key.slice(dot + 1);
			const entry = m.exposures[model]?.syncs?.[sync];
			if (dot < 1 || entry === undefined || entry.with === 'file' || entry.read !== true)
				at('access/sync', 'policy', p, `'${key}' is not a remote read sync (model.sync_name)`);
		}
		for (const [key, v] of Object.entries(spec.limits ?? {})) {
			// rule 38: a rate admits at least one request per window
			for (const x of list(v)) {
				const rate = String(Predicate.isObject(x) ? x.rate : x);
				if (!validRate(rate))
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
		if (spec.shell === 'kiosk') continue;
		const aud = spec.audience;
		const publicPolicies: unknown = typeof aud === 'object' ? aud.public : undefined;
		if (!strings(publicPolicies)) continue;
		for (const p of publicPolicies)
			if (m.policies[p] === undefined)
				at('app/public-policy', 'app', app, `audience.public: there is no policy '${p}'`);
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
	for (const [kiosk, s] of Object.entries(m.apps)) {
		if (s.shell !== 'kiosk') continue;
		const isPublic = typeof s.audience === 'object';
		const declared = isPublic ? s.audience.public : s.policies;
		const policies = strings(declared) ? declared : [];
		if (policies.length === 0)
			at('kiosk/policy', 'app', kiosk, 'a kiosk declares the policies it runs under');
		for (const p of policies)
			if (m.policies[p] === undefined)
				at('kiosk/policy', 'app', kiosk, `policies: there is no policy '${p}'`);
		if (Object.keys(s.pages ?? {}).length === 0)
			at('kiosk/pages', 'app', kiosk, 'a kiosk has at least one page');
		// A kiosk's authority is fixed and always on: its policies admit no open-ended grant. Every output it reads
		// lists its fields (a narrow named output; its history shows the same), every create and update lists its
		// columns, and nothing deletes.
		for (const p of policies) {
			const held = m.policies[p];
			if (held === undefined) continue;
			const narrow = (message: string) =>
				at('access/kiosk-grant', 'policy', p, `kiosk '${kiosk}': ${message}`);
			for (const [c, g] of Object.entries(held.grants)) {
				if (c.startsWith('sys_')) continue;
				for (const [output] of grantedOutputs(g))
					if (outputFields(m, c, output) === undefined)
						narrow(
							`${c}: output '${output}' reads every field; a kiosk reads a named output that lists its fields`
						);
				for (const op of ['create', 'update'] as const)
					if (g[op] !== undefined && (grantColumns(g[op], c)?.length ?? 0) === 0)
						narrow(`${c}.${op} lists its columns explicitly; a kiosk takes no open grant`);
				if (g.delete !== undefined) narrow(`${c}: a kiosk never deletes`);
			}
		}
		// audience 'external': every signed-in external opens it, so its policies are their portal authority and never
		// open apps, kiosks or agent tools beyond it
		if (s.audience === 'external')
			for (const p of policies)
				if (m.policies[p]?.capabilities !== undefined)
					at(
						'access/kiosk-grant',
						'policy',
						p,
						`kiosk '${kiosk}' (audience 'external'): a portal policy holds no capabilities`
					);
		// A public kiosk is open with no requestor policy, so its assigned policies run
		// envoy-style inside — they hold the same visitor shape as a public app's policies.
		if (isPublic) {
			const held = policies.flatMap((p: string) =>
				m.policies[p] === undefined ? [] : [[p, m.policies[p]] as const]
			);
			visitorShape(m, held, {
				bad: (p, message) =>
					at('access/kiosk-grant', 'policy', p, `kiosk '${kiosk}' (public audience): ${message}`),
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

type IntegrationSpec = EngineManifest['integrations'][string];
/** A definition by name: the workspace's, or one of bolt's conversation definitions. */
const definition = (m: EngineManifest, name: string): IntegrationSpec | undefined =>
	m.integrations[name] ?? SYSTEM.integrations[name];
const conversational = (d: IntegrationSpec | undefined): boolean =>
	d !== undefined && 'conversation' in DRIVERS[d.driver];
const BUILTIN_PARSERS = ['xlsx', 'csv', 'tsv', 'json', 'ics', 'txt'];
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
		}
}

const ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;
function embedRules({ m, at }: RuleContext): void {
	for (const [app, spec] of Object.entries(m.apps))
		for (const origin of spec.embed ?? [])
			if (!ORIGIN.test(origin))
				at(
					'app/embed',
					'app',
					app,
					`embed: '${origin}' is an origin, https://host[:port] (no path, no wildcard)`
				);
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
				.filter(([, g]) => grantedOutputs(g).length > 0)
				.map(([c]) => c)
		)
	);
	for (const [p, s] of policies) {
		const bad = (message: string) => options.bad(p, message);
		if (s.capabilities !== undefined) bad(`a ${options.forbidden} holds no capabilities`);
		for (const [c, g] of Object.entries(s.grants)) {
			if (c.startsWith('sys_')) {
				bad(`no grant on ${c}`);
				continue;
			}
			for (const k of Object.keys(g))
				if (k !== 'outputs' && k !== 'create')
					bad(`${c}: a ${options.title} may only read or create, never ${k}`);
			for (const [output, read] of grantedOutputs(g)) {
				const fields = outputFields(m, c, output);
				const label = label_paths(m.models[c]?.record_label).map(
					(path) => path.split('.')[0] ?? path
				);
				if (fields === undefined)
					bad(
						`${c}: output '${output}' reads every field; a ${options.title} reads a named output that lists its fields`
					);
				else if (label.some((l) => !fields.includes(l)))
					bad(`${c}: output '${output}' lists the label (${label.join(', ')})`);
				// an anonymous visitor reads back only what it owns: a `sys_user` ref holding `requestor.id`
				if (creates.has(c) && !ownRows(m, c, read))
					bad(
						`${c}: a ${options.title} reads a model ${options.creates} creates only where a sys_user ref eq requestor.id`
					);
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
