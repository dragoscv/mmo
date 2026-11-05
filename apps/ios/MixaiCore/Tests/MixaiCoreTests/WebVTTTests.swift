import Testing
@testable import MixaiCore

@Suite("WebVTT + player labels")
struct WebVTTTests {
    let sample = """
    WEBVTT

    00:01.000 --> 00:02.500
    <i>Hello</i>

    1
    01:00:00.000 --> 01:00:03,000 align:start
    Line one
    Line two

    00:05.000 --> 00:04.000
    bad range
    """

    @Test func parsesShortAndLongStamps() {
        let c = WebVTT.parse(sample)
        #expect(c.count == 2)
        #expect(c[0] == SubtitleCue(start: 1, end: 2.5, text: "Hello"))
        #expect(c[1].start == 3600)
        #expect(c[1].text == "Line one\nLine two")
    }

    @Test func activeCueLookup() {
        let c = WebVTT.parse(sample)
        #expect(WebVTT.active(c, at: 0.5) == nil)
        #expect(WebVTT.active(c, at: 2) == "Hello")
        #expect(WebVTT.active(c, at: 2.6) == nil)
        #expect(WebVTT.active(c, at: 3601) == "Line one\nLine two")
    }

    @Test func labelsAndClock() {
        #expect(audioLabel(lang: "eng", codec: "eac3", channels: 6, title: "Commentary") == "ENG · EAC3 · 5.1 (Commentary)")
        #expect(audioLabel(lang: "und", codec: "", channels: 0, title: nil) == "-")
        #expect(formatClock(3723) == "1:02:03")
        #expect(formatClock(65) == "1:05")
        #expect(formatClock(.nan) == "0:00")
    }
}
