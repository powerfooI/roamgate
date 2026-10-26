import { useEffect, useId, useState } from "react";
import {
  updateSpeechPreferences,
  useSpeechPreferences,
} from "../speechPreferences";
import "./SpeechSettings.css";

export function SpeechSettings() {
  const id = useId();
  const preferences = useSpeechPreferences();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const synthesis =
    typeof window === "undefined" ? null : window.speechSynthesis;
  const supported =
    Boolean(synthesis) && typeof window.SpeechSynthesisUtterance === "function";
  useEffect(() => {
    if (!synthesis || !supported) return;
    const refresh = () => setVoices(synthesis.getVoices());
    refresh();
    synthesis.addEventListener("voiceschanged", refresh);
    return () => synthesis.removeEventListener("voiceschanged", refresh);
  }, [synthesis, supported]);
  const missingVoice =
    preferences.voiceURI !== "" &&
    !voices.some((voice) => voice.voiceURI === preferences.voiceURI);
  return (
    <fieldset className="speech-settings">
      <legend>Speech</legend>
      <p id={`${id}-description`}>
        Listen to agent replies with Speak in Agent History Chat. Some browser
        voices use an online service and may send message text to the voice
        provider. Playback may stop when the browser is in the background or the
        screen is locked.
      </p>
      {!supported ? (
        <p role="status">Speech is not supported by this browser.</p>
      ) : null}
      <label htmlFor={`${id}-voice`}>Voice</label>
      <select
        id={`${id}-voice`}
        disabled={!supported}
        aria-describedby={`${id}-description`}
        value={preferences.voiceURI}
        onChange={(event) =>
          updateSpeechPreferences({ voiceURI: event.target.value })
        }
      >
        <option value="">Browser default</option>
        {missingVoice ? (
          <option value={preferences.voiceURI}>
            Saved voice unavailable (using browser default)
          </option>
        ) : null}
        {voices.map((voice) => (
          <option key={voice.voiceURI} value={voice.voiceURI}>
            {voice.name} ({voice.lang}){voice.localService ? "" : " - online"}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-rate`}>
        Speaking rate: {preferences.rate.toFixed(1)}x
      </label>
      <input
        id={`${id}-rate`}
        type="range"
        min="0.5"
        max="2"
        step="0.1"
        disabled={!supported}
        value={preferences.rate}
        aria-valuetext={`${preferences.rate.toFixed(1)} times normal speed`}
        onChange={(event) =>
          updateSpeechPreferences({ rate: Number(event.target.value) })
        }
      />
    </fieldset>
  );
}
