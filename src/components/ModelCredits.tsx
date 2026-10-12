import { ExternalLink } from "lucide-react";
import { ENGINE_REGISTRY } from "../models/registry";
import type { EngineCredit } from "../models/types";

interface ModelCreditsProps {
  /** Prefix for heading ids, unique per mounted list. */
  idPrefix: string;
}

function CreditRow({ credit }: { credit: EngineCredit }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <p className="text-sm font-semibold text-text-primary">
        <a
          href={credit.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-accent hover:underline"
        >
          {credit.name} <ExternalLink size={11} aria-hidden="true" />
        </a>
        {credit.author && <span className="font-normal text-text-muted"> by {credit.author}</span>}
      </p>
      <p className="mt-0.5 text-xs leading-5 text-text-muted">
        Licence:{" "}
        {credit.licenseUrl
          ? (
            <a href={credit.licenseUrl} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
              {credit.license}
            </a>
          )
          : credit.license}
      </p>
      {credit.note && <p className="mt-0.5 text-xs leading-5 text-text-muted">{credit.note}</p>}
    </li>
  );
}

/**
 * The credits and licences of the models the engine registry ships, as the
 * engines declare them. A voice set with an attribution requirement (Piper's
 * LibriTTS voice is CC BY 4.0) is credited here as well as in its voice details.
 */
export function ModelCredits({ idPrefix }: ModelCreditsProps) {
  const engines = ENGINE_REGISTRY.filter((engine) => "credits" in engine && engine.credits.length > 0);

  return (
    <div className="space-y-6">
      <p className="max-w-xl text-sm leading-5 text-text-muted">
        Open TTS runs these speech models on your device. Weights are downloaded from their upstream hosts and are not
        redistributed by this app; each is used under its own licence. The README credits every other model and runtime.
      </p>
      {engines.map((engine) => (
        <section key={engine.id} aria-labelledby={`${idPrefix}-${engine.id}`}>
          <h4 id={`${idPrefix}-${engine.id}`} className="mb-2 text-sm font-semibold text-text-secondary">
            {engine.label}
          </h4>
          <ul className="divide-y divide-border/70">
            {("credits" in engine ? engine.credits : []).map((credit) => (
              <CreditRow key={`${credit.name}|${credit.sourceUrl}`} credit={credit} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
