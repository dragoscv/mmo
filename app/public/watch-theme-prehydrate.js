(function () {
    try {
        var t = localStorage.getItem("mmo:watch-theme");
        var ok = ["mmo", "netflix", "plex", "disney", "hbo"].indexOf(t) >= 0;
        document.documentElement.dataset.watchTheme = ok ? t : "netflix";
    } catch (e) { /* no-op */ }
})();
