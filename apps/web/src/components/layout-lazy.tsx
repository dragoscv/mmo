"use client";

import dynamic from "next/dynamic";

// Client boundary for always-mounted-but-initially-invisible shell widgets.
// `app/layout.tsx` is a Server Component and `dynamic({ ssr: false })` is
// only allowed in Client Components, hence this thin module.
//
// Both widgets render nothing on first paint (VideoPlayerHost portals into a
// mount target that only exists once a video is playing; MaestroChatDock
// gates on `mounted` and opens on click), so there is no visual fallback —
// a Skeleton here would be a regression (a flash where nothing used to be).

/** hls.js host + subtitles + bookmarks + watch-party — only needed once a video plays. */
export const VideoPlayerHost = dynamic(
    () => import("@/components/video/player-host").then((m) => ({ default: m.VideoPlayerHost })),
    { ssr: false },
);

/** `ai` + `@ai-sdk/react` chat transport — only needed once the dock is opened. */
export const MaestroChatDock = dynamic(
    () => import("@/components/maestro/chat-dock").then((m) => ({ default: m.MaestroChatDock })),
    { ssr: false },
);
