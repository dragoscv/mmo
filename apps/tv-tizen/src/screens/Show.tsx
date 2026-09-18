import { useEffect } from "react";
import type { MmoClient, ProbedVideo } from "../lib/api";
import { focusFirst } from "../lib/focus";
import { fmtDuration } from "../lib/format";
import { progressPct } from "../lib/progress";
import { episodeCode, episodeName, type Show } from "../lib/shows";
import { t } from "../i18n/messages";
import { VideoArt } from "./cards";

interface Props {
    client: MmoClient;
    show: Show;
    onPlay: (v: ProbedVideo) => void;
}

export function ShowScreen({ client, show, onPlay }: Props) {
    useEffect(() => { const h = setTimeout(() => focusFirst(), 30); return () => clearTimeout(h); }, [show.key]);
    const first = show.episodes[0];

    return (
        <div className="screen">
            <div className="album-head">
                {first && <div className={`card ${first.posterPath ? "poster" : "wide"}`} style={{ width: 220 }}><VideoArt v={first} client={client} /></div>}
                <div>
                    <h1 className="screen-title">{show.title}</h1>
                    <p className="screen-sub" style={{ margin: 0 }}>{t("show.episodes", { n: show.episodes.length })}</p>
                </div>
            </div>
            <div className="list" data-testid="episode-list">
                {show.episodes.length === 0 && <div className="empty">{t("show.empty")}</div>}
                {show.episodes.map((v) => {
                    const pct = progressPct(v.fileId, v.durationSec);
                    // Parser leaves only the show title → fall back to the file name.
                    const name = v.parsed.title.trim().toLowerCase() === show.key ? episodeName(v) : v.parsed.title;
                    return (
                        <button key={v.fileId} className="list-item" data-focusable onClick={() => onPlay(v)} title={v.path}>
                            <span className="num">{episodeCode(v)}</span>
                            <span className="grow">{[name, v.parsed.year].filter(Boolean).join(" · ")}</span>
                            {pct != null && <span className="progress" data-testid="progress"><span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--brand-accent)" }} /></span>}
                            <span className="dur">{fmtDuration(v.durationSec) ?? ""}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
