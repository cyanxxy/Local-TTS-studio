/**
 * Single source of truth for the Audio8 local model.
 *
 * The pinned upstream revisions, the exact asset set the desktop runtime
 * downloads, and the voice catalogue all live here. The main process (cache
 * location, IPC validation, cache reporting) and the inference worker
 * (downloads, integrity verification, synthesis) both read this table, so a
 * revision bump is one edit. Previously the revision was written out three
 * times, which made it possible to point the cache directory at one revision
 * while downloading another.
 *
 * Renderer-facing display metadata (voice names and descriptions) stays in
 * `src/constants.ts` because the renderer cannot import from `electron/`.
 * `vite.audio8Catalogue.test.ts` asserts the two stay in agreement.
 */

export const AUDIO8_MODEL_ID = "Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4";
export const AUDIO8_MODEL_REVISION = "818569c6b832118ad68d61bbd873abe250fcd68a";

/**
 * Voice profiles are published from the Space of the same name rather than the
 * model repository, and are pinned to their own revision.
 */
export const AUDIO8_VOICE_SPACE_ID = "Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4";
export const AUDIO8_VOICE_SPACE_REVISION = "6417ebaafc996620bebc3eb27cde0d5acb19f13b";

/** Directory name under `userData/local-model-cache`. */
export const AUDIO8_CACHE_NAMESPACE = "audio8";

export const AUDIO8_VOICE_IDS = ["clara", "iris", "arthur", "mia", "ben", "sophie"] as const;
export type Audio8VoiceId = typeof AUDIO8_VOICE_IDS[number];
export const AUDIO8_DEFAULT_VOICE: Audio8VoiceId = "clara";

/**
 * Upper bound on a single synthesis request. The renderer chunks well below
 * this; the cap exists so a malformed IPC payload cannot pin a CPU core
 * generating tokens for an unbounded prompt.
 */
export const AUDIO8_MAX_TEXT_CHARACTERS = 1000;

/**
 * Integrity digests come in two flavours because the Hub serves LFS files and
 * plain git blobs differently: LFS pointers expose an upstream SHA-256 of the
 * content, while small text files are only addressable by their git blob
 * SHA-1 (`sha1("blob <size>\0" + content)`).
 */
export type Audio8Digest =
  | { algorithm: "sha256"; value: string }
  | { algorithm: "gitBlobSha1"; value: string };

export interface Audio8Asset {
  /** Path relative to the cache directory, and to the upstream repository. */
  file: string;
  /** Exact byte length; a size mismatch fails verification before the digest. */
  size: number;
  digest: Audio8Digest;
  source: "model" | "voiceSpace";
}

function sha256(value: string): Audio8Digest {
  return { algorithm: "sha256", value };
}

function gitBlobSha1(value: string): Audio8Digest {
  return { algorithm: "gitBlobSha1", value };
}

/**
 * The three online inference graphs, their external weights, the tokenizer, and
 * the runtime manifest. The ~414 MiB voice-registration encoder is deliberately
 * absent: Open TTS ships pre-registered voice profiles and never registers new
 * ones on device.
 */
export const AUDIO8_MODEL_ASSETS: readonly Audio8Asset[] = [
  {
    file: "runtime_manifest.json",
    size: 1080,
    digest: gitBlobSha1("e8fc0f601be992a1253e3b6ca95af6a8ab3cea27"),
    source: "model",
  },
  {
    file: "tokenizer/tokenizer.json",
    size: 12217872,
    digest: sha256("f24e08099d45a8adf3f52f5f0b03276e433bb9d689bb15fcbcc48ce58744588b"),
    source: "model",
  },
  {
    file: "slow_ar_int4.onnx",
    size: 900218,
    digest: sha256("0cf7701d6da81f888b49ba6e752445d9786a9915ba30dcf084f7743bdda96834"),
    source: "model",
  },
  {
    file: "slow_ar_int4.onnx.data",
    size: 290267090,
    digest: sha256("bb217f654039692204386b7e5b74d98e9268863bb664a849aa123a9053d6c824"),
    source: "model",
  },
  {
    file: "fast_ar_int4.onnx",
    size: 156318,
    digest: sha256("808c5a0c95c28d90337d925a9a8f6075f7ff8eb7b3080d2b34c4133479a6dc94"),
    source: "model",
  },
  {
    file: "fast_ar_int4.onnx.data",
    size: 35055104,
    digest: sha256("183be0c9f26b27c605b92a0875beb93f8f98b771f27f65cab133c73610868325"),
    source: "model",
  },
  {
    file: "codec_decoder_fp16.onnx",
    size: 594319,
    digest: sha256("6e379be31db6c1b0c111e0e3d2aeb10717ee96b197462b926de411e75a1fd019"),
    source: "model",
  },
  {
    file: "codec_decoder_fp16.onnx.data",
    size: 260741440,
    digest: sha256("18838f686aa7c1528fb69ec11e1ab404fdc4dc823d13219abfd4b327988527c0"),
    source: "model",
  },
];

export interface Audio8VoiceAssets {
  codes: Audio8Asset;
  meta: Audio8Asset;
}

export const AUDIO8_VOICE_ASSETS: Readonly<Record<Audio8VoiceId, Audio8VoiceAssets>> = {
  clara: {
    codes: {
      file: "voices/clara/codes.npy",
      size: 1748,
      digest: sha256("f2b8ae1d66590844c7c6541407a3f3fa09b234c140f38c70b9c606047050f299"),
      source: "voiceSpace",
    },
    meta: {
      file: "voices/clara/meta.json",
      size: 526,
      digest: gitBlobSha1("4a6d59259d91bfbf680ac7ba5b869b284dd6a0a2"),
      source: "voiceSpace",
    },
  },
  iris: {
    codes: {
      file: "voices/iris/codes.npy",
      size: 1808,
      digest: sha256("9194b2dc49b45e8a56112f07a6c204ea4bd08a5d165f2aebc27755b5335873d4"),
      source: "voiceSpace",
    },
    meta: {
      file: "voices/iris/meta.json",
      size: 524,
      digest: gitBlobSha1("b8068544e105b0a34f1900535bdc94752755ec6c"),
      source: "voiceSpace",
    },
  },
  arthur: {
    codes: {
      file: "voices/arthur/codes.npy",
      size: 1848,
      digest: sha256("a3791a9755e815f22b3b5b4a380393d7e7239b0c5cccd77c2bf8a928ecd701b4"),
      source: "voiceSpace",
    },
    meta: {
      file: "voices/arthur/meta.json",
      size: 526,
      digest: gitBlobSha1("24aab1c67367079810725302c34412051ccb0f42"),
      source: "voiceSpace",
    },
  },
  mia: {
    codes: {
      file: "voices/mia/codes.npy",
      size: 1528,
      digest: sha256("23c3ab1b7ab6af732230fa5df9d94b74c9bb259722fc085a9456d628b76d745b"),
      source: "voiceSpace",
    },
    meta: {
      file: "voices/mia/meta.json",
      size: 501,
      digest: gitBlobSha1("e7174c6d7fcf93d9ee702b3bfb0ef5bd24030aa4"),
      source: "voiceSpace",
    },
  },
  ben: {
    codes: {
      file: "voices/ben/codes.npy",
      size: 1328,
      digest: sha256("8e642d3fe87d9db456bf616d5f1183cd4849fba7d5facd7d18041f02ee8637b9"),
      source: "voiceSpace",
    },
    meta: {
      file: "voices/ben/meta.json",
      size: 499,
      digest: gitBlobSha1("5d94f0df173096dfedccae32ef78e7955586a084"),
      source: "voiceSpace",
    },
  },
  sophie: {
    codes: {
      file: "voices/sophie/codes.npy",
      size: 1408,
      digest: sha256("1499e866aaddf8a497e3f62dd2e31f8393ca2a630518e360c705b3363e3f4ac7"),
      source: "voiceSpace",
    },
    meta: {
      file: "voices/sophie/meta.json",
      size: 510,
      digest: gitBlobSha1("5109ebc81194d3b4d3f287a761fb28dd4ea58850"),
      source: "voiceSpace",
    },
  },
};

/** Bytes fetched on a cold load, excluding the six small voice profiles. */
export const AUDIO8_MODEL_DOWNLOAD_BYTES = AUDIO8_MODEL_ASSETS
  .reduce((total, asset) => total + asset.size, 0);

export function audio8AssetUrl(asset: Audio8Asset): string {
  const [prefix, revision] = asset.source === "voiceSpace"
    ? [`spaces/${AUDIO8_VOICE_SPACE_ID}`, AUDIO8_VOICE_SPACE_REVISION]
    : [AUDIO8_MODEL_ID, AUDIO8_MODEL_REVISION];
  return `https://huggingface.co/${prefix}/resolve/${revision}/${asset.file}`;
}

export function isAudio8VoiceId(value: unknown): value is Audio8VoiceId {
  return typeof value === "string" && (AUDIO8_VOICE_IDS as readonly string[]).includes(value);
}
