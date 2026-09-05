import { Schema } from 'effect';
import type { TOption } from '#lib/combobox/types';

const isString = Schema.is(Schema.String);

// Custom filter function for enhanced search (for Command component)
export function buildCustomFilterFn<T, AP extends Record<string, unknown>>(
	options: TOption<T, AP>[]
) {
	return (optionValue: string, search: string) => {
		// Special case for the create option
		if (optionValue.startsWith('__create__')) {
			return 1;
		}

		const option = options.find(
			(opt: TOption<T, AP>) =>
				(isString(opt.value) ? opt.value : JSON.stringify(opt.value)) === optionValue
		);

		if (!option) return 0;

		// Normalize search term
		search = search.toLowerCase().trim();
		if (search === '') return 1;

		const labelText = (isString(option.label) ? option.label : 'Custom Label').toLowerCase();
		const valueText = JSON.stringify(option.value).toLowerCase();

		// Check if the combined text contains the search term
		const combinedText = labelText + ' ' + valueText;
		if (combinedText.includes(search)) {
			return 1;
		}

		// Additional search capabilities
		let score = 0;

		// Check description
		if (option.description?.toLowerCase().includes(search)) {
			score += 0.5;
		}

		// Check additional search terms
		if (option.search_term) {
			const terms = Array.isArray(option.search_term) ? option.search_term : [option.search_term];
			for (const term of terms) {
				const lowerTerm = term.toLowerCase();
				if (lowerTerm.includes(search) || search.includes(lowerTerm)) {
					score += 0.5;
					break;
				}
			}
		}

		return Math.ceil(score);
	};
}
