import { useId } from "react";

/** The Big Surf crest (brand kit: logo/mark, "Legacy in the Barrel"), drawn from
 *  the kit's SVG geometry unchanged and coloured by the semantic tokens.
 *
 *  It is drawn inline on purpose. The figure inside the crest is a mask image in
 *  a sibling file (`_figure-mask.png`), and a browser will not load a file that
 *  is referenced from inside an SVG used as an <img>. The first build loaded the
 *  kit's SVG with <img> and so showed the crest with the figure missing. */
export function Mark({ className }: { className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg className={className ? `mark ${className}` : "mark"} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`${id}-disc`}><circle cx="100" cy="100" r="88" /></clipPath>
        <clipPath id={`${id}-box`}><rect x="28" y="52" width="144" height="105" /></clipPath>
        <mask id={`${id}-fig`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <image href="/icons/_figure-mask.png" x="12.16" y="34.68" width="184.3" height="183.8" />
        </mask>
      </defs>
      <circle className="mark__fg" cx="100" cy="100" r="96" />
      <circle className="mark__cut" cx="100" cy="100" r="88" />
      <g clipPath={`url(#${id}-disc)`}>
        <path className="mark__fg-line" d="M14 150 C14 60 70 8 126 20 C170 30 192 66 176 96" strokeWidth="18" strokeLinecap="round" />
        <path className="mark__cut-line" d="M26 150 C26 72 74 26 124 36" strokeWidth="3" strokeLinecap="round" />
        <circle className="mark__fg" cx="176" cy="96" r="13" />
        <circle className="mark__fg" cx="164" cy="110" r="9" />
        <circle className="mark__fg" cx="154" cy="122" r="6" />
        <circle className="mark__fg" cx="147" cy="131" r="3.5" />
        <g clipPath={`url(#${id}-box)`}>
          <rect className="mark__fg" x="0" y="0" width="200" height="200" mask={`url(#${id}-fig)`} />
        </g>
        <path className="mark__fg" d="M0 158 Q20 146 40 158 T80 158 T120 158 T160 158 T200 158 L200 200 L0 200 Z" />
        <path className="mark__cut-line" d="M0 172 Q20 162 40 172 T80 172 T120 172 T160 172 T200 172" strokeWidth="3" />
      </g>
    </svg>
  );
}
