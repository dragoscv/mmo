// MixAI Extension - Content Script
// Injects download buttons on supported streaming platforms

(function () {
    "use strict";

    // Prevent double injection
    if (window.__mixaiInjected) return;
    window.__mixaiInjected = true;

    const BUTTON_ID = "mixai-download-btn";

    // Generic SPA-friendly "is this a media page" helper: any playable
    // <video>/<audio> element in the DOM counts.
    const hasMediaElement = () => !!document.querySelector("video, audio");

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
        mixcloud: {
            match: () => location.hostname.includes("mixcloud.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("h1")?.textContent?.trim() || document.title,
            // Mixcloud's React class names are hashed; the show page always has an h1 in the header.
            buttonTarget: () => document.querySelector("h1")?.parentElement || null,
            waitFor: "h1",
            isMediaPage: () => {
                // Show pages: /user/show-slug/ (not /user/, /discover, /upload …)
                const parts = location.pathname.split("/").filter(Boolean);
                return parts.length >= 2 && !["discover", "upload", "settings", "select", "live", "search", "pro"].includes(parts[0]);
            },
            floating: true,
        },
        vimeo: {
            match: () => location.hostname.includes("vimeo.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("h1")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector("[data-clip-actions], .clip_info-actions, main h1")?.parentElement || null,
            waitFor: "main, h1",
            isMediaPage: () => /^\/(\d+|channels\/[^/]+\/\d+|[^/]+\/[^/]+)$/.test(location.pathname.replace(/\/$/, "")) && hasMediaElement(),
            floating: true,
        },
        instagram: {
            match: () => location.hostname.includes("instagram.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.title,
            buttonTarget: () => null,
            waitFor: "main",
            isMediaPage: () => /^\/(p|reel|reels|tv)\//.test(location.pathname),
            floating: true,
        },
        facebook: {
            match: () => location.hostname.includes("facebook.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.title,
            buttonTarget: () => null,
            waitFor: "[role='main']",
            isMediaPage: () => /\/(watch|videos?|reel|share\/v)\b/.test(location.pathname + location.search) || location.pathname.startsWith("/watch"),
            floating: true,
        },
        twitch: {
            match: () => location.hostname.includes("twitch.tv"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("[data-a-target='stream-title'], h2[title]")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector(".channel-info-content, [data-a-target='player-controls']")?.parentElement || null,
            waitFor: "video",
            // VODs and clips are downloadable; live channel pages are not.
            isMediaPage: () => location.pathname.startsWith("/videos/") || location.hostname.startsWith("clips.") || location.pathname.includes("/clip/"),
            floating: true,
        },
        dailymotion: {
            match: () => location.hostname.includes("dailymotion.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("h1")?.textContent?.trim() || document.title,
            buttonTarget: () => document.querySelector("h1")?.parentElement || null,
            waitFor: "h1, video",
            isMediaPage: () => location.pathname.startsWith("/video/"),
            floating: true,
        },
        deezer: {
            match: () => location.hostname.includes("deezer.com"),
            getMediaUrl: () => location.href,
            getTitle: () => document.querySelector("h1")?.textContent?.trim() || document.title,
            buttonTarget: () => null,
            waitFor: "h1, #page_content",
            // Deezer is DRM'd; MixAI matches the track/album metadata elsewhere.
            isMediaPage: () => /\/(track|album|playlist)\//.test(location.pathname),
            floating: true,
        },
        generic: {
            match: () => true,
            getMediaUrl: () => location.href,
            getTitle: () => document.title,
            buttonTarget: () => null,
            waitFor: null,
            // Any host-permitted page that renders a <video>/<audio> gets a floating button.
            isMediaPage: hasMediaElement,
            floating: true,
        },
    };

    let currentPlatform = null;
    let injectedButton = null;
    let settings = { baseUrl: "https://mixai.ro", autoDownload: false, audioOnly: true };

    // Load settings
    function loadSettings() {
        browser.runtime.sendMessage({ type: "get-settings" }).then((response) => {
            if (response) settings = response;
        }).catch(() => { /* SW asleep / extension reloaded — keep defaults */ });
    }

    // Detect platform (falls back to `generic` — we only run on host-permitted pages)
    function detectPlatform() {
        for (const [name, config] of Object.entries(PLATFORM_CONFIGS)) {
            if (name !== "generic" && config.match()) return { name, ...config };
        }
        return { name: "generic", ...PLATFORM_CONFIGS.generic };
    }

    // Create the download button element
    function createButton(platform, floating) {
        const btn = document.createElement("button");
        btn.id = BUTTON_ID;
        btn.type = "button";
        const title = msg("contentButtonTitle", "Download to MixAI Library");
        btn.title = title;
        btn.setAttribute("aria-label", title);

        // Style varies by platform
        const platformStyles = {
            youtube: "mixai-btn-youtube",
            youtubeMusic: "mixai-btn-ytmusic",
            soundcloud: "mixai-btn-soundcloud",
            spotify: "mixai-btn-spotify",
            bandcamp: "mixai-btn-bandcamp",
        };

        btn.className = floating
            ? "mixai-download-btn mixai-floating-btn"
            : `mixai-download-btn ${platformStyles[platform.name] || "mixai-btn-generic"}`;

        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span class="mixai-btn-label">${escapeHtml(msg("contentButtonLabel", "MixAI"))}</span>
        `;

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const mediaUrl = platform.getMediaUrl();
            browser.runtime.sendMessage({
                type: "open-download",
                url: mediaUrl,
                autoDownload: settings.autoDownload,
                audioOnly: settings.audioOnly,
            }).catch(() => { /* SW asleep — user can retry */ });

            // Visual feedback
            btn.classList.add("mixai-btn-clicked");
            setTimeout(() => btn.classList.remove("mixai-btn-clicked"), 1000);
        });

        return btn;
    }

    function msg(key, fallback) {
        try {
            return browser.i18n.getMessage(key) || fallback;
        } catch {
            return fallback;
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }

    // Inject button into the page
    function injectButton() {
        // Remove existing button if any
        if (injectedButton) {
            injectedButton.remove();
            injectedButton = null;
        }
        document.getElementById(BUTTON_ID)?.remove();

        const platform = detectPlatform();
        if (!platform || !platform.isMediaPage()) return;

        currentPlatform = platform;

        const target = platform.buttonTarget();
        if (!target) {
            // No stable inline container on this platform → fixed-position
            // floating button (bottom-right, above the safe area).
            if (!platform.floating) return;
            const floating = createButton(platform, true);
            injectedButton = floating;
            document.body.appendChild(floating);
            return;
        }

        const btn = createButton(platform, false);
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

        // Generic/floating pages: <video> may mount later than document_idle.
        if (platform.name === "generic") {
            waitForElement("video, audio", injectButton, 15000);
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
