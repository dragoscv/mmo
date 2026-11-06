// MixAI Connector (store edition) — options: only the library address.

document.addEventListener("DOMContentLoaded", () => {
    applyI18n();
    const title = t("optionsTitle");
    if (title) document.title = title;

    const input = document.getElementById("libraryUrl");
    const saveBtn = document.getElementById("save");
    const savedMsg = document.getElementById("saved-msg");

    browser.storage.sync.get(["libraryUrl"]).then((data) => {
        input.value = data.libraryUrl || "https://app.mixai.ro";
    });

    saveBtn.addEventListener("click", () => {
        let value = input.value.trim().replace(/\/+$/, "") || "https://app.mixai.ro";
        try {
            const u = new URL(value);
            if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("https only");
        } catch {
            input.setAttribute("aria-invalid", "true");
            input.focus();
            return;
        }
        input.removeAttribute("aria-invalid");
        browser.storage.sync.set({ libraryUrl: value }).then(() => {
            savedMsg.style.display = "inline";
            setTimeout(() => { savedMsg.style.display = "none"; }, 2000);
        });
    });
});
