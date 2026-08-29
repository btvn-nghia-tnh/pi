/**
 * Fuzzy filter and sort, ported from packages/tui/src/fuzzy.ts scoring.
 */

export interface FuzzyMatch<T> {
	item: T;
	score: number;
}

/** Score a subsequence match of query inside text. Higher is better. */
export function fuzzyScore(text: string, query: string): number {
	if (!query) return 0;
	const lowerText = text.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (lowerQuery.length > lowerText.length) return -1;

	let score = 0;
	let textIndex = 0;
	let queryIndex = 0;
	let lastMatchIndex = -2;

	while (queryIndex < lowerQuery.length && textIndex < lowerText.length) {
		if (lowerText[textIndex] === lowerQuery[queryIndex]) {
			score += 1;
			// Consecutive character bonus
			if (lastMatchIndex === textIndex - 1) {
				score += 2;
			}
			// Word start bonus (previous char is a separator)
			if (textIndex === 0 || /[\s/_.-]/.test(lowerText[textIndex - 1]!)) {
				score += 4;
			}
			lastMatchIndex = textIndex;
			queryIndex++;
		}
		textIndex++;
	}

	if (queryIndex < lowerQuery.length) return -1;

	// Prefer shorter texts for the same match
	score -= lowerText.length * 0.01;
	return score;
}

/** Filter and sort items by fuzzy score against their text rendering. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): FuzzyMatch<T>[] {
	const matches: FuzzyMatch<T>[] = [];
	for (const item of items) {
		const score = fuzzyScore(text(item), query);
		if (score >= 0) {
			matches.push({ item, score });
		}
	}
	matches.sort((a, b) => b.score - a.score);
	return matches;
}
