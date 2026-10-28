import { LogoMark } from './logos/logos.js';
import type { ModelFamily, ProviderInfo } from './providers.js';

/**
 * A provider as a small pill: its mark and its name. The mark is the provider's logo, a neutral
 * icon for the mock, or for a provider the dashboard does not know, a tile with its initials in
 * the provider's colour. The name is always written out, so the mark is never the only cue.
 */
export function ProviderBadge({ provider }: { provider: ProviderInfo }) {
  const Icon = provider.icon;
  return (
    <span className="provider-badge" title={provider.name}>
      {provider.logo ? (
        <span className="provider-mark provider-logo" data-provider={provider.id}>
          <LogoMark logo={provider.logo} />
        </span>
      ) : Icon ? (
        <span
          className="provider-mark provider-icon"
          aria-hidden="true"
          data-provider={provider.id}
        >
          <Icon size={12} />
        </span>
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

/**
 * A model's name, with its family's logo in front when the family differs from the provider
 * serving it (Qwen or gpt-oss on Groq, Llama on Ollama).
 */
export function ModelLabel({ name, family }: { name: string; family: ModelFamily | null }) {
  if (!family) return <>{name}</>;
  return (
    <span className="model-label">
      <span
        className="family-mark"
        role="img"
        aria-label={`${family.name} model`}
        title={`${family.name} model`}
      >
        <LogoMark logo={family.logo} />
      </span>
      <span>{name}</span>
    </span>
  );
}
