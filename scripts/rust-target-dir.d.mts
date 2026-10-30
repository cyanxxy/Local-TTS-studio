/** Types for rust-target-dir.mjs, which TypeScript tests import directly. */
export function resolveRustTargetDir(rootDir: string, platform?: NodeJS.Platform): string;
export function rustBuildEnv(rootDir: string): NodeJS.ProcessEnv;
