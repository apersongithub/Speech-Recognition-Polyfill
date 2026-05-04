/**
 * Google Provider — UA Spoofing Module
 *
 * Spoofs the User-Agent string and related browser APIs to make the browser
 * appear as standard Chrome. This fixes issues where some websites discriminate
 * against non-Chrome browsers from using the Web Speech API.
 *
 * 7 Layers of spoofing:
 *   1. Neutralize navigator.brave
 *   2. Intercept Object.defineProperty (userscript only)
 *   3. Override navigator.userAgent string
 *   4. UA-CH brand patching
 *   5. SPA navigation hooks (userscript only)
 *   6. Periodic watchdog (userscript only)
 *   7. Proxy fetch through GM_xmlhttpRequest (userscript only)
 */
(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    window.__GP = window.__GP || {};

    // Read config from data attribute (CSP-safe, set by content.js)
    const config = JSON.parse(document.documentElement.getAttribute('data-gp-config') || '{}');
    if (config.uaSpoofEnabled === false) return;

    // Fork identifiers to strip from UA string / UA-CH brand lists
    const FORK_BRANDS = new Set([
        'brave', 'opera', 'opera gx', 'opr', 'vivaldi',
        'microsoft edge', 'edge', 'edg', 'yandex',
        'duckduckgo', 'whale', 'chromium'
    ]);

    const CHROME_BRANDS_FALLBACK = [
        { brand: 'Not/A)Brand', version: '99' },
        { brand: 'Google Chrome', version: '123' },
        { brand: 'Chromium', version: '123' }
    ];

    function isForkBrand(name) {
        const n = String(name || '').toLowerCase().trim();
        if (!n) return false;
        if (FORK_BRANDS.has(n)) return true;
        if (/\b(opr|edg|vivaldi|brave|yabrowser|whale)\b/i.test(n)) return true;
        return false;
    }

    function sanitizeBrands(items) {
        if (!Array.isArray(items)) return CHROME_BRANDS_FALLBACK;
        const out = items.filter((item) => !isForkBrand(item?.brand));
        if (!out.some((x) => String(x?.brand).toLowerCase() === 'google chrome')) {
            const v = (out.find((x) => /chrom/i.test(String(x?.brand || '')))?.version) || '123';
            out.push({ brand: 'Google Chrome', version: String(v) });
        }
        return out.length ? out : CHROME_BRANDS_FALLBACK;
    }

    function sanitizeUA(ua) {
        if (!ua || typeof ua !== 'string') return ua;
        let s = ua;
        s = s.replace(/\s(OPR|EdgA?|Brave|Vivaldi|YaBrowser|Whale|DuckDuckGo)\/[^\s)]+/gi, '');
        s = s.replace(/\sOpera\/[^\s)]+/gi, '');
        s = s.replace(/\s{2,}/g, ' ').trim();
        return s;
    }

    // ---- Layer 1: Aggressively neutralize navigator.brave ----
    const braveTrap = { configurable: false, enumerable: false, get() { return undefined; }, set() { } };
    try { Object.defineProperty(Navigator.prototype, 'brave', braveTrap); } catch { }
    try { Object.defineProperty(navigator, 'brave', braveTrap); } catch { }

    // Layers 2, 5, 6, 7 are only safe in the Tampermonkey/Greasemonkey userscript
    // context where GM_xmlhttpRequest is available.
    const _isUserscriptContext = (typeof GM_xmlhttpRequest !== 'undefined');

    // ---- Layer 2: Intercept Object.defineProperty itself ----
    const _origDefineProperty = Object.defineProperty;
    if (_isUserscriptContext) {
        Object.defineProperty = function (obj, prop, desc) {
            if (prop === 'brave' && (obj === Navigator.prototype || obj === navigator ||
                (typeof Navigator !== 'undefined' && obj instanceof Navigator))) {
                return obj;
            }
            return _origDefineProperty.call(this, obj, prop, desc);
        };
        try {
            _origDefineProperty(Object.defineProperty, 'toString', {
                value: () => 'function defineProperty() { [native code] }'
            });
        } catch { }
    }

    // ---- Layer 3: Override navigator.userAgent string ----
    const cleanUA = sanitizeUA(navigator.userAgent);
    try {
        _origDefineProperty(Navigator.prototype, 'userAgent', {
            configurable: false, enumerable: true,
            get() { return cleanUA; }
        });
    } catch { }

    // ---- Layer 4: UA-CH brand patching ----
    const uaData = navigator.userAgentData;
    if (uaData && window.NavigatorUAData && NavigatorUAData.prototype) {
        try {
            const spoofedBrands = sanitizeBrands(uaData.brands);
            _origDefineProperty(NavigatorUAData.prototype, 'brands', {
                configurable: false, enumerable: true,
                get() { return spoofedBrands; }
            });

            const originalGHEV = NavigatorUAData.prototype.getHighEntropyValues;
            if (typeof originalGHEV === 'function') {
                _origDefineProperty(NavigatorUAData.prototype, 'getHighEntropyValues', {
                    configurable: false, enumerable: true,
                    value: async function getHighEntropyValues(hints) {
                        const results = await originalGHEV.call(this, hints);
                        if (results && typeof results === 'object') {
                            if (Array.isArray(results.brands))
                                results.brands = sanitizeBrands(results.brands);
                            if (Array.isArray(results.fullVersionList))
                                results.fullVersionList = sanitizeBrands(results.fullVersionList);
                        }
                        return results;
                    }
                });
                _origDefineProperty(NavigatorUAData.prototype.getHighEntropyValues, 'toString', {
                    value: () => 'function getHighEntropyValues() { [native code] }'
                });
            }
        } catch { }
    }

    // ---- Layers 5, 6, 7: Only in userscript context ----
    if (_isUserscriptContext) {
        // ---- Layer 5: SPA navigation hooks ----
        function verifyOverrides() {
            if (navigator.brave) {
                try { _origDefineProperty(navigator, 'brave', braveTrap); } catch { }
            }
        }
        const _pushState = history.pushState;
        const _replaceState = history.replaceState;
        history.pushState = function () {
            const r = _pushState.apply(this, arguments);
            verifyOverrides();
            return r;
        };
        history.replaceState = function () {
            const r = _replaceState.apply(this, arguments);
            verifyOverrides();
            return r;
        };
        window.addEventListener('popstate', verifyOverrides);

        // ---- Layer 6: Periodic watchdog (fallback) ----
        let watchdogRuns = 0;
        const watchdog = setInterval(() => {
            verifyOverrides();
            watchdogRuns++;
            if (watchdogRuns >= 60) clearInterval(watchdog);
        }, 2000);

        // ---- Layer 7: Proxy fetch through GM_xmlhttpRequest ----
        const _pageFetch = W.fetch;
        const _chromeVer = (W.navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '146';
        const _spoofedSecCHUA = `"Google Chrome";v="${_chromeVer}", "Chromium";v="${_chromeVer}", "Not-A.Brand";v="24"`;

        W.fetch = function (input, init) {
            let url, method, headers = {}, body;
            try {
                if (typeof input === 'string') {
                    url = input;
                } else if (input && typeof input === 'object' && input.url) {
                    url = input.url;
                    method = input.method;
                    try { for (const [k, v] of input.headers.entries()) headers[k] = v; } catch { }
                } else {
                    url = String(input);
                }

                if (init) {
                    if (init.method) method = init.method;
                    if (init.body !== undefined) body = init.body;
                    if (init.headers) {
                        try {
                            const h = (init.headers instanceof W.Headers)
                                ? init.headers
                                : new W.Headers(init.headers);
                            for (const [k, v] of h.entries()) headers[k] = v;
                        } catch {
                            if (typeof init.headers === 'object') Object.assign(headers, init.headers);
                        }
                    }
                }
                method = method || 'GET';

                const fullUrl = url.startsWith('/') ? location.origin + url : url;
                const isSameOrigin = fullUrl.startsWith(location.origin);

                if (!isSameOrigin) return _pageFetch.call(W, input, init);

                headers['Sec-CH-UA'] = _spoofedSecCHUA;
                headers['Sec-CH-UA-Mobile'] = '?0';
                headers['Sec-CH-UA-Platform'] = '"Windows"';

                return new W.Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: method,
                        url: fullUrl,
                        headers: headers,
                        data: body,
                        anonymous: false,
                        responseType: 'text',
                        onload(resp) {
                            const rh = new W.Headers();
                            (resp.responseHeaders || '').split(/\r?\n/).forEach(line => {
                                const i = line.indexOf(':');
                                if (i > 0) rh.append(line.substring(0, i).trim(), line.substring(i + 1).trim());
                            });
                            resolve(new W.Response(resp.responseText, {
                                status: resp.status,
                                statusText: resp.statusText,
                                headers: rh,
                            }));
                        },
                        onerror() {
                            reject(new W.TypeError('Network request failed'));
                        },
                    });
                });
            } catch { }
            return _pageFetch.call(W, input, init);
        };
    } // end _isUserscriptContext guard
})();
