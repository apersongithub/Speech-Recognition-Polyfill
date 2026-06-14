const fs = require('fs');
const contentCode = fs.readFileSync('content.js', 'utf8');
const polyfillCode = fs.readFileSync('polyfill.js', 'utf8');
const safePolyfillCode = JSON.stringify(polyfillCode);

let newCode = contentCode;
let changes = [];

// 1. Replace localStorage flag check with document.cookie (fast, no disk I/O)
const oldFlagCheck = /try \{\s*if \(window\.localStorage\.getItem\('__speech_polyfill_disabled_flag__'\) === '1'\) \{\s*extensionEnabledForSite = false;\s*\}\s*\} catch \(e\) \{ \}/;
if (oldFlagCheck.test(newCode)) {
  newCode = newCode.replace(oldFlagCheck, `try {
  if (document.cookie.includes('__sp_disabled=1')) {
    extensionEnabledForSite = false;
  }
} catch (e) { }`);
  changes.push('1. Replaced localStorage flag check with document.cookie');
} else {
  changes.push('1. SKIP - localStorage flag check not found (already changed?)');
}

// 2. Replace localStorage in resolveEffectiveSettings with document.cookie
const oldCacheBlock = /\/\/ Synchronously cache the disabled flag for the next page load[\s\S]*?window\.localStorage\.removeItem\('__speech_polyfill_disabled_flag__'\);\s*\}\s*\} catch \(e\) \{ \}/;
if (oldCacheBlock.test(newCode)) {
  newCode = newCode.replace(oldCacheBlock, `// Synchronously cache the disabled flag using a cookie (no disk I/O)
    try {
      if (!isEnabledBySettings) {
        document.cookie = "__sp_disabled=1; path=/; max-age=31536000; SameSite=Lax";
      } else {
        document.cookie = "__sp_disabled=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
      }
    } catch (e) { }`);
  changes.push('2. Replaced localStorage cache with document.cookie in resolveEffectiveSettings');
} else {
  changes.push('2. SKIP - resolveEffectiveSettings localStorage not found');
}

// 3. Inline polyfill in injectPolyfill function (eliminate XHR)
const xhrInlineBlock = /if \(\!asyncFallback && inlineAllowed\) \{[\s\S]*?console\.warn\('\[Speech Polyfill\] Synchronous injection failed, falling back to async', e\);\s*\}\s*\}/;
if (xhrInlineBlock.test(newCode)) {
  newCode = newCode.replace(xhrInlineBlock, `if (!asyncFallback && inlineAllowed) {
    const s = document.createElement('script');
    s.textContent = ${safePolyfillCode};
    (document.head || document.documentElement).prepend(s);
    s.remove();
    return;
  }`);
  changes.push('3. Inlined polyfill in injectPolyfill (eliminated XHR)');
} else {
  changes.push('3. SKIP - XHR inline block not found');
}

// 4. Inline polyfill in injectPolyfillTrulySync (eliminate XHR)
const trulySyncXhr = /try \{\s*const xhr = new XMLHttpRequest\(\);[\s\S]*?dbg\('polyfill_injected_truly_sync'\);\s*\} catch \(e\) \{\s*console\.error\('\[Whisper\] Sync polyfill injection failed:', e\);\s*\}/;
if (trulySyncXhr.test(newCode)) {
  newCode = newCode.replace(trulySyncXhr, `const script = document.createElement('script');
  script.textContent = ${safePolyfillCode};
  (document.head || document.documentElement).prepend(script);
  script.remove();
  document.documentElement.setAttribute('data-whisper-polyfill-injected', '1');
  dbg('polyfill_injected_truly_sync');`);
  changes.push('4. Inlined polyfill in injectPolyfillTrulySync (eliminated XHR)');
} else {
  changes.push('4. SKIP - injectPolyfillTrulySync XHR not found');
}

// 5. Replace Google provider sync XHR with async script src
const gpXhr = /for \(const src of scripts\) \{[\s\S]*?console\.error\(`\[Whisper\] Exception loading \$\{src\}:`, e\);\s*\}\s*\}/;
if (gpXhr.test(newCode)) {
  newCode = newCode.replace(gpXhr, `for (const src of scripts) {
      const url = browser.runtime.getURL(src);
      const s = document.createElement('script');
      s.src = url;
      s.async = false;
      (document.head || document.documentElement).prepend(s);
      s.onload = () => s.remove();
    }`);
  changes.push('5. Replaced Google provider XHR with async script src');
} else {
  changes.push('5. SKIP - Google provider XHR not found');
}

// 6. Change catch block default from streamingProvider=null to vosk
const catchDefaults = /streamingProvider = null;\s*\n\s*streamingActive = false;/;
if (catchDefaults.test(newCode)) {
  newCode = newCode.replace(catchDefaults, `streamingProvider = 'vosk';\r\n    streamingActive = true;`);
  changes.push('6. Changed catch block default from null to vosk');
} else {
  changes.push('6. SKIP - catch block streamingProvider=null not found');
}

fs.writeFileSync('content.js', newCode);
console.log('All changes applied:');
changes.forEach(c => console.log('  ' + c));
