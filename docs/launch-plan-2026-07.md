# Open TTS launch plan

Prepared 23 July 2026.

## Positioning

Use one clear promise:

> Open TTS is a free, open-source speech studio and document reader that runs its synthesis on your device—without an account, API key, usage cap, or per-character bill.

The strongest supporting points are:

- The browser build uses Kokoro and Supertonic through WebGPU/WASM.
- The macOS desktop build adds Supertonic 3 and Qwen3-TTS, including voice cloning and VoiceDesign.
- Reader handles long documents; Studio exports WAV/MP3 and estimated SRT/VTT/JSON captions.
- Model/runtime downloads happen on first use, after which cached models can be reused locally.
- The project is Apache-2.0 licensed.

Do not lead with a long model list. Lead with the problem: private reading and repeatable speech creation without sending text to a hosted TTS service or paying per character.

Avoid saying "100% offline" without the first-download qualification. Avoid positioning it as accessibility software until it has been tested with the relevant users and assistive technologies.

## Launch blockers and preflight

Do not begin the coordinated launch until all of these are true:

- Confirm the [v1.7.1 GitHub release](https://github.com/cyanxxy/Local-TTS-studio/releases/tag/v1.7.1) remains public and includes its DMG/ZIP assets. It was published on 23 July 2026 after source, package, and native-bridge verification passed.
- The public README and screenshots reflect v1.7.1.
- The unsigned, non-notarized status and the macOS 26/Apple Silicon requirement are visible before download.
- A short demo video or GIF shows both Studio and Reader in the first 10 seconds.
- The GitHub repository has a `SECURITY.md`; this helps trust and may help with r/macOS's automated GitHub checks.
- Ideally, deploy the browser build and set it as the GitHub repository homepage. A no-sign-up live demo will materially improve Reddit, Hacker News, Product Hunt, and directory conversion.
- Replace the repository-description phrase "open elevenreader" with a natural description. It currently reads like search-keyword copy.

Recommended launch assets:

- 30–45 second silent demo with captions
- Studio screenshot
- Reader screenshot with a real public-domain EPUB
- One short audio sample made with a built-in voice
- GitHub repository link
- Exact release link
- Live browser-demo link, if deployed

## Recommended channels

### 1. r/SideProject — post first

Fit: high. The community explicitly exists for sharing projects and receiving feedback. Its sidebar asks link submissions to use `[Project name] - [Short description]`.

Use a native video or image post with the GitHub link in the body. Ask for one specific kind of feedback and remain available to answer comments for the next hour.

Source: https://old.reddit.com/r/SideProject/

### 2. r/macOS Developer Saturday — first Saturday after release

Fit: high for the desktop build. Self-promotion is allowed only on Saturdays from 00:00–23:59 UTC, once per user per week. The developer relationship must be disclosed, GitHub projects are allowed, and context/screenshots are expected.

For Europe/Amsterdam in July, that window is Saturday 02:00 through Sunday 01:59 local time. Post while there are several hours left in which to answer questions.

Source: https://www.reddit.com/r/MacOS/comments/1rsxzup/new_policy_introducing_developer_saturday/

### 3. r/macapps — valuable after qualifying the account

Fit: high, but not an immediate cold-post channel. Current requirements include:

- verified email
- account older than seven days
- at least 10 comment-karma points earned specifically in r/macapps
- acknowledgement of the community rules
- `[OS]` prefix for an open-source app
- pricing, comparison, changelog/roadmap, and an accurate AI-development disclosure
- no more than one developer promotion in 30 days

Participate helpfully before posting. Do not manufacture low-value comments just to reach the threshold.

Sources:

- https://www.reddit.com/r/macapps/comments/1qghsc5/new_post_guidelines_and_updates_on_rmacapps/
- https://www.reddit.com/r/macapps/comments/1r6d06r/new_post_requirements_to_combat_low_quality/

### 4. r/opensource — post only from a normal Reddit account

Fit: good for the Apache-2.0 and local-first engineering story. The community allows people to be proud of their work but bans spam/excessive self-promotion and refers to the usual roughly 1-in-10 participation guideline. Use a technical, transparent post and disclose being the developer.

Rules: https://old.reddit.com/r/opensource/about/rules/

### 5. r/LocalLLaMA — later, after genuine participation

Fit: potentially very high because the desktop app integrates Qwen3-TTS and other local models. Do not cold-post. Rule 4 uses a roughly 1-in-10 self-promotion guideline, requires affiliation disclosure, and moderators inspect participation inside the community. A post also requires at least five comment-karma points earned in the subreddit.

The community bans completely/primarily LLM-generated post copy. Write this post personally. A useful angle is the engineering tradeoff: browser WebGPU workers versus a resident Rust/MLX desktop runtime, with measured performance and limitations.

Sources:

- https://old.reddit.com/r/LocalLLaMA/about/rules/
- https://www.reddit.com/r/LocalLLaMA/comments/1su3ao4/rlocalllama_rule_updates/

### 6. Hacker News — strong, after the app is easy to try

Fit: high. A Show HN must be something the author made and people can try. The official guidance prefers no sign-up/email barrier and says the maker must be present to discuss it.

Link to a live browser demo if available; otherwise link to the GitHub repository with a prominent working release. Do not frame this as a v1.7.1 update—frame it as the first Show HN for the whole project.

Hacker News explicitly says not to post generated or AI-edited text. Write the title and first comment yourself. Cover these facts in your own words:

- why private/local TTS mattered enough to build this
- what runs in browser workers and what the desktop Rust bridge adds
- why there is no hosted inference server
- the least flattering current limitation: unsigned macOS 26/Apple Silicon release
- the technical decision or tradeoff you most want HN to discuss

Sources:

- https://news.ycombinator.com/showhn.html
- https://news.ycombinator.com/newsguidelines.html

### 7. Product Hunt — after a public homepage/demo exists

Fit: medium. It reaches general early adopters, but a bare GitHub repository is weaker than a polished, instantly understandable homepage. Product Hunt permits makers to hunt their own products and says not to ask people directly for upvotes.

Source: https://www.producthunt.com/launch

### 8. AlternativeTo — evergreen discovery

Fit: high for long-tail search. Submit Open TTS as an open-source alternative to Speechify, ElevenReader, NaturalReader, and ElevenLabs where its feature set genuinely overlaps. Be precise about the current macOS-only packaged desktop build and the locally runnable web build.

Submission starts at: https://alternativeto.net/manage-item/

### 9. Small, low-risk additions

- Add Open TTS to the r/github self-promotion megathread rather than making a main-feed promotional post:
  https://www.reddit.com/r/github/comments/1jy8rea/promote_your_projects_here_selfpromotion/
- Publish a short technical article on DEV about WebGPU TTS workers and the authenticated loopback Rust bridge. The article should teach something useful and link to the project once.
- Post the demo video to Mastodon and Bluesky with `#opensource`, `#localfirst`, `#TTS`, and `#WebGPU`. Do not paste the Reddit copy.
- Ask the maintainer of the current local-TTS comparison list to evaluate/add Open TTS, with a clear developer disclosure:
  https://www.reddit.com/r/LocalTextToSpeech/comments/1u3kxxx/my_tts_list_of_2026_all_voices_all_models_and/

## Places to avoid

- Do not submit a promotional post to r/TextToSpeech. Current moderator messages say self-promotion/advertising is removed and advertisers should use paid ads:
  https://www.reddit.com/r/TextToSpeech/comments/1uo3rrv/removed/
- Do not post to r/selfhosted unless Open TTS gains a genuine self-hosted deployment. Local/on-device is not automatically self-hosted under that community's rules.
- Do not launch into dyslexia, blindness, or general accessibility communities as a marketing tactic. Ask moderators first and seek genuine accessibility testing.
- Do not paste the same launch text into multiple subreddits.

## Draft: r/SideProject

Edit this into the developer's natural voice before posting.

**Title**

> Open TTS - an open-source, on-device speech studio and document reader

**Body**

> I've been building Open TTS, a free Apache-2.0 app for generating and listening to speech without uploading your text to a TTS service.
>
> The project has a Studio for creating/exporting audio and a Reader for long documents. The browser build runs Kokoro and Supertonic locally through WebGPU or WASM. The macOS build adds Supertonic 3 and Qwen3-TTS, including voice cloning and voice design, through a local Rust runtime.
>
> It can import EPUB and text in the browser, with more document formats on desktop, and export WAV/MP3 plus estimated captions. There is no account, API key, usage cap, or per-character charge. Models still have to download on first use.
>
> Current limitation: the packaged desktop release is only for Apple Silicon Macs on macOS 26, and it is unsigned/not notarized. The source is public.
>
> Demo: [add video or live-demo link]
>
> GitHub and download: https://github.com/cyanxxy/Local-TTS-studio
>
> I would especially value feedback on the first-run model setup: is it clear what will download and which model to choose?

## Draft: r/macOS Developer Saturday

Edit this into the developer's natural voice before posting.

**Title**

> I built an open-source, private TTS studio and document reader for Apple Silicon Macs

**Body**

> I'm the developer of Open TTS. It is a free, Apache-2.0 text-to-speech Studio and Reader that performs synthesis on your Mac instead of sending your text to a hosted inference service.
>
> I built it for two related workflows: listening to long documents and repeatedly generating narration without accounts, usage limits, or per-character charges. It supports local models including Supertonic 3 and Qwen3-TTS, document import, voice cloning/VoiceDesign where the model supports it, and WAV/MP3/caption export.
>
> The honest caveats: models download on first use, the current packaged build requires Apple Silicon and macOS 26, and it is unsigned/not notarized. The full source is available so you can inspect it or build it yourself.
>
> Demo: [add native video]
>
> Source and download: https://github.com/cyanxxy/Local-TTS-studio
>
> If you try it, I would love to know whether the Reader or Studio workflow is more useful to you—and where setup feels unclear.

## Draft: r/opensource

Edit this into the developer's natural voice and use only if the account has a healthy non-promotional history.

**Title**

> Open TTS: an Apache-2.0 local-first speech studio with WebGPU and a Rust desktop runtime

**Body**

> Disclosure: I am the developer.
>
> Open TTS is a speech Studio and long-document Reader whose built-in synthesis paths run on the user's device. The web app runs Kokoro and Supertonic in workers with WebGPU/WASM; the Electron build adds local Supertonic 3 and Qwen3-TTS runtimes through a compiled Rust bridge.
>
> There is no hosted inference server, account, API key, or usage cap. Model assets are revision-pinned and downloaded on first use. The desktop loopback service uses a per-launch in-memory capability token, and audio is streamed back as Float32 chunks for playback/export.
>
> Beyond basic generation, it includes long-document reading, local library state, bookmarks/notes, WAV and MP3 export, estimated captions, and creator-oriented pacing/pronunciation controls.
>
> Repository: https://github.com/cyanxxy/Local-TTS-studio
>
> The packaged desktop build is currently limited to an unsigned Apple Silicon/macOS 26 release. Contributions and technical feedback—especially around other practical local backends—are welcome.

## r/macapps copy skeleton

Do not finalize the AI-development line without choosing the truthful label required by the community.

**Title**

> [OS] Open TTS - local text-to-speech Studio and Reader [Free]

**Required structure**

- **Problem:** Private long-document listening and repeated narration generation should not require uploading text or paying by character.
- **Compare:** Unlike hosted readers/TTS tools, Open TTS runs its built-in inference paths on the Mac, is Apache-2.0, and has no account or usage cap. The tradeoff is large first-use model downloads and a less polished installation because the current build is unsigned.
- **Pricing + link:** Free; https://github.com/cyanxxy/Local-TTS-studio
- **Changelog/roadmap:** https://github.com/cyanxxy/Local-TTS-studio/releases and https://github.com/cyanxxy/Local-TTS-studio/issues
- **AI disclosure:** `[Vibe Coded]`, `[Human Validated]`, `[Code Completion]`, or `[None]`—select the one that accurately describes the project.

## Publishing sequence

1. Finish the release and launch preflight.
2. Publish r/SideProject with a native demo; answer every substantive comment.
3. Publish the personally written Show HN on a different day; remain available.
4. Use the first eligible Saturday for r/macOS.
5. Submit AlternativeTo and publish the DEV technical article.
6. Build real participation in r/macapps, r/opensource, and r/LocalLLaMA before posting there.
7. Launch on Product Hunt only after the homepage/live demo and media kit are ready.

Measure GitHub release clicks, stars, downloads, and issue/discussion quality by channel. Do not judge a channel only by post votes.
