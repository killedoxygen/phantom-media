import type { SettingsSection } from "./stage-settings";

const SWITCH = [{ value: "off", label: "Off" }, { value: "on", label: "On" }] as const;

/**
 * The listening rows of a player's settings sheet, in the same words in every app.
 * Rows a source cannot honour are left out: no audio-only row without `onListeningChange`, and no processing
 * rows when the player cannot route its audio through Web Audio.
 */
export function listeningSettingsSections({
  listening, onListeningChange, note,
  enhancement, voiceBoost, onVoiceBoostChange, mono, onMonoChange,
  onChange,
}: {
  listening: boolean;
  onListeningChange?: (listening: boolean) => void;
  /** What listening does for this source, from `describeListeningPlan`. */
  note?: string;
  enhancement: boolean;
  voiceBoost: boolean;
  onVoiceBoostChange: (enabled: boolean) => void;
  mono: boolean;
  onMonoChange: (enabled: boolean) => void;
  /** Called after any choice, for a player that closes its sheet. */
  onChange?: () => void;
}): SettingsSection[] {
  const toggle = (id: string, title: string, value: boolean, set: (enabled: boolean) => void, sectionNote: string): SettingsSection => ({
    id, title, note: sectionNote, options: SWITCH, value: value ? "on" : "off",
    onChange: next => { set(next === "on"); onChange?.(); },
    summary: value ? "On" : "Off",
  });
  return [
    ...(onListeningChange ? [toggle("listening", "Audio only", listening, onListeningChange,
      note ?? "Plays only the sound, like a podcast, and stops downloading the picture.")] : []),
    ...(enhancement ? [
      toggle("voice-boost", "Voice boost", voiceBoost, onVoiceBoostChange,
        "Evens out quiet and loud voices and makes speech clearer. Applies once playback starts."),
      toggle("mono", "Mono audio", mono, onMonoChange,
        "Plays both channels in each ear, for one earbud or a one-sided mix."),
    ] : []),
  ];
}
