"use server";

import { cookies } from "next/headers";

import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane } from "./catalog/types";
import {
  MissingCredentialsError,
  PLATFORM_KEY_COOKIE,
  PLATFORM_KEY_COOKIE_OPTIONS,
  decodeCredentials,
  encodeCredentials,
  parseCredentialInput,
} from "./credentials";
import { applyBatchDiscount, readEstimate } from "./estimate";
import type { EstimateResult } from "./estimate";
import { PlatformError, createPlatformClient } from "./platform";
import type { StatusResult } from "./platform";
import { toPlatform } from "./to-platform";

export async function savePlatformCredentials(data: unknown) {
  const { apiKey } = parseCredentialInput(data);
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, encodeCredentials(apiKey), PLATFORM_KEY_COOKIE_OPTIONS);
}

export async function clearPlatformCredentials() {
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, "", { ...PLATFORM_KEY_COOKIE_OPTIONS, maxAge: 0 });
}

export async function hasPlatformCredentials() {
  return (await readStoredCredentials()) !== null;
}

export async function submitGeneration(plane: GenerationPlane) {
  const model = getModel(plane.model);
  const parsed: GenerationPlane = {
    ...plane,
    settings: parseSettings(model, plane.settings),
  };
  const { path, body } = toPlatform(parsed);
  return createPlatformClient(await readCredentials()).submit(path, body);
}

/** Prices for the selected model and every model it is compared with, in one
    round trip for the same reason statuses are batched. Each plane goes through
    the submit mapper, so the estimate is for the path and body a press of
    Generate would send. A plane that cannot be priced carries its reason alone. */
export async function estimateGenerations(data: unknown): Promise<EstimateResult[]> {
  const planes = parsePlanes(data);
  const client = createPlatformClient(await readCredentials());
  const results = await Promise.all(
    planes.map(async (plane): Promise<EstimateResult> => {
      let path = "";
      let settings: Record<string, unknown> = {};
      try {
        const model = getModel(plane.model);
        settings = parseSettings(model, plane.settings);
        // The price does not depend on the words; the endpoint still wants some.
        const text = plane.prompt.text.trim() || "Price estimate";
        const mapped = toPlatform({ ...plane, prompt: { text }, settings });
        path = mapped.path;
        const payload = await client.estimate(mapped.path, mapped.body);
        return { modelId: plane.model, path, settings, estimate: readEstimate(payload, mapped.body) };
      } catch (caught) {
        return { modelId: plane.model, path, settings, estimate: { kind: "unavailable", reason: reasonOf(caught) } };
      }
    }),
  );
  return applyBatchDiscount(results);
}

function reasonOf(caught: unknown): string {
  if (caught instanceof PlatformError) {
    if (caught.status === 423) return "Not available on this account";
    if (caught.status === 422 || caught.status === 400) return `Needs different input: ${caught.message}`;
    return caught.message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

function parsePlanes(data: unknown): GenerationPlane[] {
  const payload = asObject(data, "Invalid estimate payload");
  if (!Array.isArray(payload.planes) || payload.planes.length === 0 || payload.planes.length > 12) {
    throw new Error("Invalid estimate planes");
  }
  return payload.planes.map((raw) => {
    const plane = asObject(raw, "Invalid estimate plane");
    if (typeof plane.model !== "string") throw new Error("Invalid estimate model");
    const text = asObject(plane.prompt, "Invalid prompt").text;
    return {
      model: plane.model,
      prompt: { text: typeof text === "string" ? text : "" },
      media: asObject(plane.media, "Invalid media") as GenerationPlane["media"],
      settings: asObject(plane.settings, "Invalid settings"),
    };
  });
}

/** Every request in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call, where it is
    genuinely parallel. */
export async function getGenerationStatuses(data: unknown): Promise<StatusResult[]> {
  const requestIds = parseRequestIds(data);
  const client = createPlatformClient(await readCredentials());
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await client.status(requestId) };
      } catch (caught) {
        return { requestId, error: caught instanceof Error ? caught.message : String(caught) };
      }
    }),
  );
}

async function readStoredCredentials() {
  const jar = await cookies();
  return decodeCredentials(jar.get(PLATFORM_KEY_COOKIE)?.value);
}

async function readCredentials() {
  const stored = await readStoredCredentials();
  if (!stored) throw new MissingCredentialsError();
  const baseUrl = process.env.HF_API_BASE_URL;
  if (!baseUrl) throw new Error("Missing HF_API_BASE_URL");
  return { ...stored, baseUrl };
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload");
  const requestIds = payload.requestIds;
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("Invalid request ids");
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new Error("Invalid request id");
    return requestId;
  });
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message);
  return data as Record<string, unknown>;
}
