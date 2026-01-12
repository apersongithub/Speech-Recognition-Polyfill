# <img src="https://addons.mozilla.org/user-media/addon_icons/2970/2970008-64.png" width="35px"> Speech Recognition Polyfill

![Firefox Extension Rating](https://img.shields.io/amo/rating/speech-recognition-polyfill?style=for-the-badge&label=Firefox%20Rating&logo=firefox&logoColor=white)
![Firefox Extension Users](https://img.shields.io/amo/users/speech-recognition-polyfill?style=for-the-badge&label=USERS)
![Firefox Extension Version](https://img.shields.io/amo/v/speech-recognition-polyfill?style=for-the-badge&label=VERSION)

> A Web Speech API polyfill that swaps `webkitSpeechRecognition` for local Whisper transcription.
>
> *All AI Models used are free and don't require any configuration.*
> 
> *Tested with Duolingo and Google Translate. May work decently with other sites that utilize the API..*

> [!IMPORTANT]
>
> The following is accessed for patching sites that use `webkitSpeechRecognition`. Each serves a specific purpose:
>
> | **Permissions** | **Reason** |
> |-----------------|------------|
> | `<all_urls>`    | Inject the content script/polyfill on any page using speech. |
> | `storage`       | Save defaults and per-site overrides (model, language, timeout, debug banners). |
> | `tabs`          | Open options page on install and manage icon state with active tabs. |

## Installation Process
| **Browser** | **Installation Steps** |
|-------------|------------------------|
| <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Firefox_logo%2C_2019.svg/1200px-Firefox_logo%2C_2019.svg.png" width="20px"> <img src="https://c.clc2l.com/c/thumbnail96webp/t/t/o/tor-browser-QaPeUi.png" width="20px"> <img src="https://upload.wikimedia.org/wikipedia/commons/d/d0/LibreWolf_icon.svg" width="20px"> <img src="https://www.waterfox.com/favicons/favicon-96x96.png" width="20px"> | **Recommended:** [Mozilla Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/speech-recognition-polyfill/)<br>- Click **Add to Firefox**<br>- ✅ Done<br>- ⭐ Rate the addon<br><br>**Alternative (dev build):**<br>- Download the latest ZIP from Releases<br>- Go to `about:debugging#/runtime/this-firefox`<br>- Click **Load Temporary Add-on…** and pick `manifest.json` (or the ZIP)<br>- ✅ Done<br>- ⭐ Pin the mic icon to see status colors |

## Frequently Asked Questions

**Does audio leave my device?**  
No. Audio is captured and transcribed locally with Xenova Whisper. Models are downloaded from CDN; inference is on-device.

**Which models are available?**  
Whisper Tiny/Base/Small (EN and multilingual) and Distil-Medium EN. Default is multilingual Tiny.

**Why might the icon turn red?**  
Indicates an error or unintelligible/no-speech detection. It auto-resets to idle.

**What do the icons on the extension logo mean?**  
If the AI model is cached or not or being downloaded.

**Can I force English-only?**  
Yes, pick a `.en` model in Options or per-site override.

**How is silence handled?**  
Silence timeout (default 1500ms) auto-stops recording; configurable globally and per site.

## Contributing
Keep permissions minimal.
Please organize code.
Use Debug Mode.

## [Support Me](https://html-preview.github.io/?url=https://raw.githubusercontent.com/apersongithub/Duoblock-Origin/refs/heads/main/extras/donations.html)
Thanks i need it