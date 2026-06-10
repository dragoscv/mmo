"use client";

import { useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Bot, Sparkles, Brain, Library, Mic, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const SUGGESTIONS: Array<{ icon: typeof Bot; title: string; prompt: string; gradient: string }> = [
    {
        icon: Brain,
        title: "Train on my library",
        prompt: "Build a training dataset from my whole library, then materialize it and submit a style-LoRA job on Vertex (A100 spot). Explain each step before you do it.",
        gradient: "from-fuchsia-500/20 to-violet-500/20",
    },
    {
        icon: Library,
        title: "Find similar tracks",
        prompt: "Find tracks similar to my favorite ones and group them into a playlist.",
        gradient: "from-cyan-500/20 to-blue-500/20",
    },
    {
        icon: Mic,
        title: "Generate a song",
        prompt: "Generate a 90-second melodic-techno track at 124 BPM in F minor with a hypnotic arpeggio and a long breakdown.",
        gradient: "from-amber-500/20 to-rose-500/20",
    },
    {
        icon: Wand2,
        title: "What can you do?",
        prompt: "List your capabilities: every tool you can call grouped by domain (library, generation, training, library mgmt). Be concise.",
        gradient: "from-emerald-500/20 to-teal-500/20",
    },
];

export default function MaestroPageClient() {
    // Auto-open the floating Maestro dock on landing.
    useEffect(() => {
        const t = setTimeout(() => {
            window.dispatchEvent(new Event("mmo:maestro-open"));
        }, 120);
        return () => clearTimeout(t);
    }, []);

    return (
        <div className="min-h-[calc(100vh-3.5rem)] relative overflow-hidden bg-gradient-to-br from-background via-background to-violet-950/20">
            {/* Decorative orbs */}
            <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-violet-500/20 blur-3xl pointer-events-none" />
            <div className="absolute top-1/2 -right-32 w-96 h-96 rounded-full bg-fuchsia-500/15 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-32 left-1/3 w-96 h-96 rounded-full bg-rose-500/10 blur-3xl pointer-events-none" />

            <div className="relative max-w-5xl mx-auto px-6 py-16 space-y-12">
                <motion.header
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4 }}
                    className="text-center space-y-4"
                >
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 shadow-2xl shadow-fuchsia-500/30 mb-2">
                        <Bot className="w-8 h-8 text-white" />
                    </div>
                    <h1 className="text-5xl font-bold bg-gradient-to-r from-violet-300 via-fuchsia-300 to-rose-300 bg-clip-text text-transparent">
                        Maestro
                    </h1>
                    <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                        Your AI conductor for music. Ask in plain English — Maestro orchestrates
                        generation, library curation, and end-to-end model training.
                    </p>
                    <div className="flex items-center justify-center gap-3 pt-2">
                        <Button
                            size="lg"
                            onClick={() => window.dispatchEvent(new Event("mmo:maestro-open"))}
                            className="bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white shadow-lg"
                        >
                            <Sparkles className="w-4 h-4 mr-2" />
                            Open chat
                        </Button>
                        <Button asChild size="lg" variant="outline">
                            <Link href="/training">Training jobs</Link>
                        </Button>
                    </div>
                </motion.header>

                <motion.section
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.1 }}
                    className="grid grid-cols-1 md:grid-cols-2 gap-4"
                >
                    {SUGGESTIONS.map((s) => {
                        const Icon = s.icon;
                        return (
                            <Card
                                key={s.title}
                                className={`group relative overflow-hidden cursor-pointer p-5 border-border/50 bg-gradient-to-br ${s.gradient} backdrop-blur transition-all hover:scale-[1.02] hover:shadow-xl`}
                                onClick={() => {
                                    window.dispatchEvent(new Event("mmo:maestro-open"));
                                    // Tiny delay so dock is mounted, then drop the prompt
                                    // into the composer via another event.
                                    setTimeout(() => {
                                        window.dispatchEvent(
                                            new CustomEvent("mmo:maestro-prompt", { detail: s.prompt }),
                                        );
                                    }, 250);
                                }}
                            >
                                <div className="flex items-start gap-3">
                                    <div className="shrink-0 w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center group-hover:bg-white/20 transition-colors">
                                        <Icon className="w-5 h-5 text-white" />
                                    </div>
                                    <div className="min-w-0">
                                        <h3 className="font-semibold mb-1">{s.title}</h3>
                                        <p className="text-sm text-muted-foreground line-clamp-3">{s.prompt}</p>
                                    </div>
                                </div>
                            </Card>
                        );
                    })}
                </motion.section>

                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.4, delay: 0.3 }}
                    className="text-center text-xs text-muted-foreground"
                >
                    The chat dock is also pinned to the bottom-right of every screen.
                </motion.div>
            </div>
        </div>
    );
}
