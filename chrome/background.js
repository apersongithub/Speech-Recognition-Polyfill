let currentTheme = 'dark'; // Default to dark so the initial icon is White
const iconCache = {};
const tabStates = {};

async function getIconImageData(imagePath, color) {
    const cacheKey = imagePath + color;
    if (iconCache[cacheKey]) return iconCache[cacheKey];

    const url = chrome.runtime.getURL(imagePath);
    let bitmap;
    
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        bitmap = await createImageBitmap(blob);
    } catch (e) {
        console.error("Failed to load image:", imagePath, e);
        return null;
    }
    
    const canvas = new OffscreenCanvas(16, 16);
    const ctx = canvas.getContext('2d');
    
    // Apply filters for theme colors
    if (color === '#ffffff') {
        ctx.filter = 'brightness(0) invert(1)'; // White
    } else if (color === '#6b7280') {
        ctx.filter = 'brightness(0) invert(0.5)'; // Gray
    } else {
        ctx.filter = 'none';
    }

    ctx.drawImage(bitmap, 0, 0, 16, 16);
    
    // Fallback tinting for state-specific colors (blue/red)
    if (color && color !== '#ffffff' && color !== '#6b7280') {
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 16, 16);
        ctx.globalCompositeOperation = 'source-over';
    }
    
    const imageData = ctx.getImageData(0, 0, 16, 16);
    iconCache[cacheKey] = imageData;
    return imageData;
}

async function updateIcon(tabId, state) {
    if (tabId) tabStates[tabId] = state;
    
    const isDark = currentTheme === 'dark';
    const defaultColor = isDark ? '#ffffff' : '#6b7280'; // White or Gray

    try {
        if (state === 'recording') {
            const imageData = await getIconImageData('images/microphone.png', '#3b82f6'); // Recording (Blue)
            if (!imageData) return;
            if (tabId) {
                chrome.action.setIcon({ imageData, tabId });
                chrome.action.setBadgeText({ text: "REC", tabId });
                chrome.action.setBadgeBackgroundColor({ color: "#3b82f6", tabId });
            } else {
                chrome.action.setIcon({ imageData });
            }
        } else if (state === 'cancel') {
            const imageData = await getIconImageData('images/cancel.svg', '#ef4444'); // Cancel (Red)
            if (!imageData) return;
            if (tabId) {
                chrome.action.setIcon({ imageData, tabId });
                chrome.action.setBadgeText({ text: "", tabId });
            } else {
                chrome.action.setIcon({ imageData });
            }
            setTimeout(() => {
                if (!tabId || tabStates[tabId] === 'cancel') {
                    updateIcon(tabId, 'idle');
                }
            }, 2000);
        } else {
            // idle
            const imageData = await getIconImageData('images/microphone.png', defaultColor);
            if (!imageData) return;
            if (tabId) {
                chrome.action.setIcon({ imageData, tabId });
                chrome.action.setBadgeText({ text: "", tabId });
            } else {
                chrome.action.setIcon({ imageData });
            }
        }
    } catch (err) {
        console.error("Failed to set icon:", err);
    }
}

// Set initial icon on startup (will be White since currentTheme is 'dark')
updateIcon(undefined, 'idle');

chrome.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab ? sender.tab.id : undefined;
    if (msg.type === 'THEME_UPDATE') {
        currentTheme = msg.theme;
        updateIcon(undefined, 'idle'); // Update global default icon
        if (tabId) updateIcon(tabId, 'idle'); // Update tab-specific icon
    } else if (msg.type === 'SPEECH_STATE') {
        if (msg.theme) currentTheme = msg.theme;
        updateIcon(tabId, msg.state);
    }
});
