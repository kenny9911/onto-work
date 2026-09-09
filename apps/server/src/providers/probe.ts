import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { ProviderTestResult } from "@agent-harness/contracts";

const MAX_RESPONSE_BYTES = 64 * 1_024;

function failureMessage(status: number): string {
  if (status === 401 || status === 403) return "Authentication failed. Check the route credential and model access.";
  if (status === 404) return "The model or Responses endpoint was not found. Check the model and base URL.";
  if (status === 429) return "The provider rate limit or quota was reached. Check the account quota and try again.";
  if (status >= 300 && status < 400) return "The endpoint redirected the request. Use its direct Responses API base URL.";
  if (status >= 500) return "The provider is unavailable. Try again shortly.";
  return `The provider rejected the test request (HTTP ${status}). Check the model and route settings.`;
}

/** An admin-initiated, bounded connection check; never starts a Codex task. */
export async function probeProvider(input: {
  baseUrl: string;
  model: string;
  credential: string | null;
  allowAddress: (address: string) => boolean;
  timeoutMs?: number;
}): Promise<ProviderTestResult> {
  const started = performance.now();
  const result = (success: boolean, message: string): ProviderTestResult => ({
    success,
    message,
    model: input.model,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  });
  const signal = AbortSignal.timeout(input.timeoutMs ?? 15_000);
  const endpoint = new URL(`${input.baseUrl.replace(/\/$/, "")}/responses`);
  const body = JSON.stringify({
    model: input.model,
    input: "Reply with OK.",
    max_output_tokens: 64,
    stream: false,
    store: false,
  });
  let addressBlocked = false;
  const safeLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, { all: true, family: options.family ?? 0 }, (error, addresses) => {
      if (error) return callback(error, []);
      if (!addresses.length || addresses.some(({ address }) => !input.allowAddress(address))) {
        addressBlocked = true;
        return callback(new Error("Provider endpoint address is blocked"), []);
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  try {
    return await new Promise<ProviderTestResult>((resolve, reject) => {
      const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(endpoint, {
        method: "POST",
        signal,
        lookup: safeLookup,
        // A fresh connection applies DNS policy for every check, including after
        // an operator changes the private-endpoint policy.
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body),
          ...(input.credential ? { authorization: `Bearer ${input.credential}` } : {}),
        },
      }, (response) => {
        const status = response.statusCode ?? 502;
        if (status < 200 || status >= 300) {
          // Never expose provider-controlled error bodies or follow redirects.
          resolve(result(false, failureMessage(status)));
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            resolve(result(false, "The endpoint returned an oversized response. Check Responses API compatibility."));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            const incomplete = payload?.incomplete_details as { reason?: unknown } | null | undefined;
            if (
              payload && payload.object === "response" && Array.isArray(payload.output) &&
              (payload.status === "completed" ||
                (payload.status === "incomplete" && incomplete?.reason === "max_output_tokens")) && !payload.error
            ) {
              resolve(result(true, "The route accepted a Responses API request successfully."));
            } else {
              resolve(result(false, "The endpoint did not return a successful Responses API result. Check the model and API compatibility."));
            }
          } catch {
            resolve(result(false, "The endpoint did not return valid Responses API JSON. Check the base URL."));
          }
        });
      });
      request.on("error", reject);
      request.end(body);
    });
  } catch {
    if (signal.aborted) return result(false, "The route did not respond within the test timeout. Try again or check the endpoint.");
    if (addressBlocked) return result(false, "The endpoint resolves to an address blocked by the server deployment policy.");
    return result(false, "Could not connect to the provider. Check the endpoint, TLS configuration, and server network access.");
  }
}
