import { ProviderError } from "@orbitops/integration-common/provider-error";
import { describe, expect, it, vi } from "vitest";
import { AnalysisService, type AnalyzeRequest } from "./analysis/analysis.service";
import { buildApp } from "./app";
import type { CompletionInput, LlmClient } from "./llm/openai";
import { sampleBundle, type SampleKind } from "./test-support/bundles";
import { fakeDb } from "./test-support/fake-db";

const TOKEN = "t".repeat(40);
const options = { maxInputTokens: 24_000, maxOutputTokens: 2_500, rateHour: 3, rateDay: 5, cacheMinutes: 10 };

const modelAnswer = {
  verdict: "failing",
  summary: "The api does not listen on Render's port.",
  problems: [
    {
      id: "p1",
      title: "Wrong port",
      severity: "high",
      category: "PORT_BINDING",
      componentIds: ["c_api"],
      rootCause: "It binds localhost:3000 instead of 0.0.0.0:$PORT.",
      confidence: 0.9,
      evidence: [{ componentId: "c_api", source: "render", line: "==> No open ports detected, continuing to scan...", deploymentId: "d_api2" }],
    },
  ],
  steps: [{ order: 1, title: "Listen on PORT", detail: "app.listen(process.env.PORT, '0.0.0.0')", problemIds: ["p1"], where: "repository", componentId: "c_api", command: null, file: "backend/index.js", envKey: "PORT" }],
  components: [
    { componentId: "c_web", status: "warning", note: "not redeployed" },
    { componentId: "c_api", status: "failing", note: "no open port" },
  ],
  providerNotes: null,
  followUps: [],
};

function stubLlm(answer: unknown = modelAnswer): LlmClient & { calls: CompletionInput[]; complete: ReturnType<typeof vi.fn> } {
  const calls: CompletionInput[] = [];
  const complete = vi.fn(async (input: CompletionInput) => {
    calls.push(input);
    return { json: structuredClone(answer), model: "gpt-4o-mini-2024-07-18", usage: { promptTokens: 4321, completionTokens: 321 } };
  });
  return { model: "gpt-4o-mini", calls, complete } as never;
}

const request = (kind: SampleKind = "port", over: Partial<AnalyzeRequest> = {}): AnalyzeRequest => ({
  userId: "u1",
  projectId: "p1",
  scope: "project",
  componentId: null,
  deploymentId: null,
  question: null,
  force: false,
  bundle: sampleBundle(kind),
  ...over,
});

describe("AnalysisService", () => {
  it("answers with OpenAI, validated, and stores the usage", async () => {
    const { db, aiAnalysis } = fakeDb();
    const llm = stubLlm();
    const view = await new AnalysisService(db, llm, options).analyze(request());
    expect(view).toMatchObject({ engine: "openai", model: "gpt-4o-mini-2024-07-18", cached: false, usage: { promptTokens: 4321, completionTokens: 321 } });
    expect(view.result.verdict).toBe("failing");
    expect(view.result.problems[0].evidence).toHaveLength(1);
    expect(llm.calls[0].system).toMatch(/diagnose the WHOLE PROJECT/);
    expect(llm.calls[0].user).toMatch(/<timeline>/);
    expect(aiAnalysis.rows).toHaveLength(1);
  });

  it("falls back to the rules without a key, and when OpenAI fails, saying why", async () => {
    const { db } = fakeDb();
    const noKey = await new AnalysisService(db, null, options).analyze(request("missing-env"));
    expect(noKey).toMatchObject({ engine: "rules", model: null });
    expect(noKey.notice).toMatch(/No OPENAI_API_KEY/);
    expect(noKey.result.steps.some((s) => s.envKey === "STRIPE_KEY")).toBe(true);

    const failing = stubLlm();
    failing.complete.mockRejectedValueOnce(new ProviderError("OpenAI rejected OPENAI_API_KEY.", 502, "openai_key_invalid"));
    const fallback = await new AnalysisService(fakeDb().db, failing, options).analyze(request("port"));
    expect(fallback.engine).toBe("rules");
    expect(fallback.notice).toMatch(/could not answer.*openai_key_invalid/);
    expect(fallback.result.verdict).toBe("failing");

    const garbage = await new AnalysisService(fakeDb().db, stubLlm({ verdict: "bogus" }), options).analyze(request("port"));
    expect(garbage.engine).toBe("rules");
  });

  it("sends only redacted text to the model, and the user's question fenced", async () => {
    const llm = stubLlm();
    const b = sampleBundle("port");
    b.components[1].log!.entries[1].text = "DATABASE_URL=postgres://u:supersecret@ep-1.neon.tech/db";
    await new AnalysisService(fakeDb().db, llm, options).analyze(request("port", { bundle: b, question: "why does it fail?" }));
    expect(llm.calls[0].user).not.toContain("supersecret");
    expect(llm.calls[0].user).toMatch(/<question>\nwhy does it fail\?\n<\/question>/);
  });

  it("returns a cached answer for the same input, unless forced", async () => {
    const { db } = fakeDb();
    const llm = stubLlm();
    const service = new AnalysisService(db, llm, options);
    const first = await service.analyze(request());
    const again = await service.analyze(request());
    expect(again).toMatchObject({ id: first.id, cached: true });
    expect(llm.complete).toHaveBeenCalledTimes(1);
    const forced = await service.analyze(request("port", { force: true }));
    expect(forced.id).not.toBe(first.id);
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  it("limits analyses per user per hour, and one at a time per project", async () => {
    const { db } = fakeDb();
    const service = new AnalysisService(db, null, options);
    for (const kind of ["port", "missing-env", "start-cmd"] as const) await service.analyze(request(kind));
    await expect(service.analyze(request("healthy"))).rejects.toMatchObject({ status: 429, code: "ai_rate_limited" });
    await expect(service.analyze(request("port"))).resolves.toMatchObject({ cached: true }); // cache hits are free

    let release!: () => void;
    const slow = stubLlm();
    slow.complete.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ json: modelAnswer, model: "m", usage: { promptTokens: 1, completionTokens: 1 } }))));
    const busy = new AnalysisService(fakeDb().db, slow, options);
    const running = busy.analyze(request("port"));
    await new Promise((r) => setTimeout(r, 10));
    await expect(busy.analyze(request("start-cmd"))).rejects.toMatchObject({ status: 409, code: "ai_busy" });
    release();
    await running;
  });

  it("scopes a component analysis to that component", async () => {
    const llm = stubLlm();
    const view = await new AnalysisService(fakeDb().db, llm, options).analyze(request("port", { scope: "component", componentId: "c_api" }));
    expect(llm.calls[0].system).toMatch(/ONE COMPONENT/);
    expect(llm.calls[0].user).toMatch(/Analyse the component "api" \(id c_api, render\)/);
    expect(view.result.components.map((c) => c.componentId)).toEqual(["c_api"]);
    await expect(new AnalysisService(fakeDb().db, llm, options).analyze(request("port", { scope: "component", componentId: "nope" }))).rejects.toMatchObject({ status: 400 });
  });

  it("lists, reads and takes feedback only for the owner", async () => {
    const { db } = fakeDb();
    const service = new AnalysisService(db, null, options);
    const view = await service.analyze(request("port"));
    expect(await service.list("u1", "p1")).toMatchObject([{ id: view.id, verdict: "failing", engine: "rules" }]);
    await expect(service.get("u2", view.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.feedback("u1", view.id, true)).resolves.toEqual({ id: view.id, helpful: true });
    expect((await service.get("u1", view.id)).helpful).toBe(true);
  });
});

describe("AI service API", () => {
  const app = () => {
    const { db } = fakeDb();
    return buildApp({ serviceToken: TOKEN, analyses: new AnalysisService(db, null, options) });
  };
  const headers = { "x-internal-token": TOKEN };

  it("needs the internal token, and reports the engine on /health", async () => {
    const server = app();
    expect((await server.inject({ method: "POST", url: "/analyses", payload: {} })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", openaiConfigured: false, model: null });
  });

  it("runs an analysis and refuses a malformed request", async () => {
    const server = app();
    const res = await server.inject({ method: "POST", url: "/analyses", headers, payload: request("port") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ engine: "rules", result: { verdict: "failing" } });
    expect((await server.inject({ method: "POST", url: "/analyses", headers, payload: { ...request(), scope: "everything" } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/analyses", headers, payload: { ...request(), scope: "component", componentId: null } })).statusCode).toBe(400);
    const id = res.json().id;
    expect((await server.inject({ method: "GET", url: `/analyses/${id}?userId=u2`, headers })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: `/analyses/${id}/feedback`, headers, payload: { userId: "u1", helpful: "yes" } })).statusCode).toBe(400);
  });
});
