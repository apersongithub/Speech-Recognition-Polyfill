# <img src="https://addons.mozilla.org/user-media/addon_icons/2970/2970008-64.png" width="35px"> Speech Recognition Polyfill

![Firefox Extension Rating](https://img.shields.io/amo/rating/speech-recognition-polyfill?style=for-the-badge&label=Firefox%20Rating&logo=firefox&logoColor=white)
![Firefox Extension Users](https://img.shields.io/amo/users/speech-recognition-polyfill?style=for-the-badge&label=USERS)
![Firefox Extension Version](https://img.shields.io/amo/v/speech-recognition-polyfill?style=for-the-badge&label=VERSION)

<img width="700" height="400" alt="fx" src="https://github.com/user-attachments/assets/1d0ac78e-c617-4d00-9ccb-80051e14b861" />
<br>

> A Web Speech API polyfill that swaps `webkitSpeechRecognition` for Whisper, Vosk, NVIDIA Parakeet, AssemblyAI, or Google's transcription models.
>
> *All **local** AI Models used are free and don't require any major configuration.*
>
> *Most references within this repository unless stated otherwise are referring to the firefox add-on and not the userscript/chrome extension.*
> 
> *Tested with Duolingo, Google Docs, and other prominent sites. Likely work decently with other sites that utilize the API.*

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

### Firefox Extension
| **Browser** | **Installation Steps** |
|-------------|------------------------|
| <img src="https://upload.wikimedia.org/wikipedia/commons/a/a0/Firefox_logo%2C_2019.svg" width="20px"> <img src="https://c.clc2l.com/c/thumbnail96webp/t/t/o/tor-browser-QaPeUi.png" width="20px"> <img src="https://upload.wikimedia.org/wikipedia/commons/d/d0/LibreWolf_icon.svg" width="20px"> <img src="https://www.waterfox.com/favicons/favicon-96x96.png" width="20px"> | **Recommended:** [Mozilla Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/speech-recognition-polyfill/)<br>- Click **Add to Firefox**<br>- ✅ Done<br>- ⭐ Rate the addon<br><br>**Alternative (dev build):**<br>- Download the latest ZIP from [GitHub Releases](https://github.com/apersongithub/Speech-Recognition-Polyfill/releases)<br>- Go to `about:debugging#/runtime/this-firefox`<br>- Click **Load Temporary Add-on…** and pick `manifest.json` (or the ZIP)<br>- ✅ Done |

### Chromium Extension
| **Browser** | **Installation Steps** |
|-------------|------------------------|
| <img src="https://upload.wikimedia.org/wikipedia/commons/e/e1/Google_Chrome_icon_%28February_2022%29.svg" width="20px"> <img src="https://upload.wikimedia.org/wikipedia/commons/9/98/Microsoft_Edge_logo_%282019%29.svg" width="20px"> <img src="https://brave.com/static-assets/images/brave-logo-sans-text.svg" width="18px"> <img src="https://upload.wikimedia.org/wikipedia/commons/4/49/Opera_2015_icon.svg" width="20px"> | **Recommended:** [Chrome Web Store](https://chromewebstore.google.com/detail/speech-recognition-polyfi/doblhjbaejoemfphomdmppkaookicmdd)<br> - Click **Add to Chrome** <br> - ✅ Done<br>- ⭐ Rate the addon <br><br>**Alternative:** Manual Option [*Stuck?*](https://www.youtube.com/watch?v=XCQ00MlTXj8)<br>- Download the latest **Chrome** extension from the [GitHub Releases](https://github.com/apersongithub/Speech-Recognition-Polyfill/releases)<br>- Go to `chrome://extensions`<br>- Enable **Developer mode** (top right)<br>- Drag and drop the ZIP file onto the extensions page<br>- ✅ Done |

> The Chromium build is limited to Google's `v1` and `v2` server backends. It does not yet include the Firefox extension's local Whisper, Vosk, or NVIDIA Parakeet providers and advanced settings.

### Userscript
| **Script Manager** | **Installation Steps** |
|-------------|------------------------|
| <img src="https://www.tampermonkey.net/images/icon48.png" width="20px"> <img src="https://avatars.githubusercontent.com/u/13635071?s=200&v=4" width="20px"> <img src="https://addons.mozilla.org/user-media/addon_icons/0/748-64.png?modified=1531822767" width="20px"> <img src="https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/47/be/20/47be20a2-fedd-cf0b-3a35-476ae727ae01/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/400x400ia-75.webp" width="20px"> | - Install a userscript manager such as Violentmonkey <br>- [Install the script from GreasyFork](https://greasyfork.org/en/scripts/568183-speech-recognition-polyfill-userscript/)<br>- Click **Install Version**<br>- ✅ Done |

## Key Features
- Drop-in `SpeechRecognition` / `webkitSpeechRecognition` polyfill, plus a configurable **Alt + A** speech-to-text shortcut.
- Vosk is the default local provider; Whisper and NVIDIA Parakeet are also available locally in the Firefox extension.
- Real-time streaming and interim results with Vosk, NVIDIA Parakeet, AssemblyAI, and Google; Whisper transcribes after recording stops.
- Global defaults and per-site rules for provider, model, language, timeouts, and enabled state.
- Import/export settings, prebuilt overrides, model download status, and optional on-page notification toasts.
- Uses a page's language when available and supports manual language selection; exact coverage depends on the provider and model.

## Frequently Asked Questions + Model Info
| Q | A |
|---|---|
| Why are my words inaccurate? | Because you...<br> 1. Are not speaking loud, clear, and somewhat slowly.<br> 2. Switched to the smallest & fastest local model.<br> 3. Didn't set your language (for VOSK you only need to set the language specified model).<br> 4. Spoke before the local model downloaded (the extension tries to compensate for this but doesn't get it every time). |
| How do default options and site overrides work? | This is a good question and I understand the confusion. Defaults are the global settings you set in the Options page (provider, model, language, mic gain, timeouts, etc.) and they apply to every site unless a more specific rule exists. Site overrides (added via the popup or Options) target a single hostname and take priority over the defaults for that site. Only changing an override affects just that site, while changing the default in Options changes behavior everywhere without an override. |
| How do I make an [API Key](https://www.assemblyai.com/dashboard/api-keys)? | Click the link, create an account, and you’ll get a key right after signing up. There is also info in the extension. |
| Why are there only a few lanugages? | Many languages are supported, you just have to use their respected abbrievation. Though, it depends on the engine: [Vosk Supported Languages](https://alphacephei.com/vosk/models/model-list.json), [Whisper Supported Languages](https://whisper-api.com/docs/languages/), [AssemblyAI Supported Languages (V3 is streaming results, V2 is not)](https://www.assemblyai.com/docs/faq/what-languages-do-you-support-). If the language is not supported it will just default to auto/english across all models. |
| Why would anyone use normal models compared to their continuous/streaming counterparts? | There is a trade off for everything, you get faster speed but lower accuracy when using streaming-based models. This is why I give so many customization options :) |
| Is the cloud model paid? | AssemblyAI provides a free tier (IIRC, 300–500 hours). Beyond that, you'd have to pay or switch to the local models. |
| Does audio leave my device? | Local (Whisper / Vosk / NVIDIA Parakeet): **No** audio stays on-device after the model downloads. Cloud (AssemblyAI / Google): **Yes**, audio is uploaded for transcription. |
| Can you explain the icon indicators? | Color reflects recording/processing/error; badges show downloading/cached/done/cancel. A red/error icon often means canceled, missing API key, or unintelligible speech...Not necessarily a bad mic. It is recommended to pin the extension icon next to the New Tab icon until you get the hand of it. You can also use the toasts option if you don't want to. |
| How do I improve accuracy? | Speak loud, slow, and clear; pick the correct mic. Use a larger local model (slower) **or switch to the cloud engine** for better speed & quality. |
| How is silence handled? | Adaptive Voice Activity Detection plus a configurable silence timeout (global and per-site). |
| Can I disable it on certain sites? | Yes. You can disable the extension per-site from the popup (Extension Status) or via Site Overrides category in the options page. |
| Where are the prebuilt overrides? | You can find them linked here [HERE](https://github.com/apersongithub/Speech-Recognition-Polyfill/tree/main/prebuilt-overrides). For Duolingo, just choose the language you are learning, then download and import the override. |
| How does offline functionality work? | **Vosk** models are designed to run entirely offline after the initial download. For **Whisper**, you can try the "Cache default model" option and it will work offline until you switch the model or close the browser. |
| Why is it typing "Thanks for watching" (Whisper)? | The real answer is the local whisper models were mainly trained on YouTube videos. This only happens if you mumble a bit with no other intelligble audio being spoken. |
| Why is my browser saying my mic is recording when I've finished the speech recogntion? Stop spying on me!!! | This has been fixed in 1.5.6. If it manages to happen past that version, the GC will get it. |
| Is there a Chromium browser port? | Yes. Load the experimental Manifest V3 extension from the [`chrome`](chrome/) folder via `chrome://extensions` → **Developer mode** → **Load unpacked**. It currently supports Google's `v1` and `v2` server backends only. |
| What is streaming? | When you get word-to-word realtime fast speech transcription like on Chrome. I sometimes use it interchangeably with "continuous speech" but they are different. |
| Why are there CSP errors in console? | The extension uses WASM, so unsafe-eval is required for it to function. Eval() itself or similar objects are not used, only WASM so it's safe. |
| Why doesn't "Disable ultimatum processing timeouts" work? | It works, but only for models that actually use **processing** like whisper and assemblyai non-streaming. This is why it doesn't work for streaming models (I mean, how would it?). |
| Why does 5s hard cap exist? | It was there before the VAD (Voice Activity Detection) was implemented. Idk why it didn't remove it, but enjoy. |
| Is there a lite userscript version? | Yes, you can download it on [greasyfork](https://greasyfork.org/en/scripts/568183-speech-recognition-polyfill-userscript). It only supports Google's server-side transcription. Please note, there won't be any futhur updates to it.  |
| How does the userscript work? | This variant provides the fastest and most accurate speech recognition compared to the extension but has very limited customizability due to its nature (the extension is still an overall better choice lol). It features space normalization, voice activity detection, and robust solutions to work properly as a polyfill. It was created by looking into network requests (YouTube, Google, and Gemini voice search) and reverse engineering them to send and recieve data correctly, somewhat similar to the [Google Translate RE'd Public API](https://github.com/ultrafunkamsterdam/googletranslate). The APIs used in the script are all public and created by Google themselves. They are NOT random API keys from the internet and have been used by Google to provide these services for years without any rotation. One of these keys and backends are probably the exact same as what Google Chrome uses for their server-side Web Speech API implementation. This explains why they could be used cross-site without issue, otherwise this code would only be possible as an extension. |

| Name | Platform | Engine | Model ID | Notes |
|------|----------|--------|----------|-------|
| Vosk (Language Models) | Firefox Extension | Local | `vosk-model-[lang]` | Multilingual, any model < 2GB, offline |
| Whisper Tiny (EN) | Firefox Extension | Local | `Xenova/whisper-tiny.en` | English-only, fastest |
| Whisper Tiny | Firefox Extension | Local | `Xenova/whisper-tiny` | Multilingual, fast |
| Whisper Base (EN) | Firefox Extension | Local | `Xenova/whisper-base.en` | English-only, balanced |
| Whisper Base | Firefox Extension | Local | `Xenova/whisper-base` | Multilingual, balanced (default) |
| Whisper Small (EN) | Firefox Extension | Local | `Xenova/whisper-small.en` | English-only, higher quality (slower) |
| Whisper Small | Firefox Extension | Local | `Xenova/whisper-small` | Multilingual, higher quality (slower) |
| Distil-Whisper Medium (EN) | Firefox Extension | Local | `Xenova/distil-whisper-medium.en` | English-only, distilled medium (larger/slower) |
| NVIDIA Parakeet | Firefox Extension | Local | `parakeet-tdt-0.6b-v3` | Multilingual; browser ONNX model with WebGPU-hybrid/WASM support |
| NVIDIA Parakeet | Firefox Extension | Local | `parakeet-tdt-0.6b-v2` | English-only variant; large first download |
| AssemblyAI | Firefox Extension | Server | `universal-2` *(API key required)* | Streaming; model managed by AssemblyAI |
| AssemblyAI | Firefox Extension | Server | `universal-3-pro` *(API key required)* | Non-streaming; model managed by AssemblyAI |
| Google Cloud Speech | Firefox Extension | Server | `Google Cloud Speech v1_old` | Remote transcription; model managed by Google |
| Google Cloud Speech | Firefox Extension, Chromium Extension & Userscript | Server | `Google Cloud Speech v1` | Remote transcription; model managed by Google |
| Google Cloud Speech | Firefox Extension, Chromium Extension & Userscript | Server | `Google Cloud Speech v2` | Remote transcription; model managed by Google |

**Too many [models](https://alphacephei.com/vosk/models) to list with VOSK but generally all models under 2GB are shown & supported.*

**Uses Google's own public API Keys literally available on google.com/gemini.com, not other peoples'.*

**Most people will not be able to run NVIDIA Parakeet'.*

## Compared Features

| Features | 🌟 SRP Firefox Extension |  ⭐ SRP Userscript/Chrome Extension | [Speechfire](https://addons.mozilla.org/en-US/firefox/addon/speechfire/) | [Voice to Text with Whisper](https://addons.mozilla.org/en-US/firefox/addon/voice-to-text-with-whisper/) | [Speech Recognition Anywhere](https://chromewebstore.google.com/detail/speech-recognition-anywhe/kdnnmhpmcakdilnofmllgcigkibjonof) |
|----------|------------------------------------------|------------------------------------------|--------------------------------|---------------------------------------------|-----------------------------------|
| **Primary Backend** | ✅ Whisper, Vosk, Nvidia, AssemblyAI, Google (configurable) | ⚠️ Google Only (`v1` / `v2`) | ⚠️ Whisper only | ⚠️ Whisper (cloud variants) | ❌ No model choice |
| **Web Speech API Polyfill** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Local (Offline) Support** | ✅ Yes (Vosk + Whisper local) | ❌ No (server-side transcription) | ✅ Whisper local | ❌ Cloud only | ❌ Cloud only |
| **Realtime Streaming** | ✅ Yes (since v1.5.0) | ✅ Yes | ❌ No true streaming | ⚠️ Limited | ⚠️ Limited |
| **Continuous Speech Mode** | ✅ Yes (configurable) | ✅ Yes | ❌ Stops after dictation | ❌ No | ⚠️ Basic continuous |
| **Partial / Interim Results** | ✅ Yes | ✅ Yes | ❌ No | ⚠️ Limited | ❌ No |
| **Advanced Customizability** | ✅ Yes | ⚠️ Basic | ⚠️ Limited | ⚠️ Limited | ⚠️ Limited |

## Extras
- Set the site language/model to the one you’re practicing for better speech recognition.
- For Google Translate, auto-language usually suffices since the site gives us information.
- ❗Do NOT forget to remove your AssemblyAI API Key if you are sharing your config.
- ❗Use Google Cloud Providers at your own discretion. The author of this userscript is not responsible for any service bans, misuse, abuse, or limits exceeded on the provided Google API keys or webchannel endpoints. These endpoints are not intended for use outside of their intended services (Google & Gemini Voice Search) and may be subject to change or discontinuation at any time. The original streaming architecture, protobuf definitions, and advanced cloud endpoints were designed and engineered entirely by Google. All voice transcription, inference models, and internal yet public APIs utilized by this polyfill belong to Google LLC. All rights are reserved to them.

## Notes & Caveats
- On a fresh Firefox install, the extension opens its Options page; updates open the update page.
- Local models download on demand. They are not bundled with the extension, and large models can need significant RAM, CPU, GPU, disk cache, and an initial internet connection.
- **Cache default model** keeps the selected local model resident for faster reuse at the cost of memory; NVIDIA Parakeet can also be prewarmed. Browser cache eviction or clearing browser data may require a new download.
- The hotkey works on most normal text inputs, but some non-standard editors may not accept automated text insertion reliably.
- Android is not officially supported. The polyfill also does not implement every edge case of the Web Speech API.

## Contributing
- Keep permissions minimal.
- Please organize code.
- Use Debug Mode.

## [Support Me](https://html-preview.github.io/?url=https://raw.githubusercontent.com/apersongithub/Duoblock-Origin/refs/heads/main/extras/donations.html)
Thanks i need it
