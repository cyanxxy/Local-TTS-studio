import { readFile } from "fs/promises";
import {
  formatQwen3ProfileConsoleLines,
  parseQwen3ProfileArgs,
  runQwen3Profile,
  writeQwen3ProfileReport,
} from "./qwen3Profiling";

const HELP = `
Usage:
  npm run profile:qwen3 -- [options]

Targets:
  --target=candle,mlx-api,sglang     Targets to run. Default: candle,mlx-api

Common options:
  --iterations=3                     Measured runs per target
  --warmups=1                        Warmup runs per target, excluded from summary
  --timeout-ms=900000                Per-request timeout
  --text="Hello"                     Benchmark prompt
  --text-file=prompt.txt             Read benchmark prompt from a file
  --report-dir=reports/qwen3-profile Report directory
  --output=report.json               Exact report file path

Local bridge options:
  --bridge-binary=dist-rust/open-tts-local-bridge
  --cache-dir=.model-cache/qwen3-profile
  --base-model-path=/path/to/mlx/model
  --speaker=Ryan
  --language=English
  --instruct="Calm narration"
  --device-map=auto                  Candle device: auto, metal, cpu
  --dtype=auto                       Candle dtype: auto, bfloat16, float32
  --attn=eager
  --max-new-tokens=1536
  --temperature=0.9
  --top-k=50
  --top-p=0.9

SGLang options:
  --sglang-url=http://127.0.0.1:8000/v1/audio/speech
  --sglang-model=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
`.trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const options = parseQwen3ProfileArgs(argv);
  if (options.textFile) {
    options.text = await readFile(options.textFile, "utf8");
  }

  const report = await runQwen3Profile(options);
  const reportPath = await writeQwen3ProfileReport(report, options);
  for (const line of formatQwen3ProfileConsoleLines(report, reportPath)) {
    console.log(line);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
