"use client";

import { useEffect, useRef, useState } from "react";

import { estimateGenerations } from "@/generation/actions";
import { getModel } from "@/generation/catalog";
import type { Estimate, EstimateResult } from "@/generation/estimate";
import { assemblePlane, comparePlane } from "@/generation/plane";
import type { ComparePlane } from "@/generation/plane";
import { useActive } from "@/generation/stores/active";
import { MAX_COMPARE, useCompare } from "@/generation/stores/compare";
import { useImageMedia, useVideoMedia } from "@/generation/stores/media";
import { useSettings } from "@/generation/stores/settings";

import { countSetting, settingLabel } from "./data";
import { CloseIcon, PlusIcon } from "./icons";
import { ModelIcon } from "./model-icon";
import { ModelPicker } from "./model-picker";

/* Settings changes arrive per click and per slider step; one request after
   they settle, not one per step. */
const DEBOUNCE_MS = 450;

/* The settings that move a price, in the order a reader compares them. */
const SUMMARY_KEYS = ["duration", "resolution", "aspectRatio", "generateAudio", "batchSize"];

type Row = {
  modelId: string;
  adjusted: ComparePlane["adjusted"];
  /** Requests one press of Generate sends for this model. */
  presses: number;
  result?: EstimateResult;
};

export function CostPanel({
  keyConfigured,
  onKeys,
  onClose,
}: {
  keyConfigured: boolean;
  onKeys: () => void;
  onClose: () => void;
}) {
  const modelId = useActive((state) => state.model);
  const surface = useActive((state) => state.surface);
  const batch = useActive((state) => state.batch);
  const byModel = useSettings((state) => state.byModel);
  const imageItems = useImageMedia((state) => state.items);
  const videoItems = useVideoMedia((state) => state.items);
  const compareIds = useCompare((state) => state.ids);
  const addCompare = useCompare((state) => state.add);
  const removeCompare = useCompare((state) => state.remove);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const sequence = useRef(0);

  const others = compareIds.filter((id) => id !== modelId && getModel(id).surface === surface);
  const othersKey = others.join("|");
  const items = surface === "image" ? imageItems : videoItems;

  useEffect(() => {
    if (!keyConfigured) return;
    const base = assemblePlane();
    const compared = othersKey ? othersKey.split("|").map((id) => comparePlane(base, id)) : [];
    const next: Row[] = [
      { modelId: base.model, adjusted: [], presses: pressesFor(base.model, batch) },
      ...compared.map(({ plane, adjusted }) => ({
        modelId: plane.model,
        adjusted,
        presses: pressesFor(plane.model, batch),
      })),
    ];
    setRows((current) =>
      next.map((row) => ({ ...row, result: current.find((old) => old.modelId === row.modelId)?.result })),
    );
    setLoading(true);

    const ticket = ++sequence.current;
    const timer = setTimeout(() => {
      estimateGenerations({ planes: [base, ...compared.map((entry) => entry.plane)] })
        .then((results) => {
          if (ticket !== sequence.current) return;
          setRows(next.map((row, index) => ({ ...row, result: results[index] })));
          setFailure(null);
        })
        .catch((caught: unknown) => {
          if (ticket !== sequence.current) return;
          setFailure(caught instanceof Error ? caught.message : "Could not reach the platform");
        })
        .finally(() => {
          if (ticket === sequence.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyConfigured, modelId, surface, batch, byModel, items, othersKey]);

  const selected = rows[0];
  const baseUsd = selected ? totalOf(selected) : null;

  return (
    <aside className="ohf-cost" aria-label="Cost estimate" aria-busy={loading}>
      <div className="ohf-cost-head">
        <h2 className="ohf-cost-title">Estimated cost</h2>
        <button
          type="button"
          className="ohf-icon-btn ohf-icon-btn--ghost"
          aria-label="Hide cost panel"
          title="Hide cost panel"
          onClick={onClose}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      {!keyConfigured ? (
        <div className="ohf-cost-empty">
          <p>Estimates come from the platform, so they need your key.</p>
          <button type="button" className="ohf-btn-solid" onClick={onKeys}>
            Add key
          </button>
        </div>
      ) : (
        <div className="ohf-cost-body ohf-scroll">
          {failure && <p className="ohf-cost-failure">{failure}</p>}

          <div className="ohf-pop-head ohf-cost-group">Selected</div>
          {selected && <CostRow row={selected} baseUsd={null} />}

          <div className="ohf-cost-group-row">
            <div className="ohf-pop-head ohf-cost-group">Compare</div>
            <div className="ohf-cost-add-wrap">
              <button
                type="button"
                className="ohf-cost-add"
                disabled={others.length >= MAX_COMPARE}
                aria-expanded={picking}
                onClick={() => setPicking((open) => !open)}
              >
                <PlusIcon size={12} /> Add model
              </button>
              {picking && (
                <ModelPicker
                  selectedId={modelId}
                  surface={surface}
                  /* Only models that take the request as set: a 15 s clip is not
                     compared against a model that tops out at 10 s. */
                  accepts={(model) => {
                    const base = assemblePlane();
                    return model.id === base.model || comparePlane(base, model.id).adjusted.length === 0;
                  }}
                  onPick={(model) => {
                    if (model.id !== modelId) addCompare(model.id);
                    setPicking(false);
                  }}
                  onClose={() => setPicking(false)}
                />
              )}
            </div>
          </div>

          {rows.length <= 1 && (
            <p className="ohf-cost-hint">
              Add models to price this same request on each of them. Your prompt, inputs and
              settings carry over wherever the model accepts them.
            </p>
          )}
          {rows.slice(1).map((row) => (
            <CostRow
              key={row.modelId}
              row={row}
              baseUsd={baseUsd}
              onRemove={() => removeCompare(row.modelId)}
            />
          ))}

          <p className="ohf-cost-note">
            Quoted prices come from the platform&apos;s estimate. Prices marked ≈ are worked out
            from its published rates and may differ slightly from the bill.
          </p>
        </div>
      )}
    </aside>
  );
}

function CostRow({
  row,
  baseUsd,
  onRemove,
}: {
  row: Row;
  baseUsd: number | null;
  onRemove?: () => void;
}) {
  const model = getModel(row.modelId);
  const estimate = row.result?.estimate;
  const total = totalOf(row);

  return (
    <div className="ohf-cost-row">
      <div className="ohf-cost-row-top">
        <span className="ohf-cost-model">
          <ModelIcon modelId={model.id} size={14} />
          {model.label}
        </span>
        {onRemove && (
          <button
            type="button"
            className="ohf-icon-btn ohf-icon-btn--ghost ohf-cost-remove"
            aria-label={`Remove ${model.label}`}
            title="Remove"
            onClick={onRemove}
          >
            <CloseIcon size={11} />
          </button>
        )}
      </div>

      <div className="ohf-cost-price-line">
        <span className="ohf-cost-price">
          {total === null ? (estimate ? "—" : "…") : `${estimate?.kind === "computed" ? "≈ " : ""}${usd(total)}`}
        </span>
        {total !== null && baseUsd !== null && baseUsd > 0 && <Delta total={total} base={baseUsd} />}
      </div>

      {estimate && <EstimateDetail estimate={estimate} presses={row.presses} />}
      {row.result && <p className="ohf-cost-meta">{summary(row.result.settings)}</p>}
      {row.adjusted.map(({ key, from, to }) => (
        <p key={key} className="ohf-cost-adjusted">
          {settingLabel(key)} {String(from)} → {String(to)}
        </p>
      ))}
    </div>
  );
}

function EstimateDetail({ estimate, presses }: { estimate: Estimate; presses: number }) {
  if (estimate.kind === "unavailable") return <p className="ohf-cost-meta ohf-cost-warn">{estimate.reason}</p>;
  if (estimate.kind === "text") return <p className="ohf-cost-meta">{estimate.text}</p>;
  const parts: string[] = [];
  if (presses > 1) parts.push(`${presses} × ${usd(estimate.usd)}`);
  if (estimate.discountPct) {
    parts.push(
      `${estimate.kind === "computed" ? "assumes" : "after"} ${estimate.discountPct}% discount · list ${usd(estimate.listUsd * presses)}`,
    );
  }
  if (estimate.basis) parts.push(estimate.basis);
  return parts.length ? <p className="ohf-cost-meta">{parts.join(" · ")}</p> : null;
}

function Delta({ total, base }: { total: number; base: number }) {
  const diff = total - base;
  if (Math.abs(diff) < 0.005) return <span className="ohf-cost-delta">same</span>;
  const ratio = total / base;
  const label = ratio >= 2 || ratio <= 0.5 ? `${ratio.toFixed(1)}×` : `${diff > 0 ? "+" : "−"}${usd(Math.abs(diff))}`;
  return <span className={`ohf-cost-delta ${diff < 0 ? "is-less" : "is-more"}`}>{label}</span>;
}

/** A model with its own count setting carries the batch in the request; any
    other is submitted once per result, so one press costs that many requests. */
function pressesFor(modelId: string, batch: number): number {
  return countSetting(getModel(modelId)) ? 1 : batch;
}

function totalOf(row: Row): number | null {
  const estimate = row.result?.estimate;
  if (!estimate || (estimate.kind !== "priced" && estimate.kind !== "computed")) return null;
  return estimate.usd * row.presses;
}

function summary(settings: Record<string, unknown>): string {
  return SUMMARY_KEYS.filter((key) => key in settings)
    .map((key) => {
      const value = settings[key];
      if (key === "duration") return `${String(value)}s`;
      if (key === "generateAudio") return value ? "audio" : "no audio";
      if (key === "batchSize") return `${String(value)} per run`;
      return String(value);
    })
    .join(" · ");
}

function usd(value: number): string {
  return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}
