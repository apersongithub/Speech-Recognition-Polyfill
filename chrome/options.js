document.addEventListener('DOMContentLoaded', () => {
    const serverMode = document.getElementById('server-mode');
    const micIdle = document.getElementById('mic-idle');
    const browserRacismFix = document.getElementById('browser-racism-fix');
    const devMode = document.getElementById('dev-mode');
    const resetBtn = document.getElementById('reset-btn');
    const status = document.getElementById('status');

    // Custom select dropdown logic
    const customSelect = document.getElementById('custom-server-select');
    const trigger = customSelect.querySelector('.custom-select-trigger');
    const selectedText = trigger.querySelector('.selected-text');
    const customOptions = customSelect.querySelectorAll('.custom-option');

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        customSelect.classList.toggle('active');
    });

    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            customSelect.classList.toggle('active');
        }
    });

    document.addEventListener('click', () => {
        customSelect.classList.remove('active');
    });

    const backendDesc = document.getElementById('backend-description');
    const backendDescs = {
        v2: "<strong>Google Chirp v2:</strong> Google's modern, high-performance speech model. Translates speech with automatic punctuation insertion over binary streams (Recommended).",
        v1: "<strong>Google Chirp v1:</strong> Legacy JSON-based speech model. Fast speech recognition but lacks automatic punctuation insertion."
    };

    function updateBackendDesc(value) {
        if (backendDesc && backendDescs[value]) {
            backendDesc.innerHTML = backendDescs[value];
        }
    }

    customOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            const val = opt.getAttribute('data-value');
            serverMode.value = val;
            
            customOptions.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            selectedText.textContent = opt.querySelector('span').textContent;
            updateBackendDesc(val);
            
            saveSettings();
        });
    });

    function syncCustomSelect(value) {
        const matchingOpt = [...customOptions].find(o => o.getAttribute('data-value') === value);
        if (matchingOpt) {
            customOptions.forEach(o => o.classList.remove('selected'));
            matchingOpt.classList.add('selected');
            selectedText.textContent = matchingOpt.querySelector('span').textContent;
            updateBackendDesc(value);
        }
    }

    const getTheme = () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    chrome.runtime.sendMessage({ type: 'THEME_UPDATE', theme: getTheme() });

    const defaultSettings = {
        SERVER_MODE: 'v2',
        DEV_MODE: true,
        BROWSER_RACISM_FIX: true,
        MIC_IDLE_TIMEOUT_MS: 5000
    };

    function showStatus(msg) {
        status.textContent = msg;
        status.classList.remove('saved-pulse');
        // trigger reflow
        void status.offsetWidth;
        status.classList.add('saved-pulse');
        setTimeout(() => {
            status.classList.remove('saved-pulse');
        }, 2000);
    }

    function saveSettings() {
        chrome.storage.sync.set({
            SERVER_MODE: serverMode.value,
            DEV_MODE: devMode.checked,
            BROWSER_RACISM_FIX: browserRacismFix.checked,
            MIC_IDLE_TIMEOUT_MS: parseInt(micIdle.value, 10) || 5000
        }, () => {
            showStatus('Settings auto-saved!');
        });
    }

    function loadSettings(settings) {
        serverMode.value = settings.SERVER_MODE;
        syncCustomSelect(settings.SERVER_MODE);
        micIdle.value = settings.MIC_IDLE_TIMEOUT_MS;
        browserRacismFix.checked = settings.BROWSER_RACISM_FIX;
        devMode.checked = settings.DEV_MODE;
    }

    // Load settings initially
    chrome.storage.sync.get(defaultSettings, (items) => {
        loadSettings(items);
    });

    // Auto-save listeners
    serverMode.addEventListener('change', saveSettings);
    micIdle.addEventListener('change', saveSettings);
    micIdle.addEventListener('keyup', saveSettings);
    browserRacismFix.addEventListener('change', saveSettings);
    devMode.addEventListener('change', saveSettings);

    // Reset button
    resetBtn.addEventListener('click', () => {
        loadSettings(defaultSettings);
        saveSettings();
        showStatus('Settings reset to default!');
    });
});
