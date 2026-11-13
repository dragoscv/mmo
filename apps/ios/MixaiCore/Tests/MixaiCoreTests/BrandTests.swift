import Testing
@testable import MixaiCore

/// The generated brand file (`Theme/Brand.swift`, from brand/scripts/build.mjs) keeps the shape the apps rely on.
@Suite struct BrandTests {
    @Test func theFamilyIsTheMarkPlusEightProductsAndTheTvGlyphHasLines() {
        #expect(BrandProduct.allCases.count == 9)
        #expect(!Brand.geometry(.tv).lines.isEmpty)
    }
}
