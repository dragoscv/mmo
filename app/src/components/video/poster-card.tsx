import Link from "next/link";
import Image from "next/image";
import type { CSSProperties } from "react";

interface Props {
    href: string;
    title: string;
    year?: number | null;
    posterPath: string | null;
    progress?: number;
    transitionName?: string;
}

export function PosterCard({ href, title, year, posterPath, progress, transitionName }: Props) {
    const src = posterPath ? `https://image.tmdb.org/t/p/w342${posterPath}` : null;
    const style: CSSProperties = transitionName ? { ["--vt-name" as string]: transitionName } : {};
    return (
        <Link href={href} className="poster-card" style={style} aria-label={`${title}${year ? ` (${year})` : ""}`}>
            {src ? (
                <Image
                    src={src}
                    alt={title}
                    width={342}
                    height={513}
                    className="poster-card-img"
                    sizes="180px"
                    loading="lazy"
                />
            ) : (
                <div className="poster-card-placeholder">{title}</div>
            )}
            <div className="poster-card-overlay">
                <div className="poster-card-title">{title}</div>
                {year !== undefined && year !== null && <div className="poster-card-year">{year}</div>}
            </div>
            {progress !== undefined && progress > 0 && (
                <div className="poster-card-progress" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
            )}
        </Link>
    );
}

interface RowProps {
    title: string;
    children: React.ReactNode;
}

export function PosterRow({ title, children }: RowProps) {
    return (
        <section className="watch-row">
            <h2 className="watch-row-title">{title}</h2>
            <div className="watch-row-scroll">{children}</div>
        </section>
    );
}
