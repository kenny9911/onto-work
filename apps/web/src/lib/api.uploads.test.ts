import type { UploadDetailPayload } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, api } from "./api";

interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  withCredentials: boolean;
}

const sent: SentRequest[] = [];

/**
 * A minimal `XMLHttpRequest` stand-in. `respond` and `tick` are called by the
 * test to settle the request, which is what makes the progress reporting and
 * the failure decode observable at all — `fetch` exposes neither.
 */
class TransportMock {
  static latest: TransportMock | null = null;

  status = 0;
  responseText = "";
  withCredentials = false;
  private readonly requestHeaders: Record<string, string> = {};
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  private readonly uploadHandlers = new Map<string, Array<(event: unknown) => void>>();
  private method = "";
  private url = "";

  readonly upload = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      this.uploadHandlers.set(type, [...(this.uploadHandlers.get(type) ?? []), handler]);
    },
  };

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    TransportMock.latest = this;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  removeEventListener(): void {
    // The client only detaches its abort listener.
  }

  abort(): void {
    this.emit("abort");
  }

  send(body: unknown): void {
    sent.push({
      body,
      headers: { ...this.requestHeaders },
      method: this.method,
      url: this.url,
      withCredentials: this.withCredentials,
    });
  }

  tick(loaded: number, total: number): void {
    for (const handler of this.uploadHandlers.get("progress") ?? []) {
      handler({ lengthComputable: true, loaded, total });
    }
  }

  respond(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.emit("load");
  }

  fail(): void {
    this.emit("error");
  }

  private emit(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler({});
  }
}

function install(): void {
  sent.length = 0;
  TransportMock.latest = null;
  vi.stubGlobal("XMLHttpRequest", TransportMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upload transport", () => {
  it("streams the file itself and reports progress up to completion", async () => {
    install();
    const file = new File(["id,total\n1,2\n"], "Q3 invoices.csv", { type: "text/csv" });
    const progress: number[] = [];
    const payload: UploadDetailPayload = {
      upload: {
        contentType: "text/csv",
        createdAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-09-09T00:00:00.000Z",
        filename: "Q3 invoices.csv",
        id: "9b1f",
        projectId: null,
        scope: "thread",
        sizeBytes: 13,
        status: "stored",
        threadId: "thread/one",
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    };

    const pending = api.uploadToTask(
      "thread/one",
      file,
      (fraction) => progress.push(fraction),
      "key-1",
    );

    const transport = TransportMock.latest!;
    expect(sent).toEqual([
      {
        body: file,
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "key-1",
          // Percent-encoded UTF-8; the label never becomes a path component.
          "x-upload-filename": "Q3%20invoices.csv",
        },
        method: "POST",
        url: "/api/tasks/thread%2Fone/uploads",
        withCredentials: true,
      },
    ]);

    transport.tick(4, 16);
    transport.tick(0, 0);
    transport.respond(201, JSON.stringify(payload));

    await expect(pending).resolves.toEqual(payload);
    expect(progress).toEqual([0.25, 1]);
  });

  it("decodes a rejection into the control plane's own error code", async () => {
    install();
    const pending = api.uploadToProject(
      "project-1",
      new File(["x"], "notes.md", { type: "text/markdown" }),
      () => undefined,
      "key-2",
    );
    const transport = TransportMock.latest!;
    expect(sent[0]!.url).toBe("/api/projects/project-1/uploads");

    transport.respond(
      413,
      JSON.stringify({ error: "upload_too_large", message: "The file is larger than 20 MB." }),
    );

    const failure = await pending.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ApiClientError);
    expect(failure).toMatchObject({
      code: "upload_too_large",
      message: "The file is larger than 20 MB.",
      status: 413,
    });
  });

  it("falls back to request_failed for an undecodable body and to a client code offline", async () => {
    install();
    const undecodable = api.uploadToTask(
      "thread-1",
      new File(["x"], "a.txt", { type: "text/plain" }),
      () => undefined,
      "key-3",
    );
    TransportMock.latest!.respond(502, "<html>gateway</html>");
    await expect(undecodable).rejects.toMatchObject({
      code: "request_failed",
      status: 502,
    });

    install();
    const offline = api.uploadToTask(
      "thread-1",
      new File(["x"], "a.txt", { type: "text/plain" }),
      () => undefined,
      "key-4",
    );
    TransportMock.latest!.fail();
    await expect(offline).rejects.toMatchObject({ code: "network_error", status: 0 });
  });

  it("aborts an in-flight upload through its signal", async () => {
    install();
    const controller = new AbortController();
    const pending = api.uploadToTask(
      "thread-1",
      new File(["x"], "a.txt", { type: "text/plain" }),
      () => undefined,
      "key-5",
      controller.signal,
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "upload_aborted", status: 0 });
  });

  it("deletes an upload by opaque id without adding a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteUpload("upload/one")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/uploads/upload%2Fone",
      expect.objectContaining({
        credentials: "include",
        headers: {},
        method: "DELETE",
      }),
    );
  });
});
