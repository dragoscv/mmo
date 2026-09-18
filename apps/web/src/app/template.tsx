import { ViewTransition } from "react";
import type { ReactNode } from "react";
import "./view-transitions.css";
import "./player-height.css";

/**
 * Route transitions (WP2-09). A template re-mounts on every navigation, so
 * wrapping children in React 19.3's stable `<ViewTransition>` gives each
 * page an enter/exit pair. `default="mixai-page"` assigns a
 * view-transition-class consumed by ./view-transitions.css (fade + 8px rise
 * on `--dur-page`, disabled under data-motion="reduced").
 *
 * Elements that already carry an explicit `viewTransitionName` (watch poster
 * → hero morph, np-video-*) keep their own named groups; this only styles the
 * page-level cross-fade.
 */
export default function Template({ children }: { children: ReactNode }) {
    return <ViewTransition default="mixai-page">{children}</ViewTransition>;
}
