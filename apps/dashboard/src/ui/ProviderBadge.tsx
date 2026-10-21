import type { ProviderInfo } from './providers.js';

/**
 * A provider as a small pill: its mark and its name. The mark is the provider's logo where its
 * brand owner allows that, otherwise a tile with its initials in the provider's colour. The name
 * is always written out, so the mark is never the only cue.
 */
export function ProviderBadge({ provider }: { provider: ProviderInfo }) {
  return (
    <span className="provider-badge" title={provider.name}>
      {provider.logo ? (
        <img className="provider-mark" src={provider.logo} alt="" aria-hidden="true" />
      ) : (
        <span
          className="provider-mark provider-initials"
          style={{ background: `color-mix(in srgb, ${provider.color} 24%, transparent)` }}
          aria-hidden="true"
          data-provider={provider.id}
        >
          {provider.initials}
        </span>
      )}
      <span className="provider-name">{provider.name}</span>
    </span>
  );
}
