// MMO Extension - Content Script
// Injects download buttons on supported streaming platforms

(function () {
    "use strict";

    // Prevent double injection
    if (window.__mmoInjected) return;
    window.__mmoInjected = true;

    const PLATFORM_CONFIGS = {
        youtube: {
            match: () => location.hostname.includes("youtube.com") && !location.hostname.includes("music.youtube.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("yt-formatted-string.ytd-watch-metadata")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector("#top-level-buttons-computed, ytd-watch-metadata #actions, #menu-container #top-level-buttons"),
            waitFor: "ytd-watch-metadata, #above-the-fold",
            isMediaPage: () => location.pathname === "/watch" || location.pathname.startsWith("/shorts/"),
        },
        youtubeMusic: {
            match: () => location.hostname === "music.youtube.com",
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector(".title.ytmusic-player-bar")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector(".middle-controls-buttons, ytmusic-player-bar .right-controls-buttons"),
            waitFor: "ytmusic-player-bar",
            isMediaPage: () => location.pathname.startsWith("/watch"),
        },
        soundcloud: {
            match: () => location.hostname.includes("soundcloud.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector(".soundTitle__title span")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector(".soundActions .sc-button-group, .listenEngagement__footer .soundActions"),
            waitFor: ".soundActions, .listenDetails",
            isMediaPage: () => {
                const path = location.pathname;
                // Track pages: /user/track-name (but not /user/sets/ or /user/likes etc.)
                const parts = path.split("/").filter(Boolean);
                return parts.length >= 2 && !["sets", "likes", "reposts", "followers", "following", "tracks", "albums", "playlists", "popular-tracks"].includes(parts[1]);
            },
        },
        spotify: {
            match: () => location.hostname.includes("spotify.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("[data-testid='context-item-info-title']")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector("[data-testid='action-bar-row']"),
            waitFor: "[data-testid='action-bar-row']",
            isMediaPage: () => location.pathname.startsWith("/track/") || location.pathname.startsWith("/album/"),
        },
        bandcamp: {
            match: () => location.hostname.includes("bandcamp.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector(".trackTitle")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector(".tralbumData .tralbumCommands, .inline_player .thumb_link")?.parentElement,
            waitFor: ".tralbumData, .inline_player",
            isMediaPage: () => location.pathname.includes("/track/") || location.pathname.includes("/album/"),
        },
        tiktok: {
            match: () => location.hostname.includes("tiktok.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("[data-e2e='browse-video-desc']")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector("[data-e2e='video-detail-action']"),
            waitFor: "[data-e2e='video-detail-action'], .video-detail",
            isMediaPage: () => location.pathname.includes("/video/"),
        },
        twitter: {
            match: () => location.hostname.includes("twitter.com") || location.hostname.includes("x.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.title,
            buttonTarget: () => document.querySelector("article [role='group']"),
            waitFor: "article [role='group']",
            isMediaPage: () => location.pathname.includes("/status/"),
        },
        generic: {
            match: () => true,
            getMediaUrl: () => location.href,
            getTitle: () => document.title,
            buttonTarget: () => null,
            waitFor: null,
            isMediaPage: () => false,
        },
    };

    let currentPlatform = null;
    let injectedButton = null;
    let settings = { baseUrl: "https://muzicai.ro", autoDownload: false, audioOnly: true };

    // Load settings
    function loadSettings() {
        browser.runtime.sendMessage({ type: "get-settings" }).then((response) => {
            if (response) settings = response;
        }).catch(() => { /* SW asleep / extension reloaded — keep defaults */ });
    }

    // Detect platform
    function detectPlatform() {
        for (const [name, config] of Object.entries(PLATFORM_CONFIGS)) {
            if (name !== "generic" && config.match()) return { name, ...config };
        }
        return null;
    }

    // Create the download button element
    function createButton(platform) {
        const btn = document.createElement("button");
        btn.id = "mmo-download-btn";
        btn.title = "Download to MMO Library";
        btn.setAttribute("aria-label", "Download to MMO Library");

        // Style varies by platform
        const platformStyles = {
            youtube: "mmo-btn-youtube",
            youtubeMusic: "mmo-btn-ytmusic",
            soundcloud: "mmo-btn-soundcloud",
            spotify: "mmo-btn-spotify",
            bandcamp: "mmo-btn-bandcamp",
            tiktok: "mmo-btn-generic",
            twitter: "mmo-btn-generic",
        };

        btn.className = `mmo-download-btn ${platformStyles[platform.name] || "mmo-btn-generic"}`;

        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span class="mmo-btn-label">MMO</span>
        `;

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const mediaUrl = platform.getMediaUrl();
            browser.runtime.sendMessage({
                type: "open-download",
                url: mediaUrl,
                autoDownload: settings.autoDownload,
            }).catch(() => { /* SW asleep — user can retry */ });

            // Visual feedback
            btn.classList.add("mmo-btn-clicked");
            setTimeout(() => btn.classList.remove("mmo-btn-clicked"), 1000);
        });

        return btn;
    }

    // Inject button into the page
    function injectButton() {
        // Remove existing button if any
        if (injectedButton) {
            injectedButton.remove();
            injectedButton = null;
        }

        const platform = detectPlatform();
        if (!platform || !platform.isMediaPage()) return;

        currentPlatform = platform;

        const target = platform.buttonTarget();
        if (!target) return;

        const btn = createButton(platform);
        injectedButton = btn;

        // Insert based on platform
        if (platform.name === "youtube") {
            // Insert as first child of the buttons container
            target.insertBefore(btn, target.firstChild);
        } else if (platform.name === "youtubeMusic") {
            target.appendChild(btn);
        } else if (platform.name === "soundcloud") {
            // Insert before the button group
            target.insertBefore(btn, target.firstChild);
        } else {
            // Generic: append to target
            target.appendChild(btn);
        }
    }

    // Wait for a selector to appear, then call callback
    function waitForElement(selector, callback, maxWait = 10000) {
        if (!selector) return;

        const existing = document.querySelector(selector);
        if (existing) {
            callback();
            return;
        }

        const observer = new MutationObserver((_mutations, obs) => {
            if (document.querySelector(selector)) {
                obs.disconnect();
                callback();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Timeout
        setTimeout(() => observer.disconnect(), maxWait);
    }

    // Initialize
    function init() {
        loadSettings();

        const platform = detectPlatform();
        if (!platform) return;

        if (platform.waitFor) {
            waitForElement(platform.waitFor, () => {
                injectButton();
            });
        } else {
            injectButton();
        }

        // Re-inject on SPA navigation (YouTube, SoundCloud, etc.)
        let lastUrl = location.href;
        const urlObserver = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                loadSettings();
                // Delay to let SPA render new content
                setTimeout(() => {
                    const p = detectPlatform();
                    if (p && p.waitFor) {
                        waitForElement(p.waitFor, injectButton);
                    } else {
                        injectButton();
                    }
                }, 1500);
            }
        });

        urlObserver.observe(document.body, { childList: true, subtree: true });

        // Also listen for popstate
        window.addEventListener("popstate", () => {
            setTimeout(() => {
                const p = detectPlatform();
                if (p && p.waitFor) {
                    waitForElement(p.waitFor, injectButton);
                } else {
                    injectButton();
                }
            }, 1000);
        });

        // Listen for yt-navigate-finish (YouTube SPA)
        document.addEventListener("yt-navigate-finish", () => {
            setTimeout(injectButton, 500);
        });
    }

    // Run when DOM is ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
