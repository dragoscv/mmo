/**
 * Curated training prompts for the Voice Wizard.
 *
 * Six intents × six languages. Each line is timed for ~6–10s at a
 * comfortable speaking pace and hand-picked to maximise phonetic
 * variety, prosodic range, and emotional colour — so XTTS / F5 have
 * enough acoustic material to clone the speaker, not just one mood.
 */

export type PromptIntent =
    | "neutral"
    | "phonetic"
    | "warm"
    | "excited"
    | "intimate"
    | "question";

export interface TrainingPrompt {
    id: string;
    language: string;
    intent: PromptIntent;
    text: string;
    /** Delivery hint shown under the prompt — same language as the prompt. */
    hint: string;
}

export const INTENT_META: Record<
    PromptIntent,
    { label: string; emoji: string; tone: string }
> = {
    neutral: { label: "neutral", emoji: "·", tone: "bg-slate-500/15 text-slate-300" },
    phonetic: { label: "phonetic", emoji: "Aa", tone: "bg-indigo-500/15 text-indigo-300" },
    warm: { label: "warm", emoji: "♡", tone: "bg-rose-500/15 text-rose-300" },
    excited: { label: "excited", emoji: "!", tone: "bg-amber-500/15 text-amber-300" },
    intimate: { label: "intimate", emoji: "◐", tone: "bg-violet-500/15 text-violet-300" },
    question: { label: "question", emoji: "?", tone: "bg-cyan-500/15 text-cyan-300" },
};

export const TRAINING_PROMPTS: Record<string, TrainingPrompt[]> = {
    en: [
        { id: "en-1", language: "en", intent: "neutral", text: "Hello, this is my normal speaking voice. I am not acting, not performing, just talking the way I would on any ordinary day.", hint: "Relaxed, conversational. Speak as if explaining something simple to a friend." },
        { id: "en-2", language: "en", intent: "phonetic", text: "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs, and weigh every word evenly.", hint: "Crisp consonants, full vowels. A touch slower than normal so every sound lands." },
        { id: "en-3", language: "en", intent: "warm", text: "Thank you for being here tonight. I appreciate every single one of you, more than I really know how to say out loud.", hint: "Smile while you read. Let the warmth sit in your chest and shoulders, not your face." },
        { id: "en-4", language: "en", intent: "excited", text: "Look at this! I cannot believe how this turned out — it's amazing, it's beautiful, it's everything I was hoping for!", hint: "Energy up, breath short. Let the volume swell on the second sentence." },
        { id: "en-5", language: "en", intent: "intimate", text: "Stay close. The night is quiet, the world is asleep, and I want you to remember this moment exactly the way it feels.", hint: "Half-voice, almost a whisper. Mouth close to the mic, but never going breathy." },
        { id: "en-6", language: "en", intent: "question", text: "Have you ever wondered why we say goodbye when what we really mean is please, please don't forget me?", hint: "Rising intonation at the end of each clause. Curious, not sarcastic." },
    ],
    ro: [
        { id: "ro-1", language: "ro", intent: "neutral", text: "Bună, aceasta este vocea mea normală. Nu joc un rol, vorbesc așa cum o fac în orice zi obișnuită, fără să forțez nimic.", hint: "Relaxat, conversațional. Imaginează-ți că îi explici ceva simplu unui prieten." },
        { id: "ro-2", language: "ro", intent: "phonetic", text: "Pârâul piezișului se rostogolește printre pietre, șuierând și șoptind, în timp ce zorile pictează cerul în roz și auriu.", hint: "Consoane clare, vocale pline. Un pic mai rar ca de obicei ca fiecare sunet să se audă." },
        { id: "ro-3", language: "ro", intent: "warm", text: "Îți mulțumesc din toată inima că ești aici în seara asta. Nu știu cum aș fi reușit fără tine, sincer.", hint: "Zâmbește în timp ce citești. Lasă căldura să stea în piept, nu pe față." },
        { id: "ro-4", language: "ro", intent: "excited", text: "Nu pot să cred! Este uimitor, este perfect, este exact ce mi-am dorit toată viața — pur și simplu nu am cuvinte!", hint: "Energie sus, respirație scurtă. Lasă volumul să crească pe a doua propoziție." },
        { id: "ro-5", language: "ro", intent: "intimate", text: "Stai aproape. E liniște în jur, lumea doarme, și vreau să ții minte clipa asta exact așa cum se simte acum.", hint: "Jumătate de voce, aproape o șoaptă. Gura aproape de microfon, dar fără să devii hârâit." },
        { id: "ro-6", language: "ro", intent: "question", text: "Te-ai întrebat vreodată de ce spunem la revedere când, de fapt, vrem să spunem te rog, te rog, nu mă uita?", hint: "Intonație ascendentă la finalul fiecărei propoziții. Curios, nu sarcastic." },
    ],
    es: [
        { id: "es-1", language: "es", intent: "neutral", text: "Hola, esta es mi voz normal. No estoy actuando, no estoy forzando nada, simplemente hablo como hablo cualquier día.", hint: "Relajado, conversacional. Como si le explicaras algo sencillo a una amiga." },
        { id: "es-2", language: "es", intent: "phonetic", text: "El veloz murciélago hindú comía feliz cardillo y kiwi en la jaula del zoo. La cigüeña tocaba el saxofón detrás del palenque de paja.", hint: "Consonantes nítidas, vocales abiertas. Un poco más lento de lo normal." },
        { id: "es-3", language: "es", intent: "warm", text: "Gracias por estar aquí esta noche. No tienes idea de lo mucho que significa para mí, de verdad.", hint: "Sonríe mientras lees. Deja que la calidez se quede en el pecho, no en la cara." },
        { id: "es-4", language: "es", intent: "excited", text: "¡No me lo puedo creer! ¡Es asombroso, es perfecto, es justo lo que soñaba — no tengo palabras!", hint: "Energía arriba, respiración corta. El volumen sube en la segunda frase." },
        { id: "es-5", language: "es", intent: "intimate", text: "Quédate cerca. La noche está callada, el mundo duerme, y quiero que recuerdes este momento tal y como se siente ahora.", hint: "Media voz, casi un susurro. Cerca del micrófono, pero sin volverte ronca." },
        { id: "es-6", language: "es", intent: "question", text: "¿Te has preguntado alguna vez por qué decimos adiós cuando lo que realmente queremos decir es por favor, no me olvides?", hint: "Entonación ascendente al final de cada cláusula. Curioso, no sarcástico." },
    ],
    fr: [
        { id: "fr-1", language: "fr", intent: "neutral", text: "Bonjour, c'est ma voix normale. Je ne joue pas, je ne force rien, je parle simplement comme je le ferais n'importe quel jour.", hint: "Détendu, conversationnel. Comme si tu expliquais quelque chose de simple à un ami." },
        { id: "fr-2", language: "fr", intent: "phonetic", text: "Portez ce vieux whisky au juge blond qui fume. Voix ambiguë d'un cœur qui, au zéphyr, préfère les jattes de kiwis bien mûrs.", hint: "Consonnes nettes, voyelles pleines. Un peu plus lent que d'habitude." },
        { id: "fr-3", language: "fr", intent: "warm", text: "Merci d'être là ce soir. Tu n'as pas idée à quel point cela compte pour moi, vraiment.", hint: "Souris en lisant. Laisse la chaleur se loger dans la poitrine, pas sur le visage." },
        { id: "fr-4", language: "fr", intent: "excited", text: "Je n'en reviens pas ! C'est incroyable, c'est magnifique, c'est exactement ce dont je rêvais — j'en perds mes mots !", hint: "Énergie en haut, souffle court. Le volume monte sur la deuxième phrase." },
        { id: "fr-5", language: "fr", intent: "intimate", text: "Reste près de moi. La nuit est calme, le monde dort, et je veux que tu retiennes cet instant exactement comme il est.", hint: "Demi-voix, presque un murmure. Près du micro, mais sans souffler." },
        { id: "fr-6", language: "fr", intent: "question", text: "T'es-tu déjà demandé pourquoi nous disons au revoir quand ce que nous voulons vraiment dire, c'est ne m'oublie pas ?", hint: "Intonation montante en fin de phrase. Curieux, pas sarcastique." },
    ],
    de: [
        { id: "de-1", language: "de", intent: "neutral", text: "Hallo, das ist meine ganz normale Stimme. Ich spiele nicht, ich übertreibe nichts, ich rede einfach so, wie ich jeden Tag rede.", hint: "Entspannt, konversationell. Als würdest du einem Freund etwas Einfaches erklären." },
        { id: "de-2", language: "de", intent: "phonetic", text: "Franz jagt im komplett verwahrlosten Taxi quer durch Bayern. Zwölf Boxkämpfer jagen Eva quer über den großen Sylter Deich.", hint: "Klare Konsonanten, volle Vokale. Ein bisschen langsamer als normal." },
        { id: "de-3", language: "de", intent: "warm", text: "Danke, dass du heute Abend hier bist. Du weißt gar nicht, wie viel mir das bedeutet, wirklich.", hint: "Lächle beim Lesen. Lass die Wärme in der Brust sitzen, nicht im Gesicht." },
        { id: "de-4", language: "de", intent: "excited", text: "Ich kann es nicht glauben! Es ist unglaublich, es ist perfekt, es ist genau das, was ich mir immer gewünscht habe!", hint: "Energie hoch, kurze Atmung. Lautstärke steigt im zweiten Satz." },
        { id: "de-5", language: "de", intent: "intimate", text: "Bleib nah bei mir. Die Nacht ist still, die Welt schläft, und ich möchte, dass du diesen Moment genau so behältst, wie er sich anfühlt.", hint: "Halbstimme, fast ein Flüstern. Nah am Mikrofon, aber nicht hauchig." },
        { id: "de-6", language: "de", intent: "question", text: "Hast du dich jemals gefragt, warum wir Abschied sagen, wenn wir eigentlich vergiss mich nicht meinen?", hint: "Steigende Intonation am Satzende. Neugierig, nicht sarkastisch." },
    ],
    it: [
        { id: "it-1", language: "it", intent: "neutral", text: "Ciao, questa è la mia voce normale. Non sto recitando, non sto forzando niente, parlo come parlerei in un giorno qualunque.", hint: "Rilassato, conversazionale. Come se spiegassi qualcosa di semplice a un amico." },
        { id: "it-2", language: "it", intent: "phonetic", text: "Quel vituperabile xenofobo zelante assaggia il whisky ed esclama alleluja, mentre la giraffa nuota nello stagno azzurro.", hint: "Consonanti nitide, vocali piene. Un po' più lento del solito." },
        { id: "it-3", language: "it", intent: "warm", text: "Grazie di essere qui stasera. Non hai idea di quanto significhi per me, davvero, dal profondo del cuore.", hint: "Sorridi mentre leggi. Lascia che il calore stia nel petto, non sul viso." },
        { id: "it-4", language: "it", intent: "excited", text: "Non ci credo! È incredibile, è perfetto, è esattamente quello che sognavo — non ho parole per descriverlo!", hint: "Energia su, respiro corto. Il volume cresce sulla seconda frase." },
        { id: "it-5", language: "it", intent: "intimate", text: "Resta vicino. La notte è quieta, il mondo dorme, e voglio che ricordi questo momento esattamente come si sente ora.", hint: "Mezza voce, quasi un sussurro. Vicino al microfono, ma senza diventare aspirato." },
        { id: "it-6", language: "it", intent: "question", text: "Ti sei mai chiesto perché diciamo addio quando in realtà vogliamo dire ti prego, ti prego, non dimenticarmi?", hint: "Intonazione ascendente a fine frase. Curioso, non sarcastico." },
    ],
};

/** Build an interleaved (round-robin) prompt queue across the chosen languages. */
export function buildPromptQueue(languages: string[]): TrainingPrompt[] {
    const banks = languages
        .map((l) => TRAINING_PROMPTS[l] ?? [])
        .filter((b) => b.length > 0);
    if (banks.length === 0) return [];
    const maxLen = Math.max(...banks.map((b) => b.length));
    const queue: TrainingPrompt[] = [];
    for (let i = 0; i < maxLen; i++) {
        for (const bank of banks) {
            if (i < bank.length) queue.push(bank[i]);
        }
    }
    return queue;
}

// ─── Sung-phrase prompts for pitch-coverage training ─────────────────
// Three pitch heights × six languages. Each phrase is one bar @ 90 BPM,
// 8 syllables on do-re-mi-fa-sol-la-ti-do walking up then down. The
// melody field is sent through previewClonedVoiceSinging directly.

export interface SungPhrasePrompt {
    id: string;
    language: string;
    /** Center MIDI of the scale (root note of the ascending do-re-mi). */
    rootMidi: number;
    /** "low" 48 (C3), "mid" 60 (C4), "high" 72 (C5). Display label. */
    tier: "low" | "mid" | "high";
    text: string;
    /** Vocal-engine melody descriptor (consumed by previewClonedVoiceSinging). */
    melody: Array<{ beat: number; durationBeats: number; midiPitch: number }>;
    hint: string;
}

const SCALE_INTERVALS = [0, 2, 4, 5, 7, 9, 11, 12]; // major scale do..do

function buildScaleMelody(rootMidi: number): SungPhrasePrompt["melody"] {
    return SCALE_INTERVALS.map((semi, i) => ({
        beat: i * 0.5,
        durationBeats: 0.45,
        midiPitch: rootMidi + semi,
    }));
}

const SUNG_PHRASE_LYRICS: Record<string, string[]> = {
    en: ["la la la la la la la la", "sing to me my heart will rise", "soft and slow above the line"],
    ro: ["la la la la la la la la", "cântă-mi lin și-am să te urc", "stele cad în glasul tău"],
    es: ["la la la la la la la la", "canta y mi alma se elevará", "suave en la alta nota está"],
    fr: ["la la la la la la la la", "chante-moi mon cœur s'envole", "douce voix qui monte là"],
    de: ["la la la la la la la la", "sing für mich mein Herz fliegt hoch", "leise hoch zur letzten Note"],
    it: ["la la la la la la la la", "canta e l'anima si eleva", "dolce voce sale lassù"],
};

const TIER_TO_ROOT: Record<"low" | "mid" | "high", number> = {
    low: 48,   // C3 — comfortable bass / low alto
    mid: 60,   // C4 — middle of most voices
    high: 67,  // G4 — high tenor / mezzo, top do is C5
};

export const SUNG_PHRASE_PROMPTS: Record<string, SungPhrasePrompt[]> = Object.fromEntries(
    Object.entries(SUNG_PHRASE_LYRICS).map(([lang, lyrics]) => [
        lang,
        (["low", "mid", "high"] as const).map((tier, i) => {
            const rootMidi = TIER_TO_ROOT[tier];
            return {
                id: `${lang}-sing-${tier}`,
                language: lang,
                rootMidi,
                tier,
                text: lyrics[i] ?? lyrics[0],
                melody: buildScaleMelody(rootMidi),
                hint: tier === "low"
                    ? "Sing comfortably low. Don't push — if it strains, switch to the mid prompt."
                    : tier === "mid"
                        ? "Middle of your range. Steady, supported, breath open."
                        : "Reach for the top. If you can't hit the top note cleanly, do it in falsetto.",
            };
        }),
    ]),
);

/** Build a round-robin sung-prompt queue covering all chosen languages
 *  and all three pitch tiers, in low→mid→high order per language. */
export function buildSungPromptQueue(languages: string[]): SungPhrasePrompt[] {
    const banks = languages
        .map((l) => SUNG_PHRASE_PROMPTS[l] ?? [])
        .filter((b) => b.length > 0);
    if (banks.length === 0) return [];
    const queue: SungPhrasePrompt[] = [];
    for (let i = 0; i < 3; i++) {
        for (const bank of banks) {
            if (bank[i]) queue.push(bank[i]);
        }
    }
    return queue;
}
