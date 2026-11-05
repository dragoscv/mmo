/**
 * Built-in chat filter word list (RO + EN), WP16-50 (App Store 1.2 / Play UGC).
 * Entries are already folded (lower case, no diacritics, see `foldText`).
 * `STEMS` match any word that starts with them ("fuck" → "fucking"); `WORDS` match whole words only
 * (short or ambiguous words that would hit innocent words as a prefix).
 * Deliberately small: the goal is masking common abuse in a household feature, not a complete
 * moderation system. The owner can disable it (`PUT /hub/settings {chatFilter:false}`).
 */

export const STEMS: readonly string[] = [
    // EN
    "fuck", "motherfuck", "shit", "bullshit", "bitch", "bastard", "asshole", "dickhead", "cunt", "whore",
    "slut", "wanker", "retard", "faggot", "nigger", "nigga", "douchebag", "cocksuck", "jackass", "twat",
    "pussies", "dumbass",
    // RO
    "pula", "pizd", "muie", "futu", "fute", "futai", "cacat", "curv", "jeg", "handicapat", "bozgor",
    "tigan", "poponar", "labagi", "sugaci", "dobitoc", "idiot", "cretin", "imbecil", "nenorocit",
];

export const WORDS: readonly string[] = [
    // EN
    "ass", "dick", "cock", "fag", "piss", "prick", "pussy", "tits", "kys",
    // RO
    "pl", "pzd", "fmm", "mue", "sug", "prost", "proasta", "boule", "bou", "vaca", "zdreanta",
];
