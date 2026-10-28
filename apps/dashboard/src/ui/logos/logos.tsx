/**
 * Provider and model-family logos (see NOTICE.md), bundled with the app: no runtime fetch from a
 * CDN. Mono logos are drawn in the text colour, so they follow the dark and light themes; colour
 * logos keep their own colours, which read on both.
 */
import geminiColor from './gemini-color.svg';
import groq from './groq.svg';
import metaColor from './meta-color.svg';
import ollama from './ollama.svg';
import openai from './openai.svg';
import qwenColor from './qwen-color.svg';

export interface Logo {
  /** The bundled SVG's URL. */
  src: string;
  /** Drawn in the current text colour (a mask), rather than with its own colours. */
  mono: boolean;
}

export const LOGOS = {
  groq: { src: groq, mono: true },
  ollama: { src: ollama, mono: true },
  openai: { src: openai, mono: true },
  gemini: { src: geminiColor, mono: false },
  qwen: { src: qwenColor, mono: false },
  meta: { src: metaColor, mono: false },
} satisfies Record<string, Logo>;

/** A logo at the size of the surrounding text; decorative, since a name is always next to it. */
export function LogoMark({ logo, className }: { logo: Logo; className?: string }) {
  const classes = `logo-mark${className ? ` ${className}` : ''}`;
  if (!logo.mono) return <img className={classes} src={logo.src} alt="" aria-hidden="true" />;
  const mask = `url("${logo.src}")`;
  return (
    <span
      className={`${classes} logo-mono`}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      aria-hidden="true"
    />
  );
}
