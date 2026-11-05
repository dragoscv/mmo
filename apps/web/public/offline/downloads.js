/*
 * MixAI offline downloads shell (WP16-42) — vanilla JS, no framework, no next-intl.
 * Mirrors constants of apps/web/src/lib/mmo/offline/keys.ts + store.ts (keep in sync):
 *   IndexedDB "mixai-offline" v1, store "items" (keyPath key, index scope); media at /__offline/<enc key>.
 * Routes (same URLs as the Next pages, so links keep working online and offline):
 *   /media/downloads                 list (scope = localStorage "mixai-offline:scope", else everything)
 *   /media/downloads/play/<enc key>  player
 */
(function () {
  "use strict";

  var DICT = {
    ro: {
      title: "Descărcări",
      banner: "Ești offline. Poți reda ce ai descărcat pe acest dispozitiv.",
      empty: "Nu ai nimic descărcat pentru acest profil.",
      play: "Redă",
      playNamed: "Redă {name}",
      back: "Înapoi la descărcări",
      retry: "Reîncearcă",
      missing: "Fișierul nu mai este pe acest dispozitiv.",
      unsupported: "Browserul acesta nu permite descărcările offline.",
      count: { one: "# fișier", few: "# fișiere", other: "# de fișiere" }
    },
    en: {
      title: "Downloads",
      banner: "You are offline. You can play what you downloaded on this device.",
      empty: "Nothing downloaded for this profile.",
      play: "Play",
      playNamed: "Play {name}",
      back: "Back to downloads",
      retry: "Try again",
      missing: "This file is no longer on this device.",
      unsupported: "This browser does not support offline downloads.",
      count: { one: "# file", other: "# files" }
    }
  };

  function lang() {
    var l = (document.documentElement.getAttribute("lang") || "").slice(0, 2);
    if (l !== "ro" && l !== "en") {
      try {
        var p = JSON.parse(localStorage.getItem("mixai:prefs:v1") || "{}");
        l = p && (p.locale === "en" || p.locale === "ro") ? p.locale : "ro";
      } catch (e) { l = "ro"; }
    }
    return l;
  }
  var L = lang();
  var T = DICT[L];

  function t(key, vars) {
    var s = T[key];
    if (vars) for (var k in vars) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  }
  function plural(forms, n) {
    var cat = new Intl.PluralRules(L).select(n);
    return (forms[cat] || forms.other).split("#").join(new Intl.NumberFormat(L).format(n));
  }
  function bytes(n) {
    var u = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"], i = 0, v = Math.max(0, n || 0);
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return new Intl.NumberFormat(L, { style: "unit", unit: u[i], unitDisplay: "short", maximumFractionDigits: i === 0 ? 0 : v < 10 ? 1 : 0 }).format(v);
  }
  function duration(sec) {
    if (!sec) return "";
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? h + " h " + m + " min" : m + " min";
  }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  var mediaUrl = function (key) { return "/__offline/" + encodeURIComponent(key); };

  function openDb() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open("mixai-offline", 1);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "key" }).createIndex("scope", "scope");
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function getAll(db, scope) {
    return new Promise(function (resolve, reject) {
      var s = db.transaction("items", "readonly").objectStore("items");
      var r = scope ? s.index("scope").getAll(scope) : s.getAll();
      r.onsuccess = function () { resolve(r.result || []); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function getOne(db, key) {
    return new Promise(function (resolve, reject) {
      var r = db.transaction("items", "readonly").objectStore("items").get(key);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { reject(r.error); };
    });
  }

  var main = document.getElementById("od-main");
  document.getElementById("od-banner").textContent = navigator.onLine ? "" : t("banner");
  if (navigator.onLine) document.getElementById("od-banner").hidden = true;
  document.title = t("title") + " · MixAI";

  function poster(item) {
    var img = el("img", { class: "od-poster", alt: "", "data-kind": item.kind, loading: "lazy" });
    if (item.hasPoster) img.src = mediaUrl(item.key) + "/poster";
    return img;
  }

  function renderList(items) {
    var done = items.filter(function (i) { return i.status === "done"; });
    var total = done.reduce(function (s, i) { return s + (i.size || 0); }, 0);
    main.textContent = "";
    main.appendChild(el("div", { class: "od-head" }, [
      el("h1", { class: "od-title", text: t("title") }),
      el("span", { class: "od-meta", text: plural(T.count, done.length) + " · " + bytes(total) })
    ]));
    if (!done.length) { main.appendChild(el("p", { class: "od-empty", text: t("empty") })); return; }
    var ul = el("ul", { class: "od-list" });
    done.forEach(function (i) {
      var sub = [i.subtitle, duration(i.durationSec), bytes(i.size)].filter(Boolean).join(" · ");
      ul.appendChild(el("li", { class: "od-item" }, [
        poster(i),
        el("div", { class: "od-body" }, [el("p", { class: "od-name", text: i.title }), el("p", { class: "od-sub", text: sub })]),
        el("a", { class: "od-btn", href: "/media/downloads/play/" + encodeURIComponent(i.key), "aria-label": t("playNamed", { name: i.title }), text: t("play") })
      ]));
    });
    main.appendChild(ul);
    var first = ul.querySelector("a");
    if (first) first.focus();
  }

  function renderPlayer(item) {
    main.textContent = "";
    var back = el("a", { class: "od-btn", "data-variant": "ghost", href: "/media/downloads", text: "← " + t("back") });
    if (!item || item.status !== "done") {
      main.appendChild(el("div", { class: "od-player" }, [back, el("p", { class: "od-empty", role: "alert", text: t("missing") })]));
      back.focus();
      return;
    }
    var media;
    if (item.kind === "track") {
      media = el("audio", { controls: "", autoplay: "", src: mediaUrl(item.key), "aria-label": item.title });
    } else {
      media = el("video", { controls: "", autoplay: "", playsinline: "", src: mediaUrl(item.key), "aria-label": item.title });
      if (item.hasPoster) media.setAttribute("poster", mediaUrl(item.key) + "/poster");
    }
    var parts = [back, el("h1", { class: "od-title", text: item.title })];
    if (item.subtitle) parts.push(el("p", { class: "od-meta", text: item.subtitle }));
    if (item.kind === "track" && item.hasPoster) parts.push(el("img", { class: "od-art", alt: "", src: mediaUrl(item.key) + "/poster" }));
    parts.push(media);
    media.addEventListener("error", function () {
      var msg = el("p", { class: "od-empty", role: "alert", text: t("missing") });
      if (!main.querySelector("[role=alert]")) main.querySelector(".od-player").appendChild(msg);
    });
    main.appendChild(el("div", { class: "od-player" }, parts));
    document.title = item.title + " · MixAI";
    media.focus();
  }

  function scope() {
    try { return localStorage.getItem("mixai-offline:scope") || ""; } catch (e) { return ""; }
  }

  if (typeof indexedDB === "undefined") { main.appendChild(el("p", { class: "od-empty", text: t("unsupported") })); return; }

  var m = /^\/media\/downloads\/play\/([^/]+)\/?$/.exec(location.pathname);
  openDb().then(function (db) {
    if (m) {
      var key = null;
      try { key = decodeURIComponent(m[1]); } catch (e) { key = null; }
      return (key ? getOne(db, key) : Promise.resolve(null)).then(renderPlayer);
    }
    var s = scope();
    return getAll(db, s || null).then(function (items) {
      if (!items.length && s) return getAll(db, null);
      return items;
    }).then(function (items) {
      items.sort(function (a, b) { return b.addedAt - a.addedAt; });
      renderList(items);
    });
  }).catch(function () {
    main.textContent = "";
    var retry = el("button", { class: "od-btn", type: "button", text: t("retry") });
    retry.addEventListener("click", function () { location.reload(); });
    main.appendChild(el("div", { class: "od-empty", role: "alert" }, [el("p", { text: t("unsupported") }), retry]));
  });
})();
