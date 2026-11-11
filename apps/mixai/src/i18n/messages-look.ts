/** Strings shared by the look layer (key chips, readouts). Keys: "look.*". */
export const lookMessages = {
    en: {
        "look.keyMatch": "Key {key}: mixes well with {other}",
        "look.keyNear": "Key {key}: workable with {other}",
        "look.keyClash": "Key {key}: clashes with {other}",
    },
    ro: {
        "look.keyMatch": "Tonalitate {key}: se potrivește cu {other}",
        "look.keyNear": "Tonalitate {key}: merge cu {other}, cu atenție",
        "look.keyClash": "Tonalitate {key}: nu se potrivește cu {other}",
    },
} as const;
