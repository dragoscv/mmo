/**
 * Browser UI chrome colour (address bar / PWA title bar). `<meta name="theme-color">` cannot read CSS
 * variables, so the sRGB values of the dark/light `--background` tokens are spelled out here — the one
 * place in apps/web allowlisted in scripts/hex-gate.allowlist.json.
 */
export function ThemeColorMeta() {
    return (
        <>
            <meta name="theme-color" content="#0f0e17" media="(prefers-color-scheme: dark)" />
            <meta name="theme-color" content="#fcfcfd" media="(prefers-color-scheme: light)" />
        </>
    );
}
