# <img src="https://addons.mozilla.org/user-media/addon_icons/2970/2970008-64.png" width="35px"> Speech Recognition Polyfill

![Firefox Extension Rating](https://img.shields.io/amo/rating/speech-recognition-polyfill?style=for-the-badge&label=Firefox%20Rating&logo=firefox&logoColor=white)
![Firefox Extension Users](https://img.shields.io/amo/users/speech-recognition-polyfill?style=for-the-badge&label=USERS)
![Firefox Extension Version](https://img.shields.io/amo/v/speech-recognition-polyfill?style=for-the-badge&label=VERSION)

> A Web Speech API polyfill that swaps `webkitSpeechRecognition` for local Whisper, Vosk, and cloud based AssemblyAI transcription.
>
> *All **local** AI Models used are free and don't require any major configuration.*
> 
> *Tested with Duolingo and Google Translate. May work decently with other sites that utilize the API..*

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
| How do I make an [API Key](https://www.assemblyai.com/dashboard/api-keys)? | Click the link, create an account, and you’ll get a key right after signing up. |
| Where are the rest of the languages? | You can add them yourself by manually editing your config and using their respected international abbreviations. Look in the local overrides folder for an example. |
| Is the cloud model paid? | AssemblyAI provides a free tier (IIRC, 300–500 hours/month). Beyond that, you have to pay or switch to the local model. |
| Does audio leave my device? | Local (Whisper / Vosk): **No** audio stays on-device (after the model downloads). Cloud (AssemblyAI): **Yes**, audio is uploaded for transcription. |
| Can you explain the icon indicators? | Color reflects recording/processing/error; badges show downloading/cached/done/cancel. A red/error icon often means canceled, missing API key, or unintelligible speech...Not necessarily a bad mic. Pin the icon to monitor state. |
| How do I improve accuracy? | Speak loud, slow, and clear; pick the correct mic. Use a larger local model (slower) **or switch to the cloud engine** for better speed & quality. |
| How is silence handled? | Adaptive Voice Activity Detection plus a configurable silence timeout (global and per-site). |
| Can I disable it on certain sites? | Yes. You can disable the extension per-site from the popup (Extension Status) or via a Site Override. |
| Where are the prebuilt overrides? | You can find them linked here [HERE](https://github.com/apersongithub/Speech-Recognition-Polyfill/tree/main/prebuilt-overrides). For Duolingo, just choose the language you are learning, then download and import the override. |
| How does offline functionality work? | **Vosk** models are designed to run entirely offline after the initial download. For **Whisper**, you can try the "Cache default model" option and it will work offline until you switch the model or close the browser. |
| Why is it typing "Thanks for watching"? | The real answer is the local whisper models were mainly trained on YouTube videos. This only happens if you mumble a bit with no other intelligble audio being spoken. |

| Engine | Vosk (Default) | Whisper | AssemblyAI |
| :--- | :--- | :--- | :--- |
| Type | Local (On-device) | Local (On-device) | Cloud (Remote Server) |
| Offline | ✅ Fully Offline | ⚠️ Partial (Cached) | ❌ Online Only |
| Streaming | ✅ True Streaming | ❌ Batch Processing | ✅ True Streaming |
| Privacy | High (Device only) | High (Device only) | Equivalent to Chrome (Uploaded) |
| Speed | Fastest | Slower | Fast |
| Accuracy | Medicore | High | Very High |

| Engine          | Model ID                       | Notes                                |
|-----------------|--------------------------------|--------------------------------------|
| Local Whisper   | `Xenova/whisper-tiny.en`       | English-only, fastest                |
| Local Whisper   | `Xenova/whisper-tiny`          | Multilingual, fast                   |
| Local Whisper   | `Xenova/whisper-base.en`       | English-only, balanced               |
| Local Whisper   | `Xenova/whisper-base`          | Multilingual, balanced (default)     |
| Local Whisper   | `Xenova/whisper-small.en`      | English-only, higher quality (slower)|
| Local Whisper   | `Xenova/whisper-small`         | Multilingual, higher quality (slower)|
| Local Whisper   | `Xenova/distil-whisper-medium.en` | English-only, distilled medium (larger/slower) |
| Local Vosk      | `vosk-model-small-[lang]`      | Multilingual (fr, de, es, ru, etc.), offline |
| Cloud           | `AssemblyAI` *(API key required)* | Remote transcription; model managed by AssemblyAI |

## Extra Tips
- For learning sites (e.g., Duolingo): set the site language to the one you’re practicing for better speech recognition.
  - For Google Translate, auto-language usually suffices since the site gives us information.
- ❗Do NOT forget to remove your AssemblyAI API Key if you are sharing your config.

## Contributing
- Keep permissions minimal.
- Please organize code.
- Use Debug Mode.

## [Support Me](https://html-preview.github.io/?url=https://raw.githubusercontent.com/apersongithub/Duoblock-Origin/refs/heads/main/extras/donations.html)
Thanks i need it
