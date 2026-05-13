export function getMeaningfulTextLength(text: string): number {
  return text.trim().length;
}

export function hasMinimumSynthesisText(text: string, minimumLength: number): boolean {
  return getMeaningfulTextLength(text) >= minimumLength;
}
