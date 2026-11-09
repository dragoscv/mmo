/** Polite live region + small transient toast for shell announcements (layout switches, controllers). */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAnnounce } from "./shell-hotkeys";
import { useMotionOK } from "./motion";

export function StatusRegion() {
    const text = useAnnounce((s) => s.text);
    const at = useAnnounce((s) => s.at);
    const [visible, setVisible] = useState(false);
    const motionOK = useMotionOK();

    useEffect(() => {
        if (!at) return;
        setVisible(true);
        const id = setTimeout(() => setVisible(false), 2200);
        return () => clearTimeout(id);
    }, [at]);

    return (
        <>
            <div role="status" aria-live="polite" className="sr-only">
                {text}
            </div>
            <AnimatePresence>
                {visible && (
                    <motion.div
                        key={at}
                        aria-hidden
                        className="mixai-toast"
                        initial={motionOK ? { opacity: 0, y: 8, scale: 0.98 } : false}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={motionOK ? { opacity: 0, y: 8 } : { opacity: 0 }}
                        transition={{ duration: motionOK ? 0.18 : 0 }}
                    >
                        {text}
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}
