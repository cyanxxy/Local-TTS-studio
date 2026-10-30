/**
 * The oldest Visual C++ redistributable Windows packages may bundle. Binaries
 * built with MSVC 14.40 (VS 2022 17.10) or later crash in std::mutex on an older
 * msvcp140.dll, and an app-local copy is loaded ahead of System32's.
 */
export const MSVC_RUNTIME_MIN_VERSION = [14, 40];

/** Whether a `VC\Redist\MSVC\<version>` folder is at least `minimum`. */
export function msvcRedistVersionIsCurrent(root, minimum = MSVC_RUNTIME_MIN_VERSION) {
  const name = root.split(/[\\/]+/).filter(Boolean).pop() ?? "";
  if (!/^\d+(?:\.\d+)+$/.test(name)) return false;
  const version = name.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    const part = version[i] ?? 0;
    if (part !== minimum[i]) return part > minimum[i];
  }
  return true;
}
