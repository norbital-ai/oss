/**
 * Global dedent configuration for consistent string formatting across the codebase.
 *
 * Configuration:
 * - escapeSpecialCharacters: false - Prevents double-escaping $ in code examples
 * - trimWhitespace: true - Cleans leading/trailing whitespace
 * - alignValues: true - Critical for nested multi-line interpolations (e.g., system prompts)
 *
 * This ensures LLM prompts are formatted consistently, reducing hallucination from malformed templates.
 */
import baseDedent from 'dedent';

const dedent = baseDedent.withOptions({
	escapeSpecialCharacters: false,
	trimWhitespace: true,
	alignValues: true
});

export default dedent;
