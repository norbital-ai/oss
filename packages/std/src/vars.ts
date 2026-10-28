// std/vars: a filter value's `{ var: '<CEL>' }`, a typed expression over the requestor (`requestor.id`,
// `requestor.teams`, `requestor.scopes.<policy>` …) and the clock (`today`, a date; `now`, an instant), evaluated once
// per read and never per row: `today - days(7)`, `startOfMonth(today)`, `now - hours(1)`. Helpers: minutes, hours,
// days, weeks, months and years spans (`±` on a date or an instant), and startOfWeek/Month/Quarter/Year of a date.
import { Environment, type ParseResult } from '@marcbachmann/cel-js';
import * as Result from 'effect/Result';
import { addDays, addMonths, PlainDate } from './date.ts';
import type { Json } from './wire.ts';

/** A calendar day inside an expression. */
class Day {
	readonly iso: string;
	constructor(iso: string) {
		this.iso = PlainDate(iso);
	}
}
/** A shift: whole months, whole days and milliseconds. */
class Span {
	readonly months: number;
	readonly days: number;
	readonly ms: number;
	constructor(months: number, days: number, ms: number) {
		this.months = months;
		this.days = days;
		this.ms = ms;
	}
}
/** What the requestor variables read; a missing one is null. */
export type Requestor = {
	readonly id: string | null;
	readonly email: string | null;
	readonly phone: string | null;
	readonly party: string | null;
	readonly visitor: string | null;
	readonly instance: string | null;
	readonly teams: readonly string[];
	readonly teamTree: readonly string[];
	readonly scopes: { readonly [policy: string]: readonly string[] };
};
/** The values an expression reads: the clock, and the requestor where it is known. */
export type VarValues = {
	readonly today?: string;
	readonly now?: string;
	readonly requestor?: Requestor;
};
/** The kind of value a filter position takes. */
export type VarResult = 'text' | 'date' | 'instant' | 'list';
/** What a filter position's field is, as the admission of requestor members reads it. */
export type VarField = {
	readonly kind: string;
	readonly of?: string | undefined;
	readonly email?: boolean | undefined;
	readonly phone?: boolean | undefined;
	readonly team?: boolean | undefined;
};
/** Whether `f` may compare with requestor member `m` (`scopes.<policy>` in a list position). */
export function memberAdmits(f: VarField, m: string): boolean {
	if (m.startsWith('scopes.')) return f.kind === 'id';
	switch (m) {
		case 'teams':
		case 'teamTree':
			return f.team === true;
		case 'email':
			return f.email === true;
		case 'phone':
			return f.phone === true;
		// a requestor id is text too: ported grants compare `{ var: 'requestor.id' }` with a text column
		case 'id':
			return f.of === 'sys_user' || f.kind === 'text';
		case 'party':
			return f.kind === 'id';
		case 'visitor':
			return f.kind === 'text';
		case 'instance':
			return f.of === 'sys_integration';
		default:
			return false;
	}
}

const n = (x: unknown) => Number(x);
const shift = (d: Day, s: Span, sign: number): Day => {
	if (s.ms !== 0) throw new RangeError('a date shifts by whole days, weeks, months or years');
	return new Day(addDays(addMonths(d.iso, sign * s.months), sign * s.days));
};
const instant = (t: Date, s: Span, sign: number): Date => {
	const at = new Date(t.getTime());
	at.setUTCMonth(at.getUTCMonth() + sign * s.months);
	return new Date(at.getTime() + sign * (s.days * 86_400_000 + s.ms));
};
const env = new Environment({ homogeneousAggregateLiterals: false })
	.registerType('Date', Day)
	.registerType('Span', Span)
	.registerVariable({
		name: 'requestor',
		schema: {
			id: 'string',
			email: 'string',
			phone: 'string',
			party: 'string',
			visitor: 'string',
			instance: 'string',
			teams: 'list<string>',
			teamTree: 'list<string>',
			scopes: 'map<string, list<string>>'
		}
	})
	.registerVariable('today', 'Date')
	.registerVariable('now', 'google.protobuf.Timestamp')
	.registerFunction('minutes(int): Span', (x) => new Span(0, 0, n(x) * 60_000))
	.registerFunction('hours(int): Span', (x) => new Span(0, 0, n(x) * 3_600_000))
	.registerFunction('days(int): Span', (x) => new Span(0, n(x), 0))
	.registerFunction('weeks(int): Span', (x) => new Span(0, 7 * n(x), 0))
	.registerFunction('months(int): Span', (x) => new Span(n(x), 0, 0))
	.registerFunction('years(int): Span', (x) => new Span(12 * n(x), 0, 0))
	.registerFunction('startOfWeek(Date): Date', (d) => {
		const iso = (d as Day).iso;
		return new Day(addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7)));
	})
	.registerFunction('startOfMonth(Date): Date', (d) => new Day(`${(d as Day).iso.slice(0, 7)}-01`))
	.registerFunction('startOfQuarter(Date): Date', (d) => {
		const iso = (d as Day).iso,
			m = Number(iso.slice(5, 7));
		return new Day(`${iso.slice(0, 4)}-${String(m - ((m - 1) % 3)).padStart(2, '0')}-01`);
	})
	.registerFunction(
		'startOfYear(Date): Date',
		(d) => new Day(`${(d as Day).iso.slice(0, 4)}-01-01`)
	)
	.registerOperator('Date + Span', (d, s) => shift(d as Day, s as Span, 1))
	.registerOperator('Date - Span', (d, s) => shift(d as Day, s as Span, -1))
	.registerOperator('google.protobuf.Timestamp + Span', (t, s) => instant(t as Date, s as Span, 1))
	.registerOperator('google.protobuf.Timestamp - Span', (t, s) =>
		instant(t as Date, s as Span, -1)
	);

const CEL: { readonly [R in VarResult]: string } = {
	text: 'string',
	date: 'Date',
	instant: 'google.protobuf.Timestamp',
	list: 'list<string>'
};
/** A checked expression: its program, its type and what it reads. */
export type CompiledVar = {
	readonly text: string;
	readonly program: ParseResult;
	/** It reads `today` or `now`: the edge evaluates it before a read. */
	readonly time: boolean;
	/** The requestor members it reads (`scopes.<policy>` names its policy). */
	readonly requestor: readonly string[];
	/** The one member it is (`requestor.email`), read directly so a missing value is null. */
	readonly member: string | undefined;
};
type Node = { readonly op: string; readonly args: unknown };
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && 'op' in v;
/** The identifiers and requestor member paths an AST reads. */
function reads(node: unknown, out: { ids: Set<string>; requestor: Set<string> }): void {
	if (Array.isArray(node)) return node.forEach((x) => reads(x, out));
	if (!isNode(node)) return;
	if (node.op === 'id' && typeof node.args === 'string') return void out.ids.add(node.args);
	if (node.op === '.' && Array.isArray(node.args)) {
		const [obj, prop] = node.args;
		if (isNode(obj) && obj.op === 'id' && obj.args === 'requestor' && typeof prop === 'string') {
			out.ids.add('requestor');
			return void out.requestor.add(prop);
		}
		if (
			isNode(obj) &&
			obj.op === '.' &&
			Array.isArray(obj.args) &&
			isNode(obj.args[0]) &&
			obj.args[0].op === 'id' &&
			obj.args[0].args === 'requestor' &&
			obj.args[1] === 'scopes' &&
			typeof prop === 'string'
		) {
			out.ids.add('requestor');
			return void out.requestor.add(`scopes.${prop}`);
		}
	}
	reads(node.args, out);
}
const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
const cache = new Map<string, CompiledVar | { readonly error: string }>();

/** Checks `text` for a position taking `result` (any type when absent): the program, or the syntax or type fault. */
export function compileVar(
	text: string,
	result?: VarResult
): CompiledVar | { readonly error: string } {
	const key = `${result ?? ''}\u0000${text}`,
		hit = cache.get(key);
	if (hit !== undefined) return hit;
	const parsed = Result.try(() => env.parse(text));
	let out: CompiledVar | { readonly error: string };
	if (Result.isFailure(parsed)) out = { error: first(parsed.failure) };
	else {
		const checked = env.check(text);
		const type = checked.valid ? (checked.type ?? 'dyn') : undefined;
		if (!checked.valid) out = { error: first(checked.error) };
		else if (result !== undefined && type !== CEL[result])
			out = {
				error: `'${text}' is a ${type}, not a ${result === 'list' ? 'list of text' : result}`
			};
		else {
			const seen = { ids: new Set<string>(), requestor: new Set<string>() };
			reads(parsed.success.ast, seen);
			const only = [...seen.requestor][0];
			out = {
				member:
					only !== undefined && text.replaceAll(' ', '') === `requestor.${only}` ? only : undefined,
				text,
				program: parsed.success,
				time: seen.ids.has('today') || seen.ids.has('now'),
				requestor: [...seen.requestor]
			};
		}
	}
	if (cache.size >= 4_096) cache.clear();
	cache.set(key, out);
	return out;
}
/** Evaluates a checked expression once; a value it reads but was not given throws. */
export function evaluateVar(compiled: CompiledVar, values: VarValues): Json {
	if (compiled.time && (values.today === undefined || values.now === undefined))
		throw new RangeError(`'${compiled.text}' reads the clock`);
	if (compiled.requestor.length > 0 && values.requestor === undefined)
		throw new RangeError(`'${compiled.text}' reads the requestor`);
	const r = values.requestor;
	if (compiled.member !== undefined && r !== undefined) {
		const [head = '', policy = ''] = compiled.member.split('.');
		switch (head) {
			case 'scopes':
				return [...(r.scopes[policy] ?? [])];
			case 'teams':
			case 'teamTree':
				return [...r[head]];
			case 'id':
			case 'email':
			case 'phone':
			case 'party':
			case 'visitor':
			case 'instance':
				return r[head];
		}
	}
	const v: unknown = compiled.program({
		...(values.today === undefined ? {} : { today: new Day(values.today) }),
		...(values.now === undefined ? {} : { now: new Date(values.now) }),
		...(r === undefined
			? {}
			: {
					requestor: {
						...r,
						teams: [...r.teams],
						teamTree: [...r.teamTree],
						scopes: new Map(
							compiled.requestor
								.filter((m) => m.startsWith('scopes.'))
								.map((m) => m.slice('scopes.'.length))
								.map((k) => [k, [...(r.scopes[k] ?? [])]])
						)
					}
				})
	});
	if (v instanceof Day) return v.iso;
	if (v instanceof Date) return v.toISOString();
	if (v === null || typeof v === 'string') return v;
	if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
	throw new TypeError(`'${compiled.text}' produced ${String(v)}`);
}

/**
 * A field default's time variable: `now` (an instant) or `today` (a date), shifted by at most one span — minutes or
 * hours of `now`, days or weeks of either (`now - hours(1)`, `today + days(7)`) — as its base and its signed SQL
 * interval (`- interval '1 hours'`), or `undefined` for any other text. A writer evaluates it at write time.
 */
export function clockDefault(
	text: string
): { readonly base: 'now' | 'today'; readonly interval: string } | undefined {
	const m = /^(now|today)(?:\s*([+-])\s*(minutes|hours|days|weeks)\((\d+)\))?$/.exec(text.trim());
	const base = m?.[1];
	if (m === null || (base !== 'now' && base !== 'today')) return undefined;
	const [, , sign, unit, count] = m;
	if (sign === undefined || unit === undefined) return { base, interval: '' };
	if (base === 'today' && (unit === 'minutes' || unit === 'hours')) return undefined;
	const n = Number(count);
	return {
		base,
		interval: ` ${sign} interval '${unit === 'weeks' ? `${7 * n} days` : `${n} ${unit}`}'`
	};
}
