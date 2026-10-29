/** What one model would cost for the composer's current request.

    /estimate answers in one of two shapes, and the panel needs a number from
    both so models can be ranked against each other:

    - `{ type: "estimate", usd, discount }` — a priced quote. `usd` is already
      net of the account discount; `discount.usd` is what was taken off.
    - `{ type: "description", pricing_description }` — prose (Seedance). It
      states rates before any account discount, so the figure is computed here:
      a per-second rate when the prose gives one, otherwise the per-1,000
      video-token rate against the output's pixel count.

    A computed figure borrows the discount percentage a priced quote in the
    same batch reported, when there is one. That is an inference — a 30s 720p
    Seedance 2.5 run billed 11.7871 against 13.866 list, which is that 15% —
    so the row says it is assumed rather than quoted. */

export type Estimate =
  | {
      kind: "priced" | "computed";
      /** What the account should pay, after discount when one is known. */
      usd: number;
      /** Price before discount. Equal to usd when no discount applies. */
      listUsd: number;
      discountPct: number | null;
      /** Plain-language basis for a computed figure. */
      basis?: string;
    }
  | { kind: "text"; text: string }
  | { kind: "unavailable"; reason: string };

export type EstimateResult = {
  modelId: string;
  path: string;
  /** Settings the estimate was made with, after fitting them to the model. */
  settings: Record<string, unknown>;
  estimate: Estimate;
};

/* Output pixels per resolution label. Seedance's published per-second rates
   divide back out to exactly these 16:9 frames; other aspect ratios keep about
   the same pixel count, so the figure stays an approximation for them. */
const PIXELS: Record<string, number> = {
  "480p": 854 * 480,
  "720p": 1280 * 720,
  "1080p": 1920 * 1080,
  "4k": 3840 * 2160,
};

export function readEstimate(payload: unknown, body: Record<string, unknown>): Estimate {
  const data = asRecord(payload);

  if (data.type === "estimate") {
    const usd = Number(data.usd);
    if (!Number.isFinite(usd)) return { kind: "text", text: "The platform returned no price." };
    const discount = asRecord(data.discount);
    const off = Number(discount.usd);
    const pct = Number(discount.percentage);
    return {
      kind: "priced",
      usd,
      listUsd: Number.isFinite(off) ? usd + off : usd,
      discountPct: Number.isFinite(pct) && pct > 0 ? pct : null,
    };
  }

  const text = typeof data.pricing_description === "string" ? data.pricing_description : "";
  const computed = computeFromDescription(text, body);
  if (computed) return { kind: "computed", ...computed, discountPct: null };
  return { kind: "text", text: text || "The platform returned no price." };
}

/** Applies a discount seen on a priced quote to the computed rows beside it. */
export function applyBatchDiscount(results: EstimateResult[]): EstimateResult[] {
  const pct = results
    .map((result) => (result.estimate.kind === "priced" ? result.estimate.discountPct : null))
    .find((value): value is number => value !== null);
  if (!pct) return results;
  return results.map((result) => {
    const estimate = result.estimate;
    if (estimate.kind !== "computed") return result;
    return {
      ...result,
      estimate: { ...estimate, usd: estimate.listUsd * (1 - pct / 100), discountPct: pct },
    };
  });
}

function computeFromDescription(
  text: string,
  body: Record<string, unknown>,
): { usd: number; listUsd: number; basis: string } | null {
  const seconds = Number(body.duration);
  const resolution = String(body.resolution ?? "").toLowerCase();
  if (!text || !Number.isFinite(seconds) || seconds <= 0) return null;

  // "$0.2056 per second of generated video at 480p, $0.4622 at 720p, and $1.1372 at 1080p"
  const perSecond = text.match(
    /\$([\d.]+) per second[^$]*at 480p, \$([\d.]+) at 720p,? and \$([\d.]+) at 1080p/i,
  );
  if (perSecond) {
    const index = { "480p": 1, "720p": 2, "1080p": 3 }[resolution];
    const rate = index ? Number(perSecond[index]) : NaN;
    if (Number.isFinite(rate)) {
      const usd = rate * seconds;
      return { usd, listUsd: usd, basis: `$${rate}/s × ${seconds}s at ${resolution}` };
    }
  }

  // "Per 1,000 video tokens: 480p/720p/1080p $0.014, 4K $0.008"
  // Up to the sentence's end — not the first ".", which is inside "$0.014".
  const perToken = text.match(/per 1,000 video tokens:?\s*(.*?)(?:\.\s|\.?$)/i);
  const pixels = PIXELS[resolution];
  if (perToken && pixels) {
    const rates = [...perToken[1].matchAll(/([\w/]+)\s+\$([\d.]+)/g)];
    const hit = rates.find(([, labels]) => labels.toLowerCase().split("/").includes(resolution));
    const rate = hit ? Number(hit[2]) : NaN;
    if (Number.isFinite(rate)) {
      const tokens = Math.ceil((pixels * seconds * 24) / 1024);
      const usd = (tokens / 1000) * rate;
      return {
        usd,
        listUsd: usd,
        basis: `${tokens.toLocaleString("en")} video tokens × $${rate}/1k at ${resolution}`,
      };
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
