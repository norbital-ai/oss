import type { SourcePosition, StructuralDiagnostic } from './types.js';

export function sourcePosition(source: string, offset: number): SourcePosition {
	const before = source.slice(0, offset);
	const lineStart = before.lastIndexOf('\n');
	return {
		line: before.split('\n').length,
		column: offset - lineStart
	};
}

export function sourceDiagnostic(
	source: string,
	file: string,
	offset: number,
	code: string,
	message: string
): StructuralDiagnostic {
	return {
		source: 'pod',
		severity: 'error',
		code,
		file,
		start: sourcePosition(source, offset),
		message
	};
}
