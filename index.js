#!/usr/bin/env node
// forbiz-mcp — MCP server for Forbiz, the CRM for AI agents.
//
// A thin translation of the public Forbiz Agent API (https://forbiz.io/openapi.json)
// into MCP tools. It adds no business logic: every rule (commitments, duplicates,
// capabilities, trial volume) is enforced by Forbiz itself, and every refusal is
// returned to the agent as Forbiz wrote it, because the refusal body carries the
// next move (for example 409 COMMITMENT_ALREADY_OPEN returns the open commitment).
//
// Credentials never travel through the conversation. A credential handed by the
// owner goes in FORBIZ_API_KEY; one obtained with forbiz_start is written to
// ~/.forbiz-mcp/credential.json. Tool results are redacted before they reach the model.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "0.1.0";
const API_BASE = (process.env.FORBIZ_API_BASE || "https://forbiz.io/api/public/agent").replace(/\/+$/, "");
// The CDN in front of Forbiz refuses generic clients; llms.txt asks for a named agent.
const USER_AGENT = `forbiz-mcp/${VERSION}`;
const CRED_DIR = process.env.FORBIZ_MCP_HOME || path.join(os.homedir(), ".forbiz-mcp");
const CRED_FILE = path.join(CRED_DIR, "credential.json");

// ---------- credential ------------------------------------------------------

let accessCache = null; // { token, expiresAt } for exchanged fbzr_ credentials

async function readStoredCredential() {
  try {
    const raw = await fs.readFile(CRED_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function storeCredential(record) {
  await fs.mkdir(CRED_DIR, { recursive: true });
  await fs.writeFile(CRED_FILE, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
}

async function baseCredential() {
  if (process.env.FORBIZ_API_KEY) return { key: process.env.FORBIZ_API_KEY.trim(), from: "FORBIZ_API_KEY" };
  const stored = await readStoredCredential();
  if (stored?.api_key) return { key: stored.api_key, from: CRED_FILE };
  return null;
}

// fbzr_ credentials are renewal credentials: exchanged at POST /identity/token for a
// short-lived bearer. Any other credential is used as the bearer directly (llms.txt).
async function bearer() {
  const cred = await baseCredential();
  if (!cred) return null;
  if (!cred.key.startsWith("fbzr_")) return cred.key;
  const now = Date.now();
  if (accessCache && accessCache.expiresAt - 60_000 > now) return accessCache.token;
  const res = await rawFetch("POST", "/identity/token", { body: {}, token: cred.key });
  if (!res.ok || !res.body?.access_token) {
    throw new ForbizError(res.status, res.body, "Could not exchange the fbzr_ credential at POST /identity/token.");
  }
  accessCache = {
    token: res.body.access_token,
    expiresAt: res.body.expires_at ? Date.parse(res.body.expires_at) : now + 50 * 60_000,
  };
  return accessCache.token;
}

// ---------- HTTP ------------------------------------------------------------

class ForbizError extends Error {
  constructor(status, body, message) {
    super(message || `Forbiz answered ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function rawFetch(method, apiPath, { query, body, token } = {}) {
  const url = new URL(API_BASE + (apiPath.startsWith("/") ? apiPath : "/" + apiPath));
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 2000) };
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function call(method, apiPath, opts = {}) {
  const token = await bearer();
  if (!token) {
    return {
      ok: false,
      status: 0,
      body: {
        error: "NO_CREDENTIAL",
        message:
          "No Forbiz credential is configured. Either the owner sets FORBIZ_API_KEY in this server's environment, " +
          "or the agent calls forbiz_start once to open a provisional workspace (no account, no email).",
      },
    };
  }
  return rawFetch(method, apiPath, { ...opts, token });
}

// ---------- redaction -------------------------------------------------------

const SECRET_KEYS = new Set(["api_key", "access_token", "refresh_token", "renewal_credential", "secret", "client_secret", "password", "key_hash"]);
const SECRET_VALUE = /^fbz[a-z]*_[A-Za-z0-9_\-]{12,}$/;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) && typeof v === "string" ? "[redacted by forbiz-mcp]" : redact(v);
    }
    return out;
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) return "[redacted by forbiz-mcp]";
  return value;
}

function result(res) {
  const payload = { status: res.status, ...(res.body && typeof res.body === "object" && !Array.isArray(res.body) ? res.body : { data: res.body }) };
  return {
    content: [{ type: "text", text: JSON.stringify(redact(payload), null, 2) }],
    isError: !res.ok,
  };
}

async function run(method, apiPath, opts) {
  try {
    return result(await call(method, apiPath, opts));
  } catch (e) {
    if (e instanceof ForbizError) return result({ ok: false, status: e.status, body: { error: e.message, detail: e.body } });
    return result({ ok: false, status: 0, body: { error: "REQUEST_FAILED", message: String(e?.message || e) } });
  }
}

const id = (v) => encodeURIComponent(v);

// ---------- server ----------------------------------------------------------

const server = new McpServer(
  { name: "forbiz", version: VERSION },
  {
    instructions:
      "Forbiz is a system of record for an AI-operated business: commitments with an expected signal, evidence, " +
      "outcomes and decisions, so any agent can pick up where the last one left off. Start with forbiz_me and forbiz_next. " +
      "Record what you observed with forbiz_add_evidence, commit with forbiz_commit (always send a commitmentKey and an " +
      "expectedSignalAt), and close the loop with forbiz_record_signal or forbiz_close. Evidence is not truth: nothing " +
      "you write becomes workspace truth until a human confirms it. When Forbiz refuses, read the refusal body: it says what to do next.",
  }
);

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const isoDate = z.string().describe("ISO 8601 date-time, e.g. 2026-10-15T14:00:00Z");
const signalSource = z
  .object({
    kind: z.enum(["email_thread", "chat", "phone_call", "site_order", "bank", "calendar", "in_person", "system", "other"]),
    detail: z.string().max(200).optional().describe("Where exactly to look, e.g. the thread subject"),
  })
  .describe("Where the expected signal will appear");
const outcome = z.enum(["expected", "partial", "unexpected", "deferred"]);

// --- start and identity

server.registerTool(
  "forbiz_start",
  {
    title: "Open a Forbiz workspace",
    description:
      "Open a provisional Forbiz workspace with no account, no email and no human (POST /bootstrap). " +
      "The credential is stored locally by this server and never shown. Returns the workspace, the trial limits and a claim link " +
      "for the owner. Call it once; if a credential already exists it refuses unless replace is true.",
    inputSchema: {
      agent_name: z.string().describe("Your name as an agent, e.g. 'Acme ops agent'"),
      workspace_name: z.string().optional().describe("Name of the business or workspace"),
      replace: z.boolean().optional().describe("Open a new workspace even if a credential is already stored"),
    },
    annotations: WRITE,
  },
  async ({ agent_name, workspace_name, replace }) => {
    const existing = await baseCredential();
    if (existing && !replace) {
      return result({
        ok: false,
        status: 0,
        body: {
          error: "CREDENTIAL_EXISTS",
          message: `A Forbiz credential is already configured (${existing.from}). Use it: call forbiz_me. Pass replace: true only to open a different workspace.`,
        },
      });
    }
    if (process.env.FORBIZ_API_KEY && replace) {
      return result({ ok: false, status: 0, body: { error: "ENV_CREDENTIAL", message: "FORBIZ_API_KEY is set in the environment and takes precedence; a new workspace would not be used." } });
    }
    try {
      const res = await rawFetch("POST", "/bootstrap", {
        body: { agent_name, workspace_name, client_name: "forbiz-mcp", client_version: VERSION, source: "mcp" },
      });
      if (res.ok && res.body?.credential?.api_key) {
        await storeCredential({
          api_key: res.body.credential.api_key,
          expires_at: res.body.credential.expires_at ?? null,
          workspace_id: res.body.workspace?.id ?? null,
          agent_id: res.body.agent?.id ?? null,
          stored_at: new Date().toISOString(),
        });
        accessCache = null;
        res.body.credential_stored_at = CRED_FILE;
      }
      return result(res);
    } catch (e) {
      return result({ ok: false, status: 0, body: { error: "REQUEST_FAILED", message: String(e?.message || e) } });
    }
  }
);

server.registerTool(
  "forbiz_me",
  {
    title: "Who am I in Forbiz",
    description: "Workspace, agent identity, capabilities, plan and limits of the current credential (GET /me). Call this first.",
    inputSchema: {},
    annotations: READ,
  },
  async () => run("GET", "/me")
);

server.registerTool(
  "forbiz_claim_link",
  {
    title: "Get the owner's claim link",
    description: "A link the human owner opens to take ownership of a provisional workspace (POST /claim-link). Give it to the owner; the agent keeps working after the claim.",
    inputSchema: {},
    annotations: WRITE,
  },
  async () => run("POST", "/claim-link", { body: {} })
);

// --- what to do now

server.registerTool(
  "forbiz_next",
  {
    title: "Next move",
    description: "The single next thing that needs attention, with its handoff (GET /next).",
    inputSchema: {},
    annotations: READ,
  },
  async () => run("GET", "/next")
);

server.registerTool(
  "forbiz_prompts",
  {
    title: "Queue of pending items",
    description: "Everything waiting, grouped (needs_decision, needs_feedback, waiting, needs_review_date), each with timing.available_commands: what you may do right now (GET /prompts).",
    inputSchema: { group: z.string().optional().describe("Only one group, e.g. needs_feedback") },
    annotations: READ,
  },
  async ({ group }) => run("GET", "/prompts", { query: { group } })
);

server.registerTool(
  "forbiz_state",
  {
    title: "Workspace state",
    description: "Overview of the workspace: queues, counts and next priorities (GET /state).",
    inputSchema: {},
    annotations: READ,
  },
  async () => run("GET", "/state")
);

server.registerTool(
  "forbiz_search",
  {
    title: "Search Forbiz",
    description: "Full-text search across actions, evidence, people, organizations, projects, outreach and decisions (GET /search). To resume a commitment by its key, use forbiz_commit with the same commitmentKey instead: the 409 returns it.",
    inputSchema: {
      q: z.string().describe("Search terms"),
      type: z.enum(["all", "people", "organizations", "actions", "projects", "outreach", "evidence", "decisions", "context"]).optional(),
    },
    annotations: READ,
  },
  async ({ q, type }) => run("GET", "/search", { query: { q, type } })
);

server.registerTool(
  "forbiz_agents",
  {
    title: "Agents of this workspace",
    description: "Every agent of this workspace with its activity and a plain track record over the actions it created: created, executed, signal recorded, outcomes, overdue (GET /agents). Counts only, no ranking.",
    inputSchema: { days: z.number().int().positive().optional().describe("Window in days, default 30") },
    annotations: READ,
  },
  async ({ days }) => run("GET", "/agents", { query: { days } })
);

// --- commitments

server.registerTool(
  "forbiz_commit",
  {
    title: "Record a commitment",
    description:
      "Record an action you will take or took, with the signal you expect back (POST /actions). Always send a commitmentKey " +
      "(a short stable id for the objective, e.g. 'acme/quote-followup') and expectedSignalAt. A second open commitment with the " +
      "same key is refused 409 COMMITMENT_ALREADY_OPEN and the body returns the open one: that is how you resume. A look-alike is " +
      "refused 409 POSSIBLE_DUPLICATE: resend with confirm_new true only if it is a different objective.",
    inputSchema: {
      description: z.string().describe("What the action is, in one sentence"),
      commitmentKey: z.string().max(120).optional().describe("Stable id of the objective this commitment serves (recommended)"),
      expectedSignal: z.string().optional().describe("What you expect to see if it worked, e.g. 'Dana replies with a date'"),
      expectedSignalAt: isoDate.optional().describe("When the expected signal should have arrived"),
      expectedSignalSource: signalSource.optional(),
      dueAt: isoDate.optional().describe("When the action itself is due; without it the action never becomes overdue"),
      verb: z.enum(["send", "call", "ask", "write", "draft", "review", "decide", "schedule"]).optional(),
      whyThisMove: z.string().optional(),
      projectId: z.string().optional().describe("UUID of an existing project in this workspace"),
      roi: z
        .object({
          cash: z.number().int().min(0).max(5).optional(),
          access: z.number().int().min(0).max(5).optional(),
          proof: z.number().int().min(0).max(5).optional(),
          narrative: z.number().int().min(0).max(5).optional(),
          relationship: z.number().int().min(0).max(5).optional(),
          learning: z.number().int().min(0).max(5).optional(),
          compliance: z.number().int().min(0).max(5).optional(),
        })
        .optional()
        .describe("What it is worth, each dimension 0-5. Optional; never inferred by Forbiz"),
      confirm_new: z.boolean().optional().describe("Override a POSSIBLE_DUPLICATE refusal"),
    },
    annotations: WRITE,
  },
  async (args) => run("POST", "/actions", { body: args })
);

server.registerTool(
  "forbiz_get_action",
  {
    title: "Read one action",
    description: "Full state of one action: expected signal, dates, lifecycle, outcome (GET /actions/{id}).",
    inputSchema: { id: z.string().describe("Action id") },
    annotations: READ,
  },
  async ({ id: actionId }) => run("GET", `/actions/${id(actionId)}`)
);

server.registerTool(
  "forbiz_action_history",
  {
    title: "History of one action",
    description: "Chronological changes of one action and who made each one, agent or human (GET /actions/{id}/history).",
    inputSchema: { id: z.string() },
    annotations: READ,
  },
  async ({ id: actionId }) => run("GET", `/actions/${id(actionId)}/history`)
);

server.registerTool(
  "forbiz_mark_executed",
  {
    title: "Mark an action as executed",
    description: "Record that the action really happened (POST /actions/{id}/execute). Only when it did: never mark as executed without evidence that the act occurred.",
    inputSchema: {
      id: z.string(),
      executedAt: isoDate.optional().describe("When it really happened; at most 5 minutes in the future"),
      expectedSignalAt: isoDate.optional(),
    },
    annotations: WRITE,
  },
  async ({ id: actionId, ...body }) => run("POST", `/actions/${id(actionId)}/execute`, { body })
);

server.registerTool(
  "forbiz_record_signal",
  {
    title: "Record the signal that came back",
    description: "Record what actually happened after the action (POST /signals). A signal is written once; a correction is a new record.",
    inputSchema: {
      actionId: z.string(),
      actualSignal: z.string().describe("What actually came back, in plain words"),
      outcomeStatus: outcome.optional(),
      learningNote: z.string().optional(),
    },
    annotations: WRITE,
  },
  async (args) => run("POST", "/signals", { body: args })
);

server.registerTool(
  "forbiz_check_signal",
  {
    title: "Record a signal check",
    description:
      "Record that you looked for the expected signal (POST /actions/{id}/signal-checks). not_found_in_source REQUIRES source and period: " +
      "it says where you looked and when, never that a third party did not answer. found closes nothing; link the signal with forbiz_record_signal. " +
      "cannot_check REQUIRES reason.",
    inputSchema: {
      id: z.string().describe("Action id"),
      result: z.enum(["found", "not_found_in_source", "cannot_check"]),
      source: z.object({ kind: z.string(), detail: z.string().optional() }).optional().describe("Where you looked, e.g. { kind: 'email_thread', detail: 'Re: quote' }"),
      period: z.object({ from: isoDate, to: isoDate }).optional().describe("The time window you checked"),
      looked_for: z.string().optional(),
      reason: z.enum(["no_access", "source_unknown", "needs_human"]).optional(),
      note: z.string().optional(),
    },
    annotations: WRITE,
  },
  async ({ id: actionId, ...body }) => run("POST", `/actions/${id(actionId)}/signal-checks`, { body })
);

server.registerTool(
  "forbiz_postpone",
  {
    title: "Move the expected signal date",
    description: "Push the date the signal is expected (POST /actions/{id}/postpone).",
    inputSchema: { id: z.string(), expectedSignalAt: isoDate, reason: z.string().optional() },
    annotations: WRITE,
  },
  async ({ id: actionId, ...body }) => run("POST", `/actions/${id(actionId)}/postpone`, { body })
);

server.registerTool(
  "forbiz_close",
  {
    title: "Close the loop",
    description: "Resolve an action with its outcome (POST /actions/{id}/close-loop).",
    inputSchema: { id: z.string(), outcomeStatus: outcome, learningNote: z.string().optional() },
    annotations: WRITE,
  },
  async ({ id: actionId, ...body }) => run("POST", `/actions/${id(actionId)}/close-loop`, { body })
);

server.registerTool(
  "forbiz_close_without_signal",
  {
    title: "Close without a signal",
    description: "Close an action that will not get a signal, saying why (POST /actions/{id}/close-without-signal). Silence is not rejection: say what you know.",
    inputSchema: { id: z.string(), reason: z.string().optional(), learningNote: z.string().optional() },
    annotations: WRITE,
  },
  async ({ id: actionId, ...body }) => run("POST", `/actions/${id(actionId)}/close-without-signal`, { body })
);

// --- evidence

const evidenceItem = z.object({
  kind: z
    .enum(["statement", "claim", "inference", "question", "unknown", "human_answer", "confirmation", "correction", "contradiction", "deliberate_exclusion", "supersession", "decision", "policy_statement", "hypothesis", "resolution"])
    .describe("Use statement + observed for something you saw"),
  epistemicStatus: z
    .enum(["claimed", "corroborated", "contradicted", "excluded", "confirmed", "observed", "sourced", "derived", "current_decision", "hypothesis", "unknown", "deliberately_unresolved", "superseded"])
    .optional(),
  subject: z.string().describe("What it is about, short and reusable, e.g. 'acme/pricing'"),
  content: z.string(),
  contradictsEvidenceId: z.string().optional().describe("Id of the evidence item this one contradicts; the original is never erased"),
  materialToDecision: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

server.registerTool(
  "forbiz_add_evidence",
  {
    title: "Record evidence",
    description: "Append what you observed, were told, inferred or decided (POST /context/evidence). Append-only epistemic history: nothing becomes workspace truth automatically, and a contradiction never erases what it contradicts.",
    inputSchema: { items: z.array(evidenceItem).min(1) },
    annotations: WRITE,
  },
  async ({ items }) => run("POST", "/context/evidence", { body: { items } })
);

server.registerTool(
  "forbiz_find_evidence",
  {
    title: "Find evidence",
    description: "Recover evidence by text or subject (GET /context/evidence). Each item carries its source and its contradiction and supersession pointers.",
    inputSchema: {
      q: z.string().optional().describe("Full text over subject and content"),
      subject: z.string().optional().describe("Subject contains this"),
      status: z.string().optional(),
      materialOnly: z.boolean().optional(),
    },
    annotations: READ,
  },
  async (args) => run("GET", "/context/evidence", { query: args })
);

// --- everything else in the contract

server.registerTool(
  "forbiz_request",
  {
    title: "Call any Forbiz route",
    description:
      "Escape hatch for any other route of the Forbiz Agent API (https://forbiz.io/openapi.json): projects, decisions, delegations, outreach, policies, export, purchases. " +
      "The path is relative to the API base, e.g. '/projects' or '/decisions/recommendation'. Forbiz enforces capabilities server-side.",
    inputSchema: {
      method: z.enum(["GET", "POST"]),
      path: z.string().describe("Route path starting with /"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.record(z.string(), z.any()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ method, path: p, query, body }) => {
    const clean = "/" + p.replace(/^\/+/, "");
    if (/^\/bootstrap\/?$/.test(clean)) {
      return result({ ok: false, status: 0, body: { error: "USE_FORBIZ_START", message: "Use forbiz_start: it stores the credential instead of returning it." } });
    }
    return run(method, clean, { query, body: method === "POST" ? body ?? {} : undefined });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
