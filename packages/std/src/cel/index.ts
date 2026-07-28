import { Environment } from '@marcbachmann/cel-js';

const celEnvironment = (() => {
	const env = new Environment({
		unlistedVariablesAreDyn: true,
		homogeneousAggregateLiterals: false
	});

	const reduceValues = (values: unknown[], expression: unknown, initial: unknown): unknown => {
		const expr = String(expression ?? 'acc');
		let acc: unknown = initial;

		for (let index = 0; index < values.length; index += 1) {
			const item = values[index];
			acc = env.evaluate(expr, { acc, item, index, list: values });
		}

		return acc;
	};

	env.registerFunction('reduce(list<dyn>, string, dyn): dyn', (values, expression, initial) => {
		if (!Array.isArray(values)) return initial;
		return reduceValues(values, expression, initial);
	});

	env.registerFunction(
		'reduce(map<string, dyn>, string, dyn): dyn',
		(values, expression, initial) => {
			if (values === null || typeof values !== 'object' || Array.isArray(values)) return initial;
			return reduceValues(Object.values(values), expression, initial);
		}
	);

	env.registerFunction('toDouble(dyn): double', (value: unknown) => {
		if (typeof value === 'number') return value;
		if (typeof value === 'string') {
			const parsed = parseFloat(value);
			return Number.isNaN(parsed) ? 0.0 : parsed;
		}
		return 0.0;
	});

	env.registerFunction('has(dyn, string): bool', (obj: unknown, field: unknown) => {
		if (obj === null || typeof obj !== 'object') return false;
		return Object.prototype.hasOwnProperty.call(obj, String(field ?? ''));
	});

	return env;
})();

function buildCelContext(data: unknown): Record<string, unknown> {
	if (data == null) return {};
	if (typeof data !== 'object' || Array.isArray(data)) return { value: data };
	return Object.fromEntries(Object.entries(data));
}

/** Evaluate a CEL expression against a context object. */
export function evaluateCelExpression(expr: string, context: unknown): unknown {
	return celEnvironment.evaluate(expr, buildCelContext(context));
}
