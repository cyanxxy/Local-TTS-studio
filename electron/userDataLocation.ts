import path from "path";

/**
 * Where the app keeps its data on Windows. Electron defaults userData to the
 * roaming `%APPDATA%`, which a domain profile copies to and from the server at
 * every sign-in and sign-out; the model caches under it run to gigabytes. A new
 * install uses `%LOCALAPPDATA%` instead, and an existing roaming one stays where
 * it is, so nothing already saved goes missing. Returns null to keep the
 * default: off Windows, or when `%LOCALAPPDATA%` is not set.
 */
export function windowsLocalUserDataPath(
  roamingUserData: string,
  env: NodeJS.ProcessEnv,
  exists: (directory: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const localAppData = env.LOCALAPPDATA;
  if (platform !== "win32" || !localAppData) return null;
  const local = path.win32.join(localAppData, path.win32.basename(roamingUserData));
  if (exists(local)) return local;
  if (exists(roamingUserData)) return null;
  return local;
}
