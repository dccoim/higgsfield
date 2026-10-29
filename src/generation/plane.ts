import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane, MediaItem, MediaRole } from "./catalog/types";
import { useActive } from "./stores/active";
import { useImageMedia, useVideoMedia } from "./stores/media";
import { useImagePrompt, useVideoPrompt } from "./stores/prompt";
import { useSettings } from "./stores/settings";

export type ComparePlane = {
  plane: GenerationPlane;
  /** Where the selected model's value did not fit this one, e.g. duration 30 → 10. */
  adjusted: Array<{ key: string; from: unknown; to: unknown }>;
};

/** The selected request, re-aimed at another model: same prompt and media,
    and the same settings wherever this model accepts them. A value it cannot
    take falls back to what the visitor last chose for this model (or its
    default), and a range is clamped — both reported, so the panel can say why
    two prices are not quite like for like. */
export function comparePlane(base: GenerationPlane, modelId: string): ComparePlane {
  const model = getModel(modelId);
  const settings = parseSettings(model, useSettings.getState().byModel[model.id] ?? {});
  const adjusted: ComparePlane["adjusted"] = [];

  for (const [key, field] of Object.entries(model.settings)) {
    if (!(key in base.settings)) continue;
    const wanted = base.settings[key];
    if (field.type === "enum") {
      if (typeof wanted === "string" && field.values.includes(wanted)) settings[key] = wanted;
      else adjusted.push({ key, from: wanted, to: settings[key] });
    } else if (field.type === "range") {
      if (typeof wanted !== "number") continue;
      const clamped = Math.min(field.max, Math.max(field.min, wanted));
      settings[key] = clamped;
      if (clamped !== wanted) adjusted.push({ key, from: wanted, to: clamped });
    } else if (typeof wanted === "boolean") {
      settings[key] = wanted;
    }
  }

  const media: GenerationPlane["media"] = {};
  for (const [role, items] of Object.entries(base.media) as Array<[MediaRole, MediaItem[]]>) {
    const max = model.roles[role];
    if (max) media[role] = items.slice(0, max);
  }

  return { plane: { model: model.id, prompt: base.prompt, media, settings }, adjusted };
}

export function assemblePlane(): GenerationPlane {
  const { model: modelId, surface } = useActive.getState();
  const model = getModel(modelId);
  const text = (surface === "image" ? useImagePrompt : useVideoPrompt).getState().text;
  const items = (surface === "image" ? useImageMedia : useVideoMedia).getState().items;
  const media: GenerationPlane["media"] = {};
  for (const item of items) {
    const max = model.roles[item.role];
    if (!max) continue;
    const list = media[item.role] ?? [];
    if (list.length >= max) continue;
    list.push(item);
    media[item.role] = list;
  }
  return {
    model: model.id,
    prompt: { text },
    media,
    settings: parseSettings(model, useSettings.getState().byModel[model.id] ?? {}),
  };
}
