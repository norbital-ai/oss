import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import './resolve.ts';
import { outcomeText } from '../src/actions/outcome.ts';

it.effect(
	'authored refusal keys follow the viewer locale, while literal provider messages remain intact',
	() =>
		Effect.sync(() => {
			const chinese = { t: (key: string) => (key === 'errors.order_sealed' ? '订单已封存' : key) };
			assert.equal(
				outcomeText(chinese, { kind: 'refused', code: 'invalid', message: 'errors.order_sealed' }),
				'订单已封存'
			);
			assert.equal(
				outcomeText(chinese, {
					kind: 'refused',
					code: 'invalid',
					message: 'ERP refused duplicate reference'
				}),
				'ERP refused duplicate reference'
			);
			const english = {
				t: (key: string) => (key === 'errors.order_sealed' ? 'Order is sealed.' : key)
			};
			assert.equal(
				outcomeText(english, { kind: 'refused', code: 'invalid', message: 'errors.order_sealed' }),
				'Order is sealed.'
			);
		})
);
