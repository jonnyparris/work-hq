// The all-clear scene: a still pond under the sky, a paper boat drifting.
// Pure SVG + CSS keyframes (styles.css → "calm scene"). Sun by day, moon and
// stars by night. Honors prefers-reduced-motion.
import { useNow } from "./store.ts";

const STARS: [number, number, number, number][] = [
  // x, y, r, delay(s)
  [34, 22, 1.1, 0], [72, 44, 0.8, 1.6], [108, 16, 1.3, 3.1], [152, 36, 0.7, 0.8],
  [188, 12, 1, 2.4], [214, 48, 0.8, 4.2], [300, 20, 1.2, 1.1], [330, 46, 0.7, 3.6],
  [276, 70, 0.6, 2.9], [58, 70, 0.6, 5],
];

const FIREFLIES: [number, number, number][] = [
  // x, y, delay(s)
  [68, 90, 0], [150, 84, 2.3], [312, 88, 4.1],
];

export function CalmScene() {
  const now = useNow(5 * 60_000);
  const h = now.getHours();
  const night = h < 6 || h >= 19;
  const dusk = h >= 17 && h < 19;
  const tone = night ? "night" : dusk ? "dusk" : "day";
  // Low in the east in the morning, high at midday, west in the evening.
  const t = night ? 0.72 : Math.min(1, Math.max(0, (h + now.getMinutes() / 60 - 6) / 13));
  const cx = night ? 262 : 60 + t * 240;
  const cy = night ? 42 : 70 - Math.sin(t * Math.PI) * 42;

  return (
    <svg className={`calm-scene ${tone}`} viewBox="0 0 360 150" role="img" aria-label="A paper boat drifting on a still pond">
      <defs>
        <radialGradient id="cs-glow">
          <stop offset="0" stopColor="var(--cs-sun)" stopOpacity=".42" />
          <stop offset=".35" stopColor="var(--cs-sun)" stopOpacity=".12" />
          <stop offset="1" stopColor="var(--cs-sun)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cs-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--cs-water)" stopOpacity=".22" />
          <stop offset="1" stopColor="var(--cs-water)" stopOpacity="0" />
        </linearGradient>
        {/* soft vignette so the scene melts into the card, no hard edges */}
        <radialGradient id="cs-fade" cx=".5" cy=".56" r=".5">
          <stop offset=".62" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="cs-edges"><rect width="360" height="150" fill="url(#cs-fade)" /></mask>
        <mask id="cs-crescent">
          <circle cx={cx} cy={cy} r="12" fill="#fff" />
          <circle cx={cx + 6} cy={cy - 4} r="10.5" fill="#000" />
        </mask>
        <clipPath id="cs-sky"><rect width="360" height="100" /></clipPath>
      </defs>

      <g mask="url(#cs-edges)">
        {/* sky */}
        <g clipPath="url(#cs-sky)">
          <circle className="cs-glow" cx={cx} cy={cy} r="46" fill="url(#cs-glow)" />
          {night && STARS.map(([x, y, r, d], i) => (
            <circle key={i} className="cs-star" cx={x} cy={y} r={r} style={{ animationDelay: `${-d}s` }} />
          ))}
          {night
            ? <circle className="cs-moon" cx={cx} cy={cy} r="12" mask="url(#cs-crescent)" />
            : <circle className="cs-sun" cx={cx} cy={cy} r="11" />}
          <g transform="translate(0 34)"><g className="cs-cloud a"><rect x="0" y="0" width="54" height="9" rx="4.5" /><rect x="12" y="-6" width="26" height="10" rx="5" /></g></g>
          <g transform="translate(0 58)"><g className="cs-cloud b"><rect x="0" y="0" width="40" height="7" rx="3.5" /><rect x="9" y="-4" width="18" height="8" rx="4" /></g></g>
          {!night && (
            <path className="cs-bird" d="M0 0 q3 -3 6 0 q3 -3 6 0" />
          )}
        </g>

        {/* hills */}
        <path className="cs-hill back" d="M0 100 C40 78 78 74 120 86 S196 70 240 82 S318 76 360 90 V100 Z" />
        <path className="cs-hill front" d="M0 100 C30 90 62 88 96 95 S150 90 176 96 S230 92 262 97 S330 94 360 100 Z" />
        {night && FIREFLIES.map(([x, y, d], i) => (
          <circle key={i} className="cs-fly" cx={x} cy={y} r="1.1" style={{ animationDelay: `${-d}s` }} />
        ))}

        {/* water */}
        <rect y="100" width="360" height="50" fill="url(#cs-water)" />
        <line x1="0" y1="100.5" x2="360" y2="100.5" className="cs-horizon" />
        <g className="cs-reflect" transform={`translate(${cx} 0)`}>
          <line x1="-14" x2="14" y1="106" y2="106" />
          <line x1="-9" x2="9" y1="112" y2="112" style={{ animationDelay: "-1.3s" }} />
          <line x1="-12" x2="12" y1="119" y2="119" style={{ animationDelay: "-2.6s" }} />
          <line x1="-5" x2="5" y1="126" y2="126" style={{ animationDelay: "-3.4s" }} />
        </g>
        <g className="cs-ripples">
          <line x1="22" x2="58" y1="132" y2="132" />
          <line x1="196" x2="222" y1="138" y2="138" style={{ animationDelay: "-3s" }} />
          <line x1="300" x2="334" y1="130" y2="130" style={{ animationDelay: "-5s" }} />
          <line x1="80" x2="100" y1="143" y2="143" style={{ animationDelay: "-7s" }} />
        </g>

        {/* the boat, drifting */}
        <g className="cs-drift">
          <ellipse className="cs-ring" cx="0" cy="111" rx="14" ry="2" />
          <ellipse className="cs-ring" cx="0" cy="111" rx="14" ry="2" style={{ animationDelay: "-2.5s" }} />
          <g className="cs-boat">
            <path className="cs-sail" d="M-1 108 L-1 90 L9 106 Z" />
            <path className="cs-sail dim" d="M-2 108 L-2 94 L-9 106 Z" />
            <path className="cs-hull" d="M-15 107 L15 107 L10 112 L-10 112 Z" />
            <path className="cs-shadow" d="M-10 113.5 L10 113.5" />
          </g>
        </g>
      </g>
    </svg>
  );
}
