import { parentPort, workerData } from "node:worker_threads";

interface DocumentParseWorkerData {
  filePath: string;
  maxPages: number;
}

interface LiteParseResult {
  text: string;
  pages: unknown[];
}

interface LiteParseInstance {
  parse: (input: string) => Promise<LiteParseResult>;
}

type LiteParseConstructor = new (config?: Record<string, unknown>) => LiteParseInstance;

function isWorkerData(value: unknown): value is DocumentParseWorkerData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<DocumentParseWorkerData>;
  return (
    typeof candidate.filePath === "string"
    && candidate.filePath.length > 0
    && Number.isSafeInteger(candidate.maxPages)
    && Number(candidate.maxPages) > 0
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

if (!parentPort) throw new Error("Document parser worker requires a parent port.");
if (!isWorkerData(workerData)) throw new Error("Document parser worker received invalid startup data.");

// LiteParse exposes ESM-only exports. This worker is compiled as CommonJS for
// Electron, so keep the import native instead of allowing TypeScript to rewrite
// it to require().
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<{ LiteParse: LiteParseConstructor }>;

void (async () => {
  try {
    const { LiteParse } = await dynamicImport("@llamaindex/liteparse");
    const parser = new LiteParse({
      outputFormat: "text",
      quiet: true,
      maxPages: workerData.maxPages,
    });
    const result = await parser.parse(workerData.filePath);
    parentPort.postMessage({
      ok: true,
      text: result.text,
      pageCount: result.pages.length,
    });
  } catch (cause) {
    parentPort.postMessage({ ok: false, error: errorMessage(cause) });
  } finally {
    // The main process terminates this one-shot worker after receiving the
    // result. Closing the port lets it exit naturally first when no native
    // handles remain.
    parentPort.close();
  }
})();
