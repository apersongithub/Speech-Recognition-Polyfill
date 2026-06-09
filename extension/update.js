const manifest = browser.runtime.getManifest();
const params = new URLSearchParams(location.search);
const version = params.get('version') || manifest.version;
const previous = params.get('previous') || '';
const updateInfoUrl = `https://addons.mozilla.org/en-US/firefox/addon/speech-recognition-polyfill/versions/${encodeURIComponent(version)}/updateinfo/`;

const versionEl = document.getElementById('update-version');
const summaryEl = document.getElementById('update-summary');
const notesEl = document.getElementById('update-notes');
const amoButton = document.getElementById('open-amo');
const optionsButton = document.getElementById('open-options');

if (versionEl) versionEl.textContent = previous ? `Version ${version} from ${previous}` : `Version ${version}`;
if (summaryEl) summaryEl.textContent = 'Fetching the published update notes for this version.';

function clearNotes() {
    if (!notesEl) return;
    while (notesEl.firstChild) notesEl.removeChild(notesEl.firstChild);
}

function appendParagraph(text) {
    if (!notesEl || !text) return;
    const p = document.createElement('p');
    p.textContent = text;
    notesEl.appendChild(p);
}

function appendList(items) {
    if (!notesEl || !items.length) return;
    const ul = document.createElement('ul');
    for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
    }
    notesEl.appendChild(ul);
}

function renderFallback() {
    clearNotes();
    appendParagraph('The published AMO update notes could not be loaded from this extension context.');
    appendList([
        'Placeholder: AMO down? Check back later!'
    ]);
}

function renderFetchedNotes(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const main = doc.querySelector('main') || doc.querySelector('body');
    const text = (main?.textContent || '').replace(/\r/g, '').trim();
    const lines = text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^download/i.test(line))
        .filter(line => !/^source code/i.test(line));

    clearNotes();
    if (!lines.length) {
        renderFallback();
        return;
    }

    const heading = lines.shift();
    appendParagraph(heading);
    appendList(lines.slice(0, 24));
}

async function loadUpdateNotes() {
    try {
        const response = await fetch(updateInfoUrl, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`AMO returned ${response.status}`);
        renderFetchedNotes(await response.text());
        if (summaryEl) summaryEl.textContent = 'Release notes loaded from addons.mozilla.org.';
    } catch (error) {
        renderFallback();
        if (summaryEl) summaryEl.textContent = 'Showing local fallback notes because the AMO update page was unavailable.';
    }
}

amoButton?.addEventListener('click', () => {
    browser.tabs.create({ url: updateInfoUrl, active: true });
});

optionsButton?.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
});

loadUpdateNotes();
