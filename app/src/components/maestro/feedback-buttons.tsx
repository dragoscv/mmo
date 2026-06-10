"use client";

/**
 * <FeedbackButtons assetId /> — drop-in thumbs UI for any generated asset.
 *
 * Wired to `recordGenerationFeedback` server action. Optimistic, with a
 * popover for free-form notes + reason tags. Designed to live next to the
 * play button on generated tracks, in the library detail panel, and on
 * the post-generate confirmation card.
 */

import { useState, useTransition } from "react";
import { ThumbsUp, ThumbsDown, Flag } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

import { recordGenerationFeedback } from "@/actions/generation-feedback";
import {
    FEEDBACK_REASONS,
    type RecordFeedbackInput,
} from "@/lib/maestro/feedback-constants";

interface Props {
    assetId: string;
    initialVerdict?: "up" | "down" | "flag" | null;
    compact?: boolean;
}

export function FeedbackButtons({ assetId, initialVerdict = null, compact = false }: Props) {
    const [verdict, setVerdict] = useState<typeof initialVerdict>(initialVerdict);
    const [open, setOpen] = useState(false);
    const [note, setNote] = useState("");
    const [reasons, setReasons] = useState<Set<RecordFeedbackInput["reasons"] extends (infer T)[] | undefined ? T : never>>(new Set());
    const [pending, startTransition] = useTransition();

    const submit = (v: "up" | "down" | "flag", closeAfter = true) => {
        startTransition(async () => {
            const res = await recordGenerationFeedback({
                assetId,
                verdict: v,
                reasons: reasons.size > 0 ? Array.from(reasons) : undefined,
                note: note.trim() || undefined,
            });
            if (!res.ok) {
                toast.error(`Feedback failed: ${res.error}`);
                return;
            }
            setVerdict(v);
            if (closeAfter) {
                setOpen(false);
                setNote("");
                setReasons(new Set());
            }
            toast.success(v === "up" ? "Thanks — Maestro will train on this." : v === "down" ? "Got it — won't recommend that style." : "Flagged for review.");
        });
    };

    const toggleReason = (r: typeof FEEDBACK_REASONS[number]) => {
        setReasons((prev) => {
            const next = new Set(prev) as typeof prev;
            if (next.has(r)) next.delete(r);
            else next.add(r);
            return next;
        });
    };

    const size = compact ? "icon" : "sm";

    return (
        <div className="flex items-center gap-1">
            <Button
                size={size}
                variant={verdict === "up" ? "default" : "outline"}
                disabled={pending}
                onClick={() => submit("up")}
                aria-label="Thumbs up"
            >
                <ThumbsUp className="size-4" />
                {!compact && <span className="ml-1">Up</span>}
            </Button>

            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        size={size}
                        variant={verdict === "down" ? "destructive" : "outline"}
                        disabled={pending}
                        aria-label="Thumbs down with details"
                    >
                        <ThumbsDown className="size-4" />
                        {!compact && <span className="ml-1">Down</span>}
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 space-y-3">
                    <div className="text-sm font-medium">What went wrong?</div>
                    <div className="flex flex-wrap gap-1">
                        {FEEDBACK_REASONS.map((r) => (
                            <Badge
                                key={r}
                                variant={reasons.has(r) ? "default" : "outline"}
                                className="cursor-pointer text-[10px]"
                                onClick={() => toggleReason(r)}
                            >
                                {r}
                            </Badge>
                        ))}
                    </div>
                    <Textarea
                        placeholder="Optional note (e.g. 'kick too soft, drop too late')"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                    />
                    <Button onClick={() => submit("down")} disabled={pending} className="w-full">
                        Submit feedback
                    </Button>
                </PopoverContent>
            </Popover>

            <Button
                size={size}
                variant={verdict === "flag" ? "destructive" : "ghost"}
                disabled={pending}
                onClick={() => submit("flag")}
                aria-label="Flag for review"
            >
                <Flag className="size-4" />
            </Button>
        </div>
    );
}
