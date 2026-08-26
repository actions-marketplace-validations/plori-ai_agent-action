import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentSessionURL,
  commentBody,
  defaultReviewPrompt,
  extractFinalReview,
  foldEvents,
  HTTPError,
  input,
  main,
  mintGitHubOIDC,
  publishComment,
  requestJSON,
  runAgent,
} from "./index.mjs";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function eventFixture(payload) {
  const dir = mkdtempSync(join(tmpdir(), "plori-action-test-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify(payload));
  return { path, cleanup: () => rmSync(dir, { recursive: true }) };
}

test("requestJSON exposes typed HTTP failures", async () => {
  await assert.rejects(
    requestJSON(async () => jsonResponse({ error: "payment required", claim_url: "https://claim" }, 402), "https://example.test"),
    (error) => error instanceof HTTPError && error.status === 402 && error.body.claim_url === "https://claim",
  );
});

test("input follows GitHub's hyphen-preserving environment contract", () => {
  assert.equal(input("repository-token", {
    "INPUT_REPOSITORY-TOKEN": "job-token",
    INPUT_REPOSITORY_TOKEN: "wrong-shape",
  }), "job-token");
});

test("agentSessionURL builds the canonical session deep link", () => {
  assert.equal(
    agentSessionURL("https://plori.ai/", "agent/1", "session?1"),
    "https://plori.ai/agent/agent%2F1?session=session%3F1",
  );
});

test("mintGitHubOIDC requests only the Plori audience", async () => {
  let seen;
  const token = await mintGitHubOIDC(async (url, options) => {
    seen = { url: String(url), options };
    return jsonResponse({ value: "signed-jwt" });
  }, {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?job=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  });
  assert.equal(token, "signed-jwt");
  assert.equal(new URL(seen.url).searchParams.get("audience"), "plori.ai");
  assert.equal(seen.options.headers.Authorization, "Bearer request-token");
});

test("foldEvents assembles base64-encoded durable AG-UI rows", () => {
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
  const state = foldEvents({ review: "", error: "", cause: "" }, [
    { event_type: "TEXT_MESSAGE_CONTENT", data: encoded({ type: "TEXT_MESSAGE_CONTENT", delta: "Hello " }) },
    { event_type: "TEXT_MESSAGE_CONTENT", data: encoded({ type: "TEXT_MESSAGE_CONTENT", delta: "world" }) },
  ]);
  assert.equal(state.review, "Hello world");
  assert.equal(state.error, "");
});

test("extractFinalReview ignores intermediate assistant narration", () => {
  assert.equal(
    extractFinalReview("I will inspect the diff.<!-- plori-review-result -->\n## Findings\n\nNo actionable findings."),
    "## Findings\n\nNo actionable findings.",
  );
  assert.equal(extractFinalReview("I will inspect the diff."), "");
});

test("default prompt pins exact PR commits and treats repository text as untrusted", () => {
  const prompt = defaultReviewPrompt({ GITHUB_REPOSITORY: "octo/repo" }, {
    pull_request: { number: 42, base: { sha: "base123" }, head: { sha: "head456" } },
  }, "Focus on migrations.");
  assert.match(prompt, /refs\/pull\/42\/head/);
  assert.match(prompt, /https:\/\/github\.com\/octo\/repo\.git/);
  assert.match(prompt, /base123/);
  assert.match(prompt, /head456/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /never.*push code/);
  assert.match(prompt, /non-interactive/);
  assert.match(prompt, /never request input, approval, or credentials/);
  assert.match(prompt, /at most two rounds of targeted checks/);
  assert.match(prompt, /mktemp -d/);
  assert.match(prompt, /<!-- plori-review-result -->/);
  assert.match(prompt, /Focus on migrations/);
});

test("runAgent exchanges OIDC, passes a read token for one turn, and polls the exact run", async () => {
  const fixture = eventFixture({
    repository: { full_name: "octo/repo" },
    pull_request: { number: 7, base: { sha: "aaa" }, head: { sha: "bbb" } },
  });
  const calls = [];
  let noticeOutput = "";
  const summary = join(tmpdir(), `plori-agent-link-${Date.now()}.md`);
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("https://oidc.example/")) return jsonResponse({ value: "oidc-jwt" });
    if (String(url).endsWith("/v1/github/oidc/exchange")) {
      return jsonResponse({ token: "plori_ghr_cap", agent_id: "agent-1", claim_url: "https://plori.ai/github/claim?t=x" });
    }
    if (String(url).endsWith("/v1/agents/agent-1/runs")) {
      return jsonResponse({ run_id: "run-1", session_id: "session-1" }, 202);
    }
    if (String(url).includes("/v1/github/runs/run-1?after_seq=0")) {
      return jsonResponse({
        run_id: "run-1",
        status: "completed",
        terminal: true,
        after_seq: 3,
        events: [
          { event_type: "TEXT_MESSAGE_CONTENT", data: Buffer.from(JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: "I will review the diff.<!-- plori-review-result -->No findings. Tests passed." })).toString("base64") },
          { event_type: "RUN_FINISHED", data: Buffer.from(JSON.stringify({ type: "RUN_FINISHED" })).toString("base64") },
        ],
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const result = await runAgent({
      fetchImpl,
      env: {
        "INPUT_API-BASE": "https://api.example",
        "INPUT_SITE-BASE": "https://console.example/",
        "INPUT_REPOSITORY-TOKEN": "read-only-job-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
        GITHUB_EVENT_PATH: fixture.path,
        GITHUB_REPOSITORY: "octo/repo",
        GITHUB_SERVER_URL: "https://ghe.example",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_STEP_SUMMARY: summary,
      },
      now: () => 1,
      stream: { write: (chunk) => { noticeOutput += chunk; } },
    });
    assert.deepEqual(result, {
      review: "No findings. Tests passed.",
      outcome: "succeeded",
      claimURL: "https://plori.ai/github/claim?t=x",
      runID: "run-1",
      sessionID: "session-1",
      agentURL: "https://console.example/agent/agent-1?session=session-1",
    });
    assert.match(noticeOutput, /Open the Plori agent: https:\/\/console\.example\/agent\/agent-1\?session=session-1/);
    assert.match(readFileSync(summary, "utf8"), /\[Open this agent\]\(https:\/\/console\.example\/agent\/agent-1\?session=session-1\)/);
    const invocation = calls.find((call) => call.url.endsWith("/v1/agents/agent-1/runs"));
    const body = JSON.parse(invocation.options.body);
    assert.equal(body.github_token, "read-only-job-token");
    assert.equal(body.github_server_url, "https://ghe.example");
    assert.equal(body.max_turn_seconds, 420);
    assert.match(body.idempotency_key, /octo\/repo:123:2:bbb$/);
    assert.equal(invocation.options.headers.Authorization, "Bearer plori_ghr_cap");
  } finally {
    fixture.cleanup();
    rmSync(summary, { force: true });
  }
});

test("runAgent fails before OIDC exchange when the repository token is missing", async () => {
  let calls = 0;
  await assert.rejects(
    runAgent({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
      env: { "INPUT_API-BASE": "https://api.example" },
    }),
    /repository-token is required/,
  );
  assert.equal(calls, 0);
});

test("runAgent rejects a remote review that waits for input", async () => {
  await assert.rejects(
    runAgent({
      fetchImpl: async (url) => {
        if (String(url).endsWith("/v1/agents/agent-1/runs")) {
          return jsonResponse({ run_id: "run-1", session_id: "session-1" }, 202);
        }
        if (String(url).includes("/v1/github/runs/run-1?after_seq=0")) {
          return jsonResponse({ run_id: "run-1", status: "awaiting_input", terminal: true, after_seq: 2, events: [] });
        }
        throw new Error(`unexpected URL ${url}`);
      },
      env: {
        "INPUT_API-BASE": "https://api.example",
        "INPUT_PLORI-API-KEY": "plori_sk_test",
        "INPUT_AGENT-ID": "agent-1",
        "INPUT_REPOSITORY-TOKEN": "read-only-job-token",
      },
      now: () => 1,
    }),
    /non-interactive/,
  );
});

test("runAgent rejects a completed review with no text", async () => {
  await assert.rejects(
    runAgent({
      fetchImpl: async (url) => {
        if (String(url).endsWith("/v1/agents/agent-1/runs")) {
          return jsonResponse({ run_id: "run-1", session_id: "session-1" }, 202);
        }
        if (String(url).includes("/v1/github/runs/run-1?after_seq=0")) {
          return jsonResponse({ run_id: "run-1", status: "completed", terminal: true, after_seq: 1, events: [] });
        }
        throw new Error(`unexpected URL ${url}`);
      },
      env: {
        "INPUT_API-BASE": "https://api.example",
        "INPUT_PLORI-API-KEY": "plori_sk_test",
        "INPUT_AGENT-ID": "agent-1",
        "INPUT_REPOSITORY-TOKEN": "read-only-job-token",
      },
      now: () => 1,
    }),
    /without a marked final review/,
  );
});

test("quota exhaustion returns a claim notice without starting a run", async () => {
  let calls = 0;
  const result = await runAgent({
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).startsWith("https://oidc.example/")) return jsonResponse({ value: "oidc-jwt" });
      return jsonResponse({
        error: "claim required",
        code: "github_repo_claim_required",
        repository: "octo/repo",
        claim_url: "https://plori.ai/github/claim?t=signed",
      }, 402);
    },
    env: {
      "INPUT_API-BASE": "https://api.example",
      "INPUT_REPOSITORY-TOKEN": "read-only-job-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "claim_required");
  assert.equal(result.claimURL, "https://plori.ai/github/claim?t=signed");
  assert.equal(result.agentURL, "");
  assert.match(result.review, /Claim octo\/repo/);
});

test("comment mode edits the Action's prior marker comment instead of duplicating it", async () => {
  const fixture = eventFixture({ pull_request: { number: 9 }, repository: { full_name: "octo/repo" } });
  const calls = [];
  try {
    const result = await publishComment({
      env: {
        "INPUT_REPOSITORY-TOKEN": "comment-token",
        INPUT_RESULT: "One finding",
        INPUT_OUTCOME: "succeeded",
        GITHUB_EVENT_PATH: fixture.path,
        GITHUB_REPOSITORY: "octo/repo",
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (!options.method) {
          return jsonResponse([{ id: 1, url: "https://api.github.com/comment/1", body: "<!-- plori-agent-review --> old", user: { type: "Bot" } }]);
        }
        return jsonResponse({ id: 1 });
      },
    });
    assert.equal(result.updated, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, "PATCH");
    assert.match(JSON.parse(calls[1].options.body).body, /One finding/);
  } finally {
    fixture.cleanup();
  }
});

test("comment marker from model output cannot create a second managed region", () => {
  const body = commentBody("text <!-- plori-agent-review --> more", "succeeded", "");
  assert.equal(body.match(/<!-- plori-agent-review -->/g).length, 1);
});

test("fork comment denial stays successful and preserves the review in the job summary", async () => {
  const fixture = eventFixture({ pull_request: { number: 9 }, repository: { full_name: "octo/repo" } });
  const summary = join(tmpdir(), `plori-summary-${Date.now()}.md`);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ message: "Resource not accessible by integration" }, 403);
  try {
    await main({
      INPUT_MODE: "comment",
      "INPUT_REPOSITORY-TOKEN": "fork-read-token",
      INPUT_RESULT: "Review still available",
      GITHUB_EVENT_PATH: fixture.path,
      GITHUB_REPOSITORY: "octo/repo",
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.match(readFileSync(summary, "utf8"), /Review still available/);
  } finally {
    globalThis.fetch = previousFetch;
    fixture.cleanup();
    rmSync(summary, { force: true });
  }
});
