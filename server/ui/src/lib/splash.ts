const SPLASH_MIN_MS = 650;
const startedAt = Date.now();

/**
 * Fade out the inline splash from index.html once the first real view is
 * known. Minimum visible time keeps a fast cold start from flickering; under
 * reduced motion the CSS collapses the transition to a 200 ms opacity fade.
 */
export function hideSplash(): void {
    const el = document.getElementById("splash");
    if (!el) return;
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - startedAt));
    window.setTimeout(() => {
        el.classList.add("hide");
        window.setTimeout(() => el.parentNode?.removeChild(el), 500);
    }, wait);
}
