import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl } from "./config.ts";

test("bare LAN host gets the MMO Server port", () => {
    assert.equal(normalizeBaseUrl("192.168.100.61"), "http://192.168.100.61:17899");
    assert.equal(normalizeBaseUrl(" http://nas.local/ "), "http://nas.local:17899");
});

test("explicit port is kept", () => {
    assert.equal(normalizeBaseUrl("192.168.1.5:8096"), "http://192.168.1.5:8096");
    assert.equal(normalizeBaseUrl("https://srv.example:8443/"), "https://srv.example:8443");
});

test("https without a port stays on 443 (demo server, tunnels)", () => {
    assert.equal(normalizeBaseUrl("https://demo.mixai.ro"), "https://demo.mixai.ro");
    assert.equal(normalizeBaseUrl("HTTPS://demo.mixai.ro/"), "HTTPS://demo.mixai.ro");
});

test("empty input", () => {
    assert.equal(normalizeBaseUrl("   "), "");
});
