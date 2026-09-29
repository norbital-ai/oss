// The build checks tsc cannot carry (§3.3.9 "Where each literal is checked", rules 6, 14, 33a, 38, 38d, 50, 52): numeric
// ranges, `seq` patterns, state names and reachability, cron strings, approval step counts, event inputs, rates, IP limits, visitor grants and
// refs, masked search fields, write grants over child rows and unreachable internal callables. Each finding names the declaring file.
import { LIMITS, type EngineManifest } from '../../engine/contracts.ts';
import { parseRate } from '../../engine/access/rate.ts';
import { sizeBytes } from '../../engine/callables/upload.ts';

export type Finding = { code: string; path: string; message: string };
type Obj = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = <T>(v: T | readonly T[] | undefined): readonly T[] => v === undefined ? [] : Array.isArray(v) ? v : [v as T];

const DATE_UNITS = ['year', 'month', 'week', 'day'];
const MACROS = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly'];
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
/** Five fields (minute hour day month weekday) of `*`, numbers, ranges, lists and steps, or a macro. ponytail: no month or day names. */
export function cronValid(s: string): boolean {
	if (MACROS.includes(s)) return true;
	const fields = s.trim().split(/\s+/);
	return fields.length === 5 && fields.every((field, i) => field.split(',').every((part) => {
		const [range = '', step] = part.split('/');
		if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
		if (range === '*') return true;
		const [lo, hi] = RANGES[i]!, [a = '', b] = range.split('-');
		const n = (x: string) => /^\d+$/.test(x) && Number(x) >= lo && Number(x) <= hi;
		return n(a) && (b === undefined || (n(b) && Number(a) <= Number(b)));
	}));
}

/** A grant value that is `{ where?, fields?, previous?, approval? }` (not a bare `Where` on a field of that name). */
const scopeObject = (m: EngineManifest, c: string, g: unknown): Obj | undefined =>
	isObj(g) && Object.keys(g).length > 0 && Object.keys(g).every((k) => ['where', 'fields', 'previous', 'approval'].includes(k) && m.models[c]?.fields[k] === undefined) ? g : undefined;

/** The first many-relation a `Where` on `c` crosses, through `and`/`or`/`not`, one-relation `is` and polymorphic arms. */
function manyIn(m: EngineManifest, c: string, w: unknown): string | undefined {
	if (!isObj(w)) return undefined;
	for (const [k, v] of Object.entries(w)) {
		const hit = k === 'and' || k === 'or' ? list(v as unknown[]).map((x) => manyIn(m, c, x)).find((x) => x !== undefined)
			: k === 'not' ? manyIn(m, c, v)
			: Object.values(m.relationships).some((r) => r.inverse === k && [r.to].flat().includes(c)) ? k
			: m.relationships[`${c}.${k}`] === undefined || !isObj(v) ? undefined
			: [m.relationships[`${c}.${k}`]!.to].flat().map((t) => manyIn(m, t, 'is' in v ? v.is : v[t])).find((x) => x !== undefined);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

export function buildChecks(m: EngineManifest, bodies: { automations: readonly string[] }, path: (role: string, name: string) => string): Finding[] {
	const out: Finding[] = [];
	const at = (code: string, role: string, name: string, message: string) => out.push({ code, path: path(role, name), message: `${path(role, name)}: ${message}` });

	for (const [model, spec] of Object.entries(m.models)) {
		for (const [f, k] of Object.entries(spec.fields) as [string, Obj & { kind: string }][]) {
			const range = (message: string) => at('model/range', 'model', model, `${f}: ${message}`);
			if (k.kind === 'vector' && !(Number.isInteger(k.dim) && Number(k.dim) >= 1 && Number(k.dim) <= 2000)) range('vector dim is 1 to 2,000');
			if (k.kind === 'text' && k.max !== undefined && !(Number.isInteger(k.max) && Number(k.max) > 0)) range('text max is a positive integer');
			if (k.kind === 'file' && !(sizeBytes(String(k.max)) > 0 && sizeBytes(String(k.max)) <= LIMITS.storedFileBytes)) range('file max is at most 20MiB'); // hook:runtime
			// a precision the kind cannot hold (a JS manifest or a cast: tsc refuses it in a declaration)
			const units = k.kind === 'date' || (k.kind === 'period' && k.of === 'date') ? DATE_UNITS : k.kind === 'instant' || k.kind === 'period' ? [...DATE_UNITS, 'hour', 'minute']
				: k.kind === 'time' ? ['hour', 'minute'] : [];
			if (k.precision !== undefined && !units.includes(String(k.precision)))
				at('model/precision', 'model', model, `${f}: a ${k.kind === 'period' ? `${String(k.of)} period` : k.kind} takes ${units.length === 0 ? 'no precision' : `precision ${units.join(', ')}`}`);
			if (k.min !== undefined && k.max !== undefined && typeof k.min === 'number' && Number(k.min) > Number(k.max)) range('min is above max');
			if (k.kind === 'seq') {
				const tokens = [...String(k.pattern ?? '{0}').matchAll(/\{([^}]*)\}/g)].map((x) => x[1]!);
				if (tokens.filter((t) => /^0+$/.test(t)).length !== 1 || tokens.some((t) => !/^(0+|yyyy|yy|mm)$/.test(t)))
					at('model/seq', 'model', model, `${f}: a seq pattern holds one {0…} counter and only {yyyy} {yy} {mm} besides`);
				for (const p of list(k.per as string | readonly string[] | undefined))
					if (spec.fields[p] === undefined && m.relationships[`${model}.${p}`] === undefined) at('model/seq', 'model', model, `${f}: per '${p}' is not a field`);
			}
			if (k.kind === 'state') {
				const states = k.states as { readonly [s: string]: { to?: readonly string[] } };
				if (!Object.hasOwn(states, String(k.initial))) at('model/state', 'model', model, `${f}: initial '${String(k.initial)}' is not one of its states (${Object.keys(states).join(', ')})`);
				for (const [s, x] of Object.entries(states)) for (const to of x.to ?? [])
					if (!Object.hasOwn(states, to)) at('model/state', 'model', model, `${f}: '${s}' moves to '${to}', which is not a state`);
				// rule 41, §5.5: every state is reachable from `initial` along `to` edges (an unreachable state's edges are dead)
				const seen = new Set([String(k.initial)]);
				for (const s of seen) for (const to of states[s]?.to ?? []) seen.add(to);
				for (const s of Object.keys(states)) if (!seen.has(s)) at('model/state', 'model', model, `${f}: '${s}' is unreachable from '${String(k.initial)}'`);
			}
		}
		// the embedding column's width, stated: a guess would have to match the host's model class, which it cannot know
		const sem = (spec.search as { semantic?: { dim?: unknown } } | undefined)?.semantic;
		if (sem !== undefined && !(Number.isInteger(sem.dim) && Number(sem.dim) >= 1 && Number(sem.dim) <= 2000))
			at('model/range', 'model', model, `search.semantic: dim is 1 to 2,000 (the embedding column's width, and the width every probe asks the model for)`);
	}

	for (const [name, a] of Object.entries(m.automations)) {
		if (!bodies.automations.includes(name)) at('automation/no-body', 'automation', name, 'attach the run body with a.run(…)');
		for (const on of list(a.on) as Obj[]) {
			if (typeof on.cron === 'string' && !cronValid(on.cron)) at('automation/cron', 'automation', name, `'${on.cron}' is not 5 cron fields or a macro`);
			const c = (on.created ?? on.updated ?? on.deleted) as string | undefined;
			if (c === undefined) continue;
			const ids = a.input?.ids as Obj | undefined;
			if (a.input !== undefined && !(ids?.kind === 'list' && ids.optional === true && isObj(ids.of) && ids.of.kind === 'id' && ids.of.of === c))
				at('automation/event-input', 'automation', name, `an automation with both on and input declares ids: { kind: 'list', of: { kind: 'id', of: '${c}' }, optional: true } in its input`);
			if (Array.isArray(a.runAs) && !a.runAs.some((p) => { const g = m.policies[p]?.grants[c]; return g !== undefined && (g.read !== undefined || g.via !== undefined); }))
				at('automation/runas-read', 'automation', name, `its runAs policies cannot read '${c}', which triggers it`);
		}
	}

	const publicOf = new Map<string, string[]>();   // policy → apps naming it in audience.public
	for (const [app, spec] of Object.entries(m.apps)) {
		const aud = (spec as { audience?: unknown }).audience;
		if (isObj(aud) && Array.isArray(aud.public)) for (const p of aud.public as string[]) publicOf.set(p, [...publicOf.get(p) ?? [], app]);
	}
	for (const [p, spec] of Object.entries(m.policies)) {
		for (const [c, g] of Object.entries(spec.grants)) {
			for (const op of ['create', 'update', 'delete'] as const) for (const route of list(scopeObject(m, c, g[op])?.approval) as Obj[]) {
				const steps = route.steps as readonly (readonly string[])[] | undefined ?? [];
				if (steps.length === 0 || steps.length > 8 || steps.some((s) => s.length === 0))
					at('approval/steps', 'policy', p, `${c}.${op}: an approval has 1 to 8 steps, each naming a team`);
			}
			// a write is judged on the rows it names, in the act: its grant cannot scope through child rows (`write/act.ts` refuses it)
			for (const op of ['create', 'update', 'delete'] as const) {
				const s = scopeObject(m, c, g[op]), rel = manyIn(m, c, s === undefined ? g[op] : s.where) ?? manyIn(m, c, s?.previous);
				if (rel !== undefined) at('access/write-many', 'policy', p, `${c}.${op}: a write grant cannot scope through the many-relation '${rel}'; refuse it in the collection's transform`);
			}
			const read = scopeObject(m, c, g.read), search = m.models[c]?.search?.text ?? [];
			const fields = read?.fields as readonly string[] | undefined;
			const hidden = fields === undefined ? undefined : search.find((f) => !fields.includes(f));
			if (hidden !== undefined) at('access/masked-search', 'policy', p, `${c}: the read grant masks '${hidden}', a searchable field (rule 14)`);
		}
		for (const [key, v] of Object.entries(spec.limits ?? {})) {
			// rule 38: a rate admits at least one request per window
			for (const x of list(v as unknown)) {
				const rate = String(isObj(x) ? x.rate : x);
				let ok = false;
				try { const r = parseRate(rate); ok = Number.isInteger(r.limit) && r.limit > 0 && r.windowMs > 0; } catch { /* unparsable */ }
				if (!ok) at('access/limit', 'policy', p, `limit '${key}': '${rate}' is not a positive count per window`);
			}
			if (list(v as unknown).some((x) => isObj(x) && x.per === 'ip') && !publicOf.has(p))
				at('access/ip-limit', 'policy', p, `limit '${key}' counts per ip, which only a policy an app names in audience.public may do`);
		}
	}

	for (const [app, spec] of Object.entries(m.apps)) {
		const aud = (spec as { audience?: unknown }).audience;
		if (!isObj(aud) || !Array.isArray(aud.public)) continue;
		const policies = (aud.public as string[]).flatMap((p) => m.policies[p] === undefined ? [] : [[p, m.policies[p]!] as const]);
		const creates = new Set(policies.flatMap(([, s]) => Object.entries(s.grants).filter(([, g]) => g.create !== undefined).map(([c]) => c)));
		const reads = new Set(policies.flatMap(([, s]) => Object.entries(s.grants).filter(([, g]) => g.read !== undefined).map(([c]) => c)));
		for (const [p, s] of policies) {
			const bad = (message: string) => at('access/visitor-grant', 'policy', p, `public in app '${app}': ${message}`);
			for (const k of ['automations', 'capabilities'] as const) if (s[k] !== undefined) bad(`a visitor policy holds no ${k}`);
			for (const [c, g] of Object.entries(s.grants)) {
				if (c.startsWith('sys_')) { bad(`no grant on ${c}`); continue; }
				for (const k of Object.keys(g)) if (k !== 'read' && k !== 'create') bad(`${c}: a visitor may only read or create, never ${k}`);
				if (g.read !== undefined) {
					const fields = scopeObject(m, c, g.read)?.fields as readonly string[] | undefined;
					const label = list(m.models[c]?.label as string | readonly string[] | undefined);
					if (fields === undefined) bad(`${c}: a visitor read grant lists its fields`);
					else if (label.some((l) => !fields.includes(l))) bad(`${c}: the read fields include the label (${label.join(', ')})`);
					if (creates.has(c)) bad(`${c}: a visitor never reads a collection a public policy of the app creates`);
				}
				if (g.create !== undefined) for (const col of m.collections[c]?.create?.input.columns ?? []) {
					const rel = m.relationships[`${c}.${col}`];
					if (rel === undefined || rel.default !== undefined) continue;
					for (const to of list(rel.to)) if (!reads.has(to))
						at('access/visitor-ref', 'policy', p, `${c}.${col}: no public policy of app '${app}' reads ${to}, so every submission would be refused (rule 36)`);
				}
			}
		}
	}

	for (const [c, spec] of Object.entries(m.collections)) for (const part of ['queries', 'actions'] as const) {
		for (const [name, x] of Object.entries(spec[part] ?? {}) as [string, { internal?: true }][]) {
			if (x.internal !== true) continue;
			if (!Object.values(m.policies).some((p) => (p.grants[c]?.[part] as readonly string[] | undefined ?? []).includes(name)))
				at('access/internal-unreachable', 'collection', c, `internal ${part === 'queries' ? 'query' : 'action'} '${name}' is listed by no policy's grants.${c}.${part}`);
		}
	}
	return out;
}
