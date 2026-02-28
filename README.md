# <img src="https://addons.mozilla.org/user-media/addon_icons/2970/2970008-64.png" width="35px"> Speech Recognition Polyfill

![Firefox Extension Rating](https://img.shields.io/amo/rating/speech-recognition-polyfill?style=for-the-badge&label=Firefox%20Rating&logo=firefox&logoColor=white)
![Firefox Extension Users](https://img.shields.io/amo/users/speech-recognition-polyfill?style=for-the-badge&label=USERS)
![Firefox Extension Version](https://img.shields.io/amo/v/speech-recognition-polyfill?style=for-the-badge&label=VERSION)

> A Web Speech API polyfill that swaps `webkitSpeechRecognition` for local Whisper, Vosk, and cloud based AssemblyAI transcription.
>
> *All **local** AI Models used are free and don't require any major configuration.*
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
| **Browser** | **Installation Steps** |
|-------------|------------------------|
| <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Firefox_logo%2C_2019.svg/1200px-Firefox_logo%2C_2019.svg.png" width="20px"> <img src="https://c.clc2l.com/c/thumbnail96webp/t/t/o/tor-browser-QaPeUi.png" width="20px"> <img src="https://upload.wikimedia.org/wikipedia/commons/d/d0/LibreWolf_icon.svg" width="20px"> <img src="https://www.waterfox.com/favicons/favicon-96x96.png" width="20px"> | **Recommended:** [Mozilla Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/speech-recognition-polyfill/)<br>- Click **Add to Firefox**<br>- ✅ Done<br>- ⭐ Rate the addon<br><br>**Alternative (dev build):**<br>- Download the latest ZIP from Releases<br>- Go to `about:debugging#/runtime/this-firefox`<br>- Click **Load Temporary Add-on…** and pick `manifest.json` (or the ZIP)<br>- ✅ Done |

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
| Why is my browser saying my mic is recording when I've finished the speech recogntion? Stop spying on me!!! | I've mostly fixed this in v1.5.3 (goes away after like 5s now) but its not worth the time to fix it more since its more trivial now. Before this, it would stay on intermittently until tab closure or GC times out. If it makes you feel better, this trival issue only happens on local models. |
| Is there a [insert chromium browser] port? | No, there are zero plans for making one. |
| What is streaming? | When you get word-to-word realtime fast speech transcription like on Chrome. I sometimes use it interchangeably with "continuous speech" but they are different. |
| Why are there CSP errors in console? | The extension uses WASM, so unsafe-eval is required for it to function. Eval() itself or similar objects are not used, only WASM so it's safe. |
| Why doesn't "Disable ultimatum processing timeouts" work? | It works, but only for models that actually use **processing** like whisper and assemblyai non-streaming. This is why it doesn't work for streaming models (I mean, how would it?). |
| Why does 5s hard cap exist? | It was there before the VAD (Voice Activity Detection) was implemented. Idk why it didn't remove it, but enjoy. |


| Engine          | Model ID                       | Notes                                |
|-----------------|--------------------------------|--------------------------------------|
| Local Vosk      | `vosk-model-[lang]`      | Multilingual, Any model < 2GB, offline |
| Local Whisper   | `Xenova/whisper-tiny.en`       | English-only, fastest                |
| Local Whisper   | `Xenova/whisper-tiny`          | Multilingual, fast                   |
| Local Whisper   | `Xenova/whisper-base.en`       | English-only, balanced               |
| Local Whisper   | `Xenova/whisper-base`          | Multilingual, balanced (default)     |
| Local Whisper   | `Xenova/whisper-small.en`      | English-only, higher quality (slower)|
| Local Whisper   | `Xenova/whisper-small`         | Multilingual, higher quality (slower)|
| Local Whisper   | `Xenova/distil-whisper-medium.en` | English-only, distilled medium (larger/slower) |
| Cloud           | `AssemblyAI` *(API key required)* | Remote transcription; model managed by AssemblyAI |

**Too many [models](https://alphacephei.com/vosk/models) to list with VOSK but generally all models under 2GB are shown & supported.*

## Compared Features
| Features | Speech Recognition Polyfill | [Speechfire](https://addons.mozilla.org/en-US/firefox/addon/speechfire/) | [Voice to Text with Whisper](https://addons.mozilla.org/en-US/firefox/addon/voice-to-text-with-whisper/) | [Speech Recognition Anywhere](https://chromewebstore.google.com/detail/speech-recognition-anywhe/kdnnmhpmcakdilnofmllgcigkibjonof) |
|----------|--------------------------------------|------------|----------------------------|------------------------------|
| **Providers** | ✅ Whisper + Vosk (Several Models) + AssemblyAI | ⚠️ Whisper only | ⚠️ Whisper (cloud variants) | ❌ No model choice |
| **Web Speech API Polyfill** | ✅ Yes (replaces `webkitSpeechRecognition`) | ❌ No | ❌ No | ❌ No |
| **Local (Offline) Support** | ✅ Vosk + Whisper local | ✅ Whisper local | ❌ Cloud only | ❌ Cloud only |
| **Realtime Streaming** | ✅ Yes (since v1.5.0) | ❌ No true streaming | ⚠️ Limited | ⚠️ Limited |
| **Continuous Speech Mode** | ✅ Yes (configurable) | ❌ Stops after dictation | ❌ No | ⚠️ Basic continuous |
| **Partial / Interim Results** | ✅ Yes (streaming engines) | ❌ No | ⚠️ Limited | ❌ No |
| **Per-Site Customization** | ✅ Yes | ❌ No | ❌ No | ❌ No |

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
