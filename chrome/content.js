let cachedConfig = null;

chrome.storage.sync.get({
    SERVER_MODE: 'v2',
    DEV_MODE: true,
    BROWSER_RACISM_FIX: true,
    MIC_IDLE_TIMEOUT_MS: 5000
}, (config) => {
    cachedConfig = config;
    window.postMessage({ type: 'SPEECH_CONFIG_UPDATE', config }, '*');
});

const getTheme = () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

chrome.runtime.sendMessage({ type: 'THEME_UPDATE', theme: getTheme() });

window.addEventListener('message', (event) => {
    if (event.source === window && event.data) {
        if (event.data.type === 'SPEECH_STATE') {
            event.data.theme = getTheme();
            chrome.runtime.sendMessage(event.data);
        } else if (event.data.type === 'SPEECH_REQUEST_CONFIG') {
            if (cachedConfig) {
                window.postMessage({ type: 'SPEECH_CONFIG_UPDATE', config: cachedConfig }, '*');
            } else {
                chrome.storage.sync.get({
                    SERVER_MODE: 'v2',
                    DEV_MODE: true,
                    BROWSER_RACISM_FIX: true,
                    MIC_IDLE_TIMEOUT_MS: 5000
                }, (config) => {
                    cachedConfig = config;
                    window.postMessage({ type: 'SPEECH_CONFIG_UPDATE', config }, '*');
                });
            }
        }
    }
});
