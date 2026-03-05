# <img src="https://addons.mozilla.org/user-media/addon_icons/2970/2970008-64.png" width="35px"> Speech Recognition Polyfill

![Firefox Extension Rating](https://img.shields.io/amo/rating/speech-recognition-polyfill?style=for-the-badge&label=Firefox%20Rating&logo=firefox&logoColor=white)
![Firefox Extension Users](https://img.shields.io/amo/users/speech-recognition-polyfill?style=for-the-badge&label=USERS)
![Firefox Extension Version](https://img.shields.io/amo/v/speech-recognition-polyfill?style=for-the-badge&label=VERSION)

> A Web Speech API polyfill that swaps `webkitSpeechRecognition` for Whisper, Vosk, AssemblyAI, or Google's transcription models.
>
> *All **local** AI Models used are free and don't require any major configuration.*
>
> *Most references within this repository unless stated otherwise are referring to the add-on and not ther userscript.*
> 
> *Tested with Duolingo, Google Translate, and other prominent sites. Likely work decently with other sites that utilize the API.*

> [!IMPORTANT]
>
> The following is accessed for patching sites that use `webkitSpeechRecognition`. Each serves a specific purpose:
>
> | **Permissions** | **Reason** |
> |-----------------|------------|
> | `<all_urls>`    | Inject the content script/polyfill on any page using speech. |
> | `storage`       | Save defaults and per-site overrides (engine, model, language, timeout, debug, cache, etc.). |
> | `tabs`          | Open options page on install and manage icon state with active tabs. |

## Installation Process

### Extension
| **Browser** | **Installation Steps** |
|-------------|------------------------|
| <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Firefox_logo%2C_2019.svg/1200px-Firefox_logo%2C_2019.svg.png" width="20px"> <img src="https://c.clc2l.com/c/thumbnail96webp/t/t/o/tor-browser-QaPeUi.png" width="20px"> <img src="https://upload.wikimedia.org/wikipedia/commons/d/d0/LibreWolf_icon.svg" width="20px"> <img src="https://www.waterfox.com/favicons/favicon-96x96.png" width="20px"> | **Recommended:** [Mozilla Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/speech-recognition-polyfill/)<br>- Click **Add to Firefox**<br>- ✅ Done<br>- ⭐ Rate the addon<br><br>**Alternative (dev build):**<br>- Download the latest ZIP from Releases<br>- Go to `about:debugging#/runtime/this-firefox`<br>- Click **Load Temporary Add-on…** and pick `manifest.json` (or the ZIP)<br>- ✅ Done |

### Userscript
| **Browser** | **Installation Steps** |
|-------------|------------------------|
| 🌐 Any browser | - Install a userscript manager such as Tampermonkey <br>- [Install the script from GreasyFork](https://greasyfork.org/en/scripts/568183-speech-recognition-polyfill-userscript/)<br>- Click **Install Version**<br>- ✅ Done |

`❗ Use at your own risk. The author of this userscript is not responsible for any service bans, misuse, abuse, or limits exceeded on the provided Google API keys or webchannel endpoints. These endpoints are not intended for use outside of their intended services and may be subject to change or discontinuation at any time. The original streaming architecture, protobuf definitions, and advanced cloud endpoints were designed and engineered entirely by Google. All voice transcription, inference models, and internal yet public APIs utilized by this polyfill belong to Google LLC. All rights are reserved to them.`


## Frequently Asked Questions + Model Info
| Q | A |
|---|---|
| Why are my words inaccurate? | Because you...<br> 1. Are not speaking loud, clear, and somewhat slowly.<br> 2. Switched to the smallest & fastest local model.<br> 3. Didn't set your language (for VOSK you only need to set the language specified model).<br> 4. Spoke before the local model downloaded (the extension tries to compensate for this but doesn't get it every time). |
| How do default options and site overrides work? | This is a good question and I understand the confusion. Defaults are the global settings you set in the Options page (provider, model, language, mic gain, timeouts, etc.) and they apply to every site unless a more specific rule exists. Site overrides (added via the popup or Options) target a single hostname and take priority over the defaults for that site. Only changing an override affects just that site, while changing the default in Options changes behavior everywhere without an override. |
| How do I make an [API Key](https://www.assemblyai.com/dashboard/api-keys)? | Click the link, create an account, and you’ll get a key right after signing up. There is also info in the extension. |
| Why are there only a few lanugages? | Many languages are supported, you just have to use their respected abbrievation. Though, it depends on the engine: [Vosk Supported Languages](https://alphacephei.com/vosk/models/model-list.json), [Whisper Supported Languages](https://whisper-api.com/docs/languages/), [AssemblyAI Supported Languages (V3 is streaming results, V2 is not)](https://www.assemblyai.com/docs/faq/what-languages-do-you-support-). If the language is not supported it will just default to auto/english across all models. |
| Why would anyone use normal models compared to their continuous/streaming counterparts? | There is a trade off for everything, you get faster speed but lower accuracy when using streaming-based models. This is why I give so many customization options :) |
| Is the cloud model paid? | AssemblyAI provides a free tier (IIRC, 300–500 hours). Beyond that, you'd have to pay or switch to the local models. |
| Does audio leave my device? | Local (Whisper / Vosk): **No** audio stays on-device (after the model downloads). Cloud (AssemblyAI): **Yes**, audio is uploaded for transcription. |
| Can you explain the icon indicators? | Color reflects recording/processing/error; badges show downloading/cached/done/cancel. A red/error icon often means canceled, missing API key, or unintelligible speech...Not necessarily a bad mic. It is recommended to pin the extension icon next to the New Tab icon until you get the hand of it. You can also use the toasts option if you don't want to. |
| How do I improve accuracy? | Speak loud, slow, and clear; pick the correct mic. Use a larger local model (slower) **or switch to the cloud engine** for better speed & quality. |
| How is silence handled? | Adaptive Voice Activity Detection plus a configurable silence timeout (global and per-site). |
| Can I disable it on certain sites? | Yes. You can disable the extension per-site from the popup (Extension Status) or via Site Overrides category in the options page. |
| Where are the prebuilt overrides? | You can find them linked here [HERE](https://github.com/apersongithub/Speech-Recognition-Polyfill/tree/main/prebuilt-overrides). For Duolingo, just choose the language you are learning, then download and import the override. |
| How does offline functionality work? | **Vosk** models are designed to run entirely offline after the initial download. For **Whisper**, you can try the "Cache default model" option and it will work offline until you switch the model or close the browser. |
| Why is it typing "Thanks for watching" (Whisper)? | The real answer is the local whisper models were mainly trained on YouTube videos. This only happens if you mumble a bit with no other intelligble audio being spoken. |
| Why is my browser saying my mic is recording when I've finished the speech recogntion? Stop spying on me!!! | This has been fixed in 1.5.6. If it manages to happen past that version, the GC will get it. |
| Is there a [insert chromium browser] port? | No, there are zero plans for making one. |
| What is streaming? | When you get word-to-word realtime fast speech transcription like on Chrome. I sometimes use it interchangeably with "continuous speech" but they are different. |
| Why are there CSP errors in console? | The extension uses WASM, so unsafe-eval is required for it to function. Eval() itself or similar objects are not used, only WASM so it's safe. |
| Why doesn't "Disable ultimatum processing timeouts" work? | It works, but only for models that actually use **processing** like whisper and assemblyai non-streaming. This is why it doesn't work for streaming models (I mean, how would it?). |
| Why does 5s hard cap exist? | It was there before the VAD (Voice Activity Detection) was implemented. Idk why it didn't remove it, but enjoy. |
| Is there a lite userscript version? | Yes, you can download it on [greasyfork](https://greasyfork.org/en/scripts/568183-speech-recognition-polyfill-userscript). It only supports Google's server-side transcription. Please note, there won't be any futhur updates to it.  |
| How does the userscript work? | This variant provides the fastest and most accurate speech recognition compared to the extension but has very limited customizability due to its nature (the extension is still an overall better choice lol). It features space normalization, voice activity detection, and robust solutions to work properly as a polyfill. It was created by looking into network requests (YouTube, Google, and Gemini voice search) and reverse engineering them to send and recieve data correctly, somewhat similar to the [Google Translate RE'd Public API](https://github.com/ultrafunkamsterdam/googletranslate). The APIs used in the script are all public and created by Google themselves. They are NOT random API keys from the internet and have been used by Google to provide these services for years without any rotation. One of these keys and backends are probably the exact same as what Google Chrome uses for their server-side Web Speech API implementation. This explains why they could be used cross-site without issue, otherwise this code would only be possible as an extension. |

| Name | Platform | Engine | Model ID | Notes |
|------|----------|--------|----------|-------|
| Vosk (Language Models) | Extension | Local | `vosk-model-[lang]` | Multilingual, any model < 2GB, offline |
| Whisper Tiny (EN) | Extension | Local | `Xenova/whisper-tiny.en` | English-only, fastest |
| Whisper Tiny | Extension | Local | `Xenova/whisper-tiny` | Multilingual, fast |
| Whisper Base (EN) | Extension | Local | `Xenova/whisper-base.en` | English-only, balanced |
| Whisper Base | Extension | Local | `Xenova/whisper-base` | Multilingual, balanced (default) |
| Whisper Small (EN) | Extension | Local | `Xenova/whisper-small.en` | English-only, higher quality (slower) |
| Whisper Small | Extension | Local | `Xenova/whisper-small` | Multilingual, higher quality (slower) |
| Distil-Whisper Medium (EN) | Extension | Local | `Xenova/distil-whisper-medium.en` | English-only, distilled medium (larger/slower) |
| AssemblyAI | Extension | Server | `AssemblyAI` *(API key required)* | Remote transcription; model managed by AssemblyAI |
| Google Cloud Speech v1 | Userscript | Server | `Google Cloud Speech v1` | Remote transcription; model managed by Google |
| Google Cloud Speech v2 | Userscript | Server | `Google Cloud Speech v2` | Remote transcription; model managed by Google |

**Too many [models](https://alphacephei.com/vosk/models) to list with VOSK but generally all models under 2GB are shown & supported.*

**Uses free public API Keys created by Google, not other people.*

## Compared Features

| Features | 🌟 SRP Extension |  ⭐ [SRP Userscript](https://greasyfork.org/en/scripts/568183-speech-recognition-polyfill-userscript) | [Speechfire](https://addons.mozilla.org/en-US/firefox/addon/speechfire/) | [Voice to Text with Whisper](https://addons.mozilla.org/en-US/firefox/addon/voice-to-text-with-whisper/) | [Speech Recognition Anywhere](https://chromewebstore.google.com/detail/speech-recognition-anywhe/kdnnmhpmcakdilnofmllgcigkibjonof) |
|----------|------------------------------------------|------------------------------------------|--------------------------------|---------------------------------------------|-----------------------------------|
| **Primary Backend** | ✅ Whisper + Vosk + AssemblyAI (configurable) | ✅ Google Cloud Speech-style WebChannel (`v1` / `v2`) | ⚠️ Whisper only | ⚠️ Whisper (cloud variants) | ❌ No model choice |
| **Web Speech API Polyfill** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Local (Offline) Support** | ✅ Yes (Vosk + Whisper local) | ❌ No (server-side transcription) | ✅ Whisper local | ❌ Cloud only | ❌ Cloud only |
| **Realtime Streaming** | ✅ Yes (since v1.5.0) | ✅ Yes | ❌ No true streaming | ⚠️ Limited | ⚠️ Limited |
| **Continuous Speech Mode** | ✅ Yes (configurable) | ✅ Yes | ❌ Stops after dictation | ❌ No | ⚠️ Basic continuous |
| **Partial / Interim Results** | ✅ Yes | ✅ Yes | ❌ No | ⚠️ Limited | ❌ No |
| **General Customizability** | ✅ Yes | ⚠️ Basic | ⚠️ Limited | ⚠️ Limited | ⚠️ Limited |

## Extra Tips
- Set the site language/model to the one you’re practicing for better speech recognition.
- For Google Translate, auto-language usually suffices since the site gives us information.
- ❗Do NOT forget to remove your AssemblyAI API Key if you are sharing your config.

## Contributing
- Keep permissions minimal.
- Please organize code.
- Use Debug Mode.

## [Support Me](https://html-preview.github.io/?url=https://raw.githubusercontent.com/apersongithub/Duoblock-Origin/refs/heads/main/extras/donations.html)
Thanks i need it
