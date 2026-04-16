type RealtimeVoiceMeterProps = {
  active?: boolean;
  tone?: "default" | "signal";
};

export default function RealtimeVoiceMeter({
  active = false,
  tone = "default",
}: RealtimeVoiceMeterProps) {
  return (
    <div
      className={`realtime-voice-meter${active ? " is-live" : ""}${tone === "signal" ? " is-signal" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className="realtime-voice-bar" />
      ))}
    </div>
  );
}
