import { promises as fs } from "fs";
import path from "path";

export async function getDirectorySizeBytes(dirPath: string): Promise<number> {
  // The cache tree is mutated concurrently (clear-cache, in-flight downloads,
  // the Rust bridge's HF cache), so a file or subdir can vanish between the
  // readdir snapshot and the per-entry stat/recurse. Treat such ENOENT races as
  // a 0-byte contribution to keep the size query best-effort instead of failing
  // the whole IPC call; surface any other error normally.
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  const entrySizes = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) return await getDirectorySizeBytes(fullPath);
      if (entry.isFile()) return (await fs.stat(fullPath)).size;
      return 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }));
  return entrySizes.reduce((sum, size) => sum + size, 0);
}
