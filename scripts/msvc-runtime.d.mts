/** Types for msvc-runtime.mjs, which TypeScript tests import directly. */
export const MSVC_RUNTIME_MIN_VERSION: readonly number[];
export function msvcRedistVersionIsCurrent(root: string, minimum?: readonly number[]): boolean;
