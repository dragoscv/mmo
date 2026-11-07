/*
 * MixAI Music — Google Cast custom Web Receiver (CAF v3, audio only, no build step).
 *
 * Works with plain CAF media messages (LOAD / QUEUE_LOAD / QUEUE_*), as sent by the Android
 * sender's Media3 CastPlayer + DefaultMediaItemConverter (MusicTrackMediaMetadata: title,
 * artist, albumName, images[0]). UI state comes from cast.framework.ui.PlayerDataBinder; the
 * "Next" line from the QueueManager. Optional extras (harmless when unused):
 *   - LOAD customData `{ accent?: "violet"|"magenta"|"cyan"|"emerald"|"amber"|"rose" }`
 *   - custom namespace `urn:x-cast:ro.mixai.music`: `{ type: "lyrics", lines: [{ timeMs, text }] }`
 */
'use strict';

(function () {
    if (typeof cast === 'undefined' || !cast.framework) {
        // Opened in a normal browser (or the SDK failed to load): leave the idle screen up.
        var hint = document.getElementById('idle-hint');
        if (hint) hint.textContent = 'Open this page from a Cast device';
        return;
    }

    var NAMESPACE = 'urn:x-cast:ro.mixai.music';
    var ACCENTS = ['violet', 'magenta', 'cyan', 'emerald', 'amber', 'rose'];
    var State = cast.framework.ui.State;

    var $ = function (id) { return document.getElementById(id); };
    var el = {
        body: document.body,
        now: $('now'),
        stateLabel: $('state-label'),
        title: $('title'),
        artist: $('artist'),
        album: $('album'),
        fill: $('progress-fill'),
        elapsed: $('elapsed'),
        duration: $('duration'),
        lyric: $('lyric'),
        next: $('next'),
        nextText: $('next-text'),
        covers: [$('cover-a'), $('cover-b')],
        backdrops: [$('bg-a'), $('bg-b')]
    };

    var context = cast.framework.CastReceiverContext.getInstance();
    var playerManager = context.getPlayerManager();
    playerManager.setMediaElement($('media'));

    // ---------- helpers ----------
    function fmt(sec) {
        if (!isFinite(sec) || sec < 0) return '--:--';
        var s = Math.floor(sec);
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var r = s % 60;
        var mm = h > 0 && m < 10 ? '0' + m : String(m);
        return (h > 0 ? h + ':' : '') + mm + ':' + (r < 10 ? '0' : '') + r;
    }

    function setText(node, text) {
        var t = text == null ? '' : String(text);
        if (node.textContent !== t) node.textContent = t;
    }

    function cssUrl(url) {
        return 'url(' + JSON.stringify(String(url)) + ')';
    }

    function metaOf(media) {
        var md = (media && media.metadata) || {};
        var images = md.images || [];
        return {
            title: md.title || '',
            artist: md.artist || md.albumArtist || md.subtitle || '',
            album: md.albumName || md.albumTitle || '',
            image: images.length && images[0] && images[0].url ? images[0].url : ''
        };
    }

    // ---------- artwork crossfade (opacity only) ----------
    var art = { url: null, slot: 0, token: 0 };

    function showArtwork(url) {
        if (url === art.url) return;
        art.url = url;
        var token = ++art.token;
        if (!url) {
            el.covers.forEach(function (c) { c.classList.remove('is-active'); });
            el.backdrops.forEach(function (b) { b.classList.remove('is-active'); });
            return;
        }
        var next = 1 - art.slot;
        var img = el.covers[next];
        img.onload = function () {
            if (token !== art.token) return;
            el.backdrops[next].style.backgroundImage = cssUrl(url);
            img.classList.add('is-active');
            el.backdrops[next].classList.add('is-active');
            el.covers[art.slot].classList.remove('is-active');
            el.backdrops[art.slot].classList.remove('is-active');
            art.slot = next;
        };
        img.onerror = function () {
            if (token !== art.token) return;
            el.covers[art.slot].classList.remove('is-active');
            el.backdrops[art.slot].classList.remove('is-active');
        };
        img.src = url;
    }

    // ---------- state ----------
    var current = { contentKey: null, duration: 0 };

    function uiState(s) {
        switch (s) {
            case State.PLAYING: return 'playing';
            case State.PAUSED: return 'paused';
            case State.BUFFERING: return 'buffering';
            case State.LOADING: return 'loading';
            default: return 'idle'; // LAUNCHING, IDLE
        }
    }

    var STATE_LABEL = {
        playing: 'Now playing',
        paused: 'Paused',
        buffering: 'Buffering…',
        loading: 'Loading…',
        idle: ''
    };

    function applyState(s) {
        var name = uiState(s);
        if (el.body.getAttribute('data-state') !== name) {
            el.body.setAttribute('data-state', name);
            el.now.setAttribute('aria-hidden', name === 'idle' ? 'true' : 'false');
            setText(el.stateLabel, STATE_LABEL[name]);
            if (name === 'idle') {
                showArtwork(null);
                clearLyrics();
                el.next.hidden = true;
            }
        }
    }

    function applyMedia(media) {
        var key = media ? (media.contentId || media.contentUrl || media.entity || '') : null;
        var m = metaOf(media);
        setText(el.title, m.title || 'Unknown track');
        setText(el.artist, m.artist);
        setText(el.album, m.album);
        showArtwork(m.image);
        if (key !== current.contentKey) {
            current.contentKey = key;
            clearLyrics();
            setProgress(0, media && media.duration, false);
        }
        updateNext();
    }

    function setProgress(time, duration, smooth) {
        var d = isFinite(duration) && duration > 0 ? duration : 0;
        current.duration = d;
        var ratio = d ? Math.min(1, Math.max(0, time / d)) : 0;
        el.fill.classList.toggle('is-smooth', !!smooth);
        el.fill.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
        setText(el.elapsed, fmt(time || 0));
        setText(el.duration, d ? fmt(d) : '--:--');
    }

    // ---------- queue: "Next: <title> — <artist>" ----------
    function updateNext() {
        var text = '';
        try {
            var qm = playerManager.getQueueManager();
            var items = qm && qm.getItems ? qm.getItems() : null;
            var idx = qm && qm.getCurrentItemIndex ? qm.getCurrentItemIndex() : -1;
            if (items && idx >= 0 && idx + 1 < items.length) {
                var nm = metaOf(items[idx + 1].media);
                if (nm.title) text = nm.artist ? nm.title + ' — ' + nm.artist : nm.title;
            }
        } catch (e) {
            text = '';
        }
        setText(el.nextText, text);
        el.next.hidden = !text;
    }

    // ---------- lyrics (custom namespace) ----------
    var lyrics = { lines: [], index: -2, timer: 0 };

    function clearLyrics() {
        lyrics.lines = [];
        lyrics.index = -2;
        if (lyrics.timer) { clearInterval(lyrics.timer); lyrics.timer = 0; }
        el.lyric.hidden = true;
        setText(el.lyric, '');
    }

    function setLyrics(lines) {
        clearLyrics();
        if (!Array.isArray(lines)) return;
        lyrics.lines = lines
            .filter(function (l) { return l && isFinite(l.timeMs) && typeof l.text === 'string'; })
            .map(function (l) { return { t: Number(l.timeMs) / 1000, text: l.text.slice(0, 300) }; })
            .sort(function (a, b) { return a.t - b.t; })
            .slice(0, 2000);
        if (!lyrics.lines.length) return;
        el.lyric.hidden = false;
        tickLyrics();
        lyrics.timer = setInterval(tickLyrics, 250);
    }

    function tickLyrics() {
        if (!lyrics.lines.length) return;
        var t = playerManager.getCurrentTimeSec();
        var lo = 0;
        var hi = lyrics.lines.length - 1;
        var found = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (lyrics.lines[mid].t <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        if (found === lyrics.index) return;
        lyrics.index = found;
        var text = found >= 0 ? lyrics.lines[found].text : '';
        el.lyric.classList.add('is-swapping');
        setTimeout(function () {
            setText(el.lyric, text);
            el.lyric.classList.remove('is-swapping');
        }, 120);
    }

    context.addCustomMessageListener(NAMESPACE, function (event) {
        var data = event && event.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) { return; }
        }
        if (!data || typeof data !== 'object') return;
        if (data.type === 'lyrics') setLyrics(data.lines);
        else if (data.type === 'lyrics-clear') clearLyrics();
    });

    // ---------- LOAD interceptor: optional accent ----------
    function applyAccent(customData) {
        var accent = customData && typeof customData.accent === 'string' ? customData.accent.toLowerCase() : '';
        if (ACCENTS.indexOf(accent) !== -1) document.documentElement.setAttribute('data-accent', accent);
    }

    playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, function (request) {
        try {
            applyAccent(request && (request.customData || (request.media && request.media.customData)));
        } catch (e) { /* customData is optional and never blocks playback */ }
        return request;
    });

    // ---------- bind PlayerData ----------
    var playerData = new cast.framework.ui.PlayerData();
    var binder = new cast.framework.ui.PlayerDataBinder(playerData);
    var Ev = cast.framework.ui.PlayerDataEventType;
    var lastTime = 0;

    binder.addEventListener(Ev.STATE_CHANGED, function (e) {
        applyState(e.value);
        // Seek/pause/resume: jump, do not glide.
        setProgress(playerData.currentTime, playerData.duration, false);
    });
    binder.addEventListener(Ev.MEDIA_CHANGED, function (e) {
        if (e.value) applyMedia(e.value);
    });
    binder.addEventListener(Ev.CURRENT_TIME_CHANGED, function (e) {
        var smooth = Math.abs(e.value - lastTime) < 2;
        lastTime = e.value;
        setProgress(e.value, playerData.duration, smooth);
    });
    binder.addEventListener(Ev.DURATION_CHANGED, function (e) {
        setProgress(playerData.currentTime, e.value, false);
    });

    // Queue changes (insert/remove/reorder) arrive as media status updates.
    playerManager.addEventListener(cast.framework.events.EventType.MEDIA_STATUS, updateNext);

    // ---------- start ----------
    var options = new cast.framework.CastReceiverOptions();
    options.disableIdleTimeout = false;
    options.maxInactivity = 3600;
    options.statusText = 'MixAI Music';
    options.playbackConfig = Object.assign(new cast.framework.PlaybackConfig(), {
        autoResumeDuration: 2,
        autoPauseDuration: 2
    });
    // Advertise queue next/previous so sender notifications show skip buttons.
    options.supportedCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA |
        cast.framework.messages.Command.QUEUE_NEXT |
        cast.framework.messages.Command.QUEUE_PREV;

    context.start(options);
})();
