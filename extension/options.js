// MMO Extension - Options Script

document.addEventListener("DOMContentLoaded", () => {
    const baseUrlInput = document.getElementById("baseUrl");
    const autoDownloadInput = document.getElementById("autoDownload");
    const audioOnlyInput = document.getElementById("audioOnly");
    const saveBtn = document.getElementById("save");
    const savedMsg = document.getElementById("saved-msg");

    // Load saved settings
    chrome.storage.sync.get(["baseUrl", "autoDownload", "audioOnly"], (data) => {
        baseUrlInput.value = data.baseUrl || "https://muzicai.ro";
        autoDownloadInput.checked = data.autoDownload || false;
        audioOnlyInput.checked = data.audioOnly !== false; // default true
    });

    // Save settings
    saveBtn.addEventListener("click", () => {
        const settings = {
            baseUrl: baseUrlInput.value.replace(/\/+$/, "") || "https://muzicai.ro",
            autoDownload: autoDownloadInput.checked,
            audioOnly: audioOnlyInput.checked,
        };

        chrome.storage.sync.set(settings, () => {
            savedMsg.style.display = "inline";
            setTimeout(() => { savedMsg.style.display = "none"; }, 2000);
        });
    });
});
