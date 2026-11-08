import Foundation
import Testing
@testable import MixaiCore

@Suite struct MusicDeepLinkTests {
    private func p(_ s: String) -> MusicDeepLink? { MusicDeepLink.parse(URL(string: s)!) }

    @Test func entitiesAndScreens() {
        #expect(p("mixai-music://home") == .home)
        #expect(p("mixai-music://album/al_7") == .album("al_7"))
        #expect(p("mixai-music://artist/ar_1") == .artist("ar_1"))
        #expect(p("mixai-music://album") == nil)
        #expect(p("mixai-music://now-playing") == .nowPlaying)
        #expect(p("mixai-music://nowplaying") == .nowPlaying)
        #expect(p("mixai-music://downloads") == .downloads)
        #expect(p("mixai-music://mix") == .mix)
        #expect(p("mixai-music://search?q=queen") == .search("queen"))
        #expect(p("mixai-music://search") == .search(""))
        #expect(p("mixai://album/al_7") == nil)
        #expect(p("mixai-music://unknown") == nil)
    }

    @Test func playIdsWinAndIndexIsClamped() {
        #expect(p("mixai-music://play?ids=tr_1,%20tr_2,,tr_3&index=1&q=x") == .playIds(["tr_1", "tr_2", "tr_3"], index: 1))
        #expect(p("mixai-music://play?ids=tr_1&index=9") == .playIds(["tr_1"], index: 0))
        #expect(p("mixai-music://play?ids=tr_1,tr_2&index=-3") == .playIds(["tr_1", "tr_2"], index: 0))
        #expect(p("mixai-music://play?q=queen") == .playQuery("queen"))
        #expect(p("mixai-music://play") == .mix)
    }
}
