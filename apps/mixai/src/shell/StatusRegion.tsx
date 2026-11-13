/**
 * Polite live region + small transient chip for shell announcements (layout switches,
 * controllers, the gig lock). The chip sits just above the status bar (shell.css
 * `.mixai-toast`); screen readers get the text from the live region, so the chip itself is
 * `aria-hidden`.
 *
 * The region stays in the page; the text inside it is a node keyed on the time of the
 * announcement, so the SAME sentence said again is a new node and is read again (a text that
 * does not change is silent in a live region). The chip stays for the time the announcement
 * asks for (`useAnnounce().say(text, ms)`; 2.2 s unless told otherwise).
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAnnounce } from "./shell-hotkeys";
import { useMotionOK } from "./motion";

export function StatusRegion() {
    const text = useAnnounce((s) => s.text);
    const at = useAnnounce((s) => s.at);
    const ms = useAnnounce((s) => s.ms);
    const [visible, setVisible] = useState(false);
    const motionOK = useMotionOK();

    useEffect(() => {
        if (!at) return;
        setVisible(true);
        const id = setTimeout(() => setVisible(false), ms);
        return () => clearTimeout(id);
    }, [at, ms]);

    return (
        <>
            <div role="status" aria-live="polite" className="sr-only" data-announce-at={at || undefined}>
                <span key={at}>{text}</span>
            </div>
            <AnimatePresence>
                {visible && (
                    <motion.div
                        key={at}
                        aria-hidden
                        className="mixai-toast"
                        initial={motionOK ? { opacity: 0, y: 4 } : false}
                        animate={{ opacity: 1, y: 0 }}
                        exit={motionOK ? { opacity: 0, y: 4 } : { opacity: 0 }}
                        transition={{ duration: motionOK ? 0.12 : 0 }}
                    >
                        {text}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}
