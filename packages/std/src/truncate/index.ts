import { dump } from 'js-yaml';
import {
	createEncodedPayloadStripCtx,
	stripEncodedPayloads,
	stripEncodedPayloadsWithCtx,
	type EncodedPayloadExtracted,
	type EncodedPayloadStripCtx
} from './base64.js';

export interface TruncationResult {
	text: string;
	truncated: boolean;
	originalLength: number;
	metadata?: string;
	extracted?: EncodedPayloadExtracted[];
}

export interface TruncationOptions {
	maxLength?: number;
	html?: boolean;
	table?: boolean;
}

const DEFAULT_MAX_LENGTH = 10000;
const DEFAULT_INDICATOR = '\n...[truncated]...\n';

export function truncate(
	input: unknown,
	options: number | TruncationOptions = {}
): TruncationResult {
	const opts: TruncationOptions = typeof options === 'number' ? { maxLength: options } : options;
	const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

	if (input === undefined) {
		return { text: '', truncated: false, originalLength: 0 };
	}

	if (input === null) {
		return { text: 'null', truncated: false, originalLength: 4 };
	}

	if (input instanceof Date) {
		const text = input.toISOString();
		return { text, truncated: false, originalLength: text.length };
	}

	if (input instanceof Error) {
		return truncateStructured(
			{ name: input.name, message: input.message, stack: input.stack },
			maxLength
		);
	}

	if (input instanceof Map) {
		const entries = Array.from(input.entries());
		return truncateStructured(entries, maxLength);
	}

	if (input instanceof Set) {
		const values = Array.from(input.values());
		return truncateStructured(values, maxLength);
	}

	if (typeof input !== 'string') {
		return truncateStructured(input, maxLength);
	}

	const originalLength = input.length;

	if (opts.html) {
		const stripped = stripEncodedPayloads(input);
		const result = truncateHtml(stripped.text, maxLength);
		return {
			...result,
			truncated: result.truncated || stripped.extracted.length > 0,
			originalLength,
			extracted: stripped.extracted.length > 0 ? stripped.extracted : undefined
		};
	}
	if (opts.table) {
		const stripped = stripEncodedPayloads(input);
		const result = truncateTable(stripped.text, maxLength);
		return {
			...result,
			truncated: result.truncated || stripped.extracted.length > 0,
			originalLength,
			extracted: stripped.extracted.length > 0 ? stripped.extracted : undefined
		};
	}

	if (
		(input.trim().startsWith('{') && input.trim().endsWith('}')) ||
		(input.trim().startsWith('[') && input.trim().endsWith(']'))
	) {
		try {
			// stupidity:allow R6b -- structured processing accepts unknown and recursively narrows it
			const parsed = JSON.parse(input);
			return truncateStructured(parsed, maxLength, originalLength);
		} catch /* stupidity:allow S1 -- invalid JSON intentionally falls through */ {
			// Not valid JSON, continue to other checks
		}
	}

	const stripped = stripEncodedPayloads(input);

	if (
		/<[a-z][\s\S]*>/i.test(stripped.text) &&
		(stripped.text.includes('</html>') ||
			stripped.text.includes('</div>') ||
			stripped.text.includes('</body>'))
	) {
		const result = truncateHtml(stripped.text, maxLength);
		return {
			...result,
			truncated: result.truncated || stripped.extracted.length > 0,
			originalLength,
			extracted: stripped.extracted.length > 0 ? stripped.extracted : undefined
		};
	}

	const lines = stripped.text.split('\n');
	const tableLines = lines.filter(
		(l) => l.trim().startsWith('|') || (l.includes('|') && l.trim().length > 3)
	);
	if (tableLines.length > 3 && tableLines.length / lines.length > 0.3) {
		const result = truncateTable(stripped.text, maxLength);
		return {
			...result,
			truncated: result.truncated || stripped.extracted.length > 0,
			originalLength,
			extracted: stripped.extracted.length > 0 ? stripped.extracted : undefined
		};
	}

	const result = truncateText(stripped.text, maxLength);
	return {
		...result,
		truncated: result.truncated || stripped.extracted.length > 0,
		originalLength,
		extracted: stripped.extracted.length > 0 ? stripped.extracted : undefined
	};
}

function truncateText(text: string, maxLength: number): TruncationResult {
	const originalLength = text.length;

	if (text.length <= maxLength) {
		return { text, truncated: false, originalLength };
	}

	const indicator = DEFAULT_INDICATOR;
	const availableSpace = maxLength - indicator.length;

	if (availableSpace <= 0) {
		return { text: text.slice(0, maxLength), truncated: true, originalLength };
	}

	const halfSpace = Math.floor(availableSpace / 2);
	const startPart = text.slice(0, halfSpace);
	const endPart = text.slice(-halfSpace);
	const truncatedText = startPart + indicator + endPart;

	return { text: truncatedText, truncated: true, originalLength };
}

function truncateStructured(
	data: unknown,
	maxLength: number,
	originalLength: number = 0
): TruncationResult {
	const ctx: EncodedPayloadStripCtx = createEncodedPayloadStripCtx();
	const cleanedData = processValue(data, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, ctx, {
		onlyStripEncoded: true
	}).value;

	let currentDepth = 10;
	let currentArrayItems = 50;
	let truncated = false;

	for (;;) {
		const { value: processed, wasTruncated } = processValue(
			cleanedData,
			0,
			currentDepth,
			currentArrayItems,
			undefined
		);
		truncated = truncated || wasTruncated;

		const result = toYaml(processed);

		if (result.length <= maxLength) {
			return {
				text: result,
				truncated: truncated || ctx.extracted.length > 0,
				originalLength: originalLength || result.length,
				extracted: ctx.extracted.length > 0 ? ctx.extracted : undefined
			};
		}

		if (currentArrayItems > 5) {
			currentArrayItems = Math.max(5, Math.floor(currentArrayItems / 2));
			truncated = true;
		} else if (currentDepth > 2) {
			currentDepth = Math.max(2, currentDepth - 2);
			truncated = true;
		} else if (currentArrayItems > 1) {
			currentArrayItems = 1;
			truncated = true;
		} else if (currentDepth > 1) {
			currentDepth = 1;
			truncated = true;
		} else {
			const yamlResult = toYaml(processed);
			const final = truncateText(yamlResult + '\n# ...[truncated]', maxLength);
			return {
				...final,
				truncated: final.truncated || ctx.extracted.length > 0,
				originalLength: originalLength || final.originalLength,
				extracted: ctx.extracted.length > 0 ? ctx.extracted : undefined
			};
		}
	}
}

function toYaml(value: unknown): string {
	try {
		return dump(value, {
			indent: 2,
			lineWidth: 120,
			noRefs: true,
			sortKeys: false
		}).trim();
	} catch {
		return JSON.stringify(value, null, 2);
	}
}

function processValue(
	value: unknown,
	currentDepth: number,
	maxDepth: number,
	maxArrayItems: number,
	ctx?: EncodedPayloadStripCtx,
	options?: { onlyStripEncoded?: boolean }
): { value: unknown; wasTruncated: boolean } {
	if (currentDepth > maxDepth) {
		return { value: '[...nested content]', wasTruncated: true };
	}

	if (value === null || typeof value !== 'object') {
		if (typeof value === 'string') {
			let s = value;
			if (ctx) s = stripEncodedPayloadsWithCtx(s, ctx);

			if (options?.onlyStripEncoded) {
				return { value: s, wasTruncated: false };
			}

			if (s.length > 500) {
				const keepStart = Math.floor(500 * 0.6);
				const keepEnd = Math.floor(500 * 0.4);
				return {
					value: `${s.slice(0, keepStart)}...[truncated ${s.length - 500} chars]...${s.slice(-keepEnd)}`,
					wasTruncated: true
				};
			}
			return { value: s, wasTruncated: false };
		}
		return { value, wasTruncated: false };
	}

	if (Array.isArray(value)) {
		let wasTruncated = false;
		const itemsToProcess = options?.onlyStripEncoded ? value : value.slice(0, maxArrayItems);

		if (!options?.onlyStripEncoded && value.length > maxArrayItems) {
			wasTruncated = true;
		}

		const processed = itemsToProcess.map((item) => {
			const result = processValue(item, currentDepth + 1, maxDepth, maxArrayItems, ctx, options);
			if (result.wasTruncated) wasTruncated = true;
			return result.value;
		});

		if (!options?.onlyStripEncoded && value.length > maxArrayItems) {
			processed.push(`[...${value.length - maxArrayItems} more items]`);
		}

		return { value: processed, wasTruncated };
	}

	let wasTruncated = false;
	const result: Record<string, unknown> = {};
	const entries = Object.entries(value);

	const maxKeys = maxArrayItems;
	const entriesToProcess = options?.onlyStripEncoded ? entries : entries.slice(0, maxKeys);

	if (!options?.onlyStripEncoded && entries.length > maxKeys) {
		wasTruncated = true;
	}

	for (const [key, val] of entriesToProcess) {
		const processed = processValue(val, currentDepth + 1, maxDepth, maxArrayItems, ctx, options);
		if (processed.wasTruncated) wasTruncated = true;
		result[key] = processed.value;
	}

	if (!options?.onlyStripEncoded && entries.length > maxKeys) {
		result['__truncated__'] = `${entries.length - maxKeys} more keys`;
	}

	return { value: result, wasTruncated };
}

function truncateHtml(html: string, maxLength: number): TruncationResult {
	const originalLength = html.length;

	let cleaned = html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');

	if (cleaned.length <= maxLength) {
		return {
			text: cleaned,
			truncated: cleaned.length < originalLength,
			originalLength
		};
	}

	const truncatedText = cleaned.slice(0, maxLength) + '\n<!-- ... HTML truncated ... -->';
	return { text: truncatedText, truncated: true, originalLength };
}

function truncateTable(markdown: string, maxLength: number): TruncationResult {
	const originalLength = markdown.length;

	const lines = markdown.split('\n');
	const resultLines: string[] = [];
	let inTable = false;
	let tableLines: string[] = [];
	const tableMetadata: string[] = [];
	let tableCount = 0;
	let wasTruncated = false;

	for (const line of lines) {
		const isTableLine =
			line.trim().startsWith('|') || (line.includes('|') && line.trim().length > 3);

		if (isTableLine) {
			if (!inTable) {
				inTable = true;
				tableLines = [];
			}
			tableLines.push(line);
		} else {
			if (inTable) {
				const { processedTable, meta, truncated } = processTableBlock(tableLines, ++tableCount);
				resultLines.push(processedTable);
				if (meta) tableMetadata.push(meta);
				if (truncated) wasTruncated = true;
				inTable = false;
			}
			resultLines.push(line);
		}
	}

	if (inTable) {
		const { processedTable, meta, truncated } = processTableBlock(tableLines, ++tableCount);
		resultLines.push(processedTable);
		if (meta) tableMetadata.push(meta);
		if (truncated) wasTruncated = true;
	}

	const text = resultLines.join('\n');

	if (text.length > maxLength) {
		return truncateText(text, maxLength);
	}

	return {
		text,
		truncated: wasTruncated,
		originalLength,
		metadata: tableMetadata.join('\n')
	};
}

function processTableBlock(
	lines: string[],
	index: number
): { processedTable: string; meta: string | null; truncated: boolean } {
	const rows = lines.map((line) =>
		line
			.split('|')
			.map((c) => c.trim())
			.filter((c, i, arr) => {
				if (i === 0 && c === '') return false;
				if (i === arr.length - 1 && c === '') return false;
				return true;
			})
	);

	if (rows.length < 3) {
		return { processedTable: lines.join('\n'), meta: null, truncated: false };
	}

	const header = rows[0];
	const dataRows = rows.slice(2);

	const numCols = header.length;
	const numRows = dataRows.length;
	let type = 'Standard Data Table';
	let action = 'Truncated';
	let outputRows = dataRows;
	let truncated = false;

	let isForm = false;
	if (numCols === 2) {
		const keys = dataRows.map((r) => r[0] || '');
		const uniqueKeys = new Set(keys).size;
		if (keys.length > 0 && uniqueKeys / keys.length > 0.8) {
			const avgKeyLen = keys.reduce((s, k) => s + k.length, 0) / keys.length;
			if (avgKeyLen < 60) {
				isForm = true;
			}
		}
	}

	if (isForm) {
		type = 'Form / Key-Value';
		action = 'Kept All';
		outputRows = dataRows;
	} else if (numRows < numCols && numRows > 1) {
		type = 'Wide/Transposed';
		action = 'Kept All';
		outputRows = dataRows;
	} else {
		if (numRows > 10) {
			outputRows = dataRows.slice(0, 10);
			action = `Truncated to 10/${numRows} rows`;
			truncated = true;
		} else {
			action = 'Kept All (Small)';
			outputRows = dataRows;
		}
	}

	const keptLines = [lines[0], lines[1], ...lines.slice(2, 2 + outputRows.length)];

	if (outputRows.length < dataRows.length) {
		keptLines.push(`| ... (${dataRows.length - outputRows.length} more rows) ... |`);
	}

	const meta = `Table ${index}: ${type} (${numRows} rows, ${numCols} cols) - ${action}. Headers: [${header.slice(0, 5).join(', ')}${header.length > 5 ? '...' : ''}]`;

	return {
		processedTable: keptLines.join('\n'),
		meta,
		truncated
	};
}
