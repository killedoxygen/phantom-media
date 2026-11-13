"use client";

import { useState } from "react";
import { Headphones } from "@phosphor-icons/react/ssr";
import { StageControl } from "./stage-controls";

/**
 * What the stage shows while listening: the cover in place of the picture.
 * It sits over the media element without taking its clicks, so taps still play, pause and skip, and the
 * transport rests on the cover the way a play button rests on album art.
 */
export function ListeningStage({ artwork, backdrop, playing, shape = "square" }: {
  /** The cover, such as a channel image or a poster. */
  artwork?: string;
  /** A wide image blurred behind the cover. Falls back to the cover. */
  backdrop?: string;
  playing: boolean;
  /** "portrait" for a 2:3 poster; the cover keeps the same height either way. */
  shape?: "square" | "portrait";
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const cover = artwork && artwork !== failed ? artwork : undefined;
  const wash = backdrop ?? cover;
  return (
    <div className="stage-listening" data-playing={playing} aria-hidden="true">
      {wash && <div className="stage-listening-backdrop" style={{ backgroundImage: `url("${wash.replace(/["\\\n\r]/g, encodeURIComponent)}")` }} />}
      <div className="stage-listening-cover" data-shape={shape}>
        {cover
          ? <img src={cover} alt="" onError={() => setFailed(cover)} />
          : <Headphones weight="fill" size={40} />}
        <span className="stage-listening-badge">
          <span className="stage-listening-bars"><i /><i /><i /><i /></span>
          Audio only
        </span>
      </div>
    </div>
  );
}

/** The toolbar's audio-only switch. */
export function ListeningControl({ listening, onChange }: { listening: boolean; onChange: (listening: boolean) => void }) {
  return (
    <StageControl
      label={listening ? "Show video" : "Audio only"}
      onClick={() => onChange(!listening)}
      className={`stage-listening-trigger ${listening ? "stage-listening-trigger-active" : ""}`}
    >
      <Headphones weight="fill" size={22} />
    </StageControl>
  );
}
