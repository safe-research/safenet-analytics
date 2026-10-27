// In-memory stand-in for the Dune API endpoints used by src/dune.ts.

import { DuneClient, type Position } from "../src/dune.ts";

type Query = {
  query_id: number;
  name: string;
  description: string;
  query_sql: string;
  owner: string;
  is_private: boolean;
  is_archived: boolean;
  version: number;
  tags: string[];
  parameters: unknown[];
};
type Viz = { id: number; query_id: number; name: string; description: string; type: string; options: Record<string, unknown> };
type Dashboard = {
  dashboard_id: number;
  name: string;
  slug: string;
  owner: string;
  is_private: boolean;
  tags: string[];
  visualization_widgets: { widget_id: number; visualization_id: number; position: Position }[];
  text_widgets: { widget_id: number; text: string; position: Position }[];
  param_widgets: unknown[];
};

export class FakeDune {
  queries = new Map<number, Query>();
  visualizations = new Map<number, Viz>();
  dashboards = new Map<number, Dashboard>();
  executions = new Map<string, { query_id?: number; polls: number; sql?: string; cancelled?: boolean }>();
  // Latest stored result per query (GET /api/v1/query/{id}/results); none means never executed.
  results = new Map<number, { state?: string; columns: string[]; rows: Record<string, unknown>[] }>();
  requests: string[] = [];
  whoami = { customer_id: "team_1", handle: "safe", api_key_id: 1, created_by: 1 };
  // How Dune treats requests for private resources: honour them, reject them (plan limit), or
  // silently create public ones.
  privacy: "ok" | "reject" | "ignore" = "ok";
  // Whether POST /api/v1/dashboards/{id}/archive exists.
  dashboardArchive = false;
  // Visualization IDs whose DELETE fails with 500, as Dune sometimes does.
  failingVisualizationDeletes = new Set<number>();
  executionCredits = 1.5;
  executionsNeverFinish = false;
  #next = 1000;
  #widget = 1;

  client(): DuneClient {
    return new DuneClient("test-key", { baseUrl: "https://dune.test", fetch: this.fetch, sleep: async () => {} });
  }

  // Simulates someone with Dune access; used to create Beta-like resources and direct edits.
  seedQuery(q: Partial<Query> & { name: string }): Query {
    const query: Query = {
      query_id: this.#next++,
      description: "",
      query_sql: "select 1",
      owner: "safe",
      is_private: false,
      is_archived: false,
      version: 1,
      tags: [],
      parameters: [],
      ...q,
    };
    this.queries.set(query.query_id, query);
    return query;
  }

  seedVisualization(v: Omit<Viz, "id">): Viz {
    const viz = { id: this.#next++, ...v };
    this.visualizations.set(viz.id, viz);
    return viz;
  }

  seedDashboard(d: { name: string; slug: string; vizIds: number[] }): Dashboard {
    const dash: Dashboard = {
      dashboard_id: this.#next++,
      name: d.name,
      slug: d.slug,
      owner: "safe",
      is_private: false,
      tags: [],
      visualization_widgets: d.vizIds.map((id, i) => ({
        widget_id: this.#widget++,
        visualization_id: id,
        position: { row: i * 8, col: 0, size_x: 6, size_y: 8 },
      })),
      text_widgets: [],
      param_widgets: [],
    };
    this.dashboards.set(dash.dashboard_id, dash);
    return dash;
  }

  writes() {
    return this.requests.filter((r) => !r.startsWith("GET "));
  }

  #dash(d: Dashboard) {
    return { ...structuredClone(d), dashboard_url: `https://dune.com/${d.owner}/${d.slug}` };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    this.requests.push(`${method} ${path}`);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const notFound = () => json(404, { error: "not found" });
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/api/whoami") return json(200, this.whoami);

    // Paginated like Dune (limit, offset). Returning everything on every page would make the
    // client page forever once there are 100 or more queries.
    if (method === "GET" && path === "/api/v1/queries") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json(200, {
        queries: [...this.queries.values()]
          .filter((q) => !q.is_archived)
          .slice(offset, offset + limit)
          .map((q) => ({ id: q.query_id, name: q.name, tags: q.tags })),
      });
    }
    if (method === "POST" && path === "/api/v1/query") {
      if (body.is_private && this.privacy === "reject") return json(402, { error: "private queries limit reached" });
      const q = this.seedQuery({ ...body, is_private: this.privacy === "ignore" ? false : (body.is_private ?? false) });
      return json(200, { query_id: q.query_id });
    }
    if ((m = path.match(/^\/api\/v1\/query\/(\d+)$/))) {
      const q = this.queries.get(Number(m[1]));
      if (!q) return notFound();
      if (method === "GET") return json(200, q);
      if (method === "PATCH") {
        Object.assign(q, body, { version: q.version + 1 });
        return json(200, { query_id: q.query_id });
      }
    }
    if ((m = path.match(/^\/api\/v1\/query\/(\d+)\/(private|unprivate|archive|unarchive)$/)) && method === "POST") {
      const q = this.queries.get(Number(m[1]));
      if (!q) return notFound();
      if (m[2] === "private" && this.privacy === "reject") return json(402, { error: "private queries limit reached" });
      if (m[2] === "private" && this.privacy === "ok") q.is_private = true;
      if (m[2] === "unprivate") q.is_private = false;
      if (m[2] === "archive") q.is_archived = true;
      if (m[2] === "unarchive") q.is_archived = false;
      return json(200, { query_id: q.query_id });
    }

    if ((m = path.match(/^\/api\/v1\/queries\/(\d+)\/visualizations$/))) {
      const queryId = Number(m[1]);
      if (method === "GET")
        return json(200, { results: [...this.visualizations.values()].filter((v) => v.query_id === queryId) });
      if (method === "POST") {
        // Dune fills in defaults; the deployer must not treat them as edits.
        const viz = this.seedVisualization({ ...body, query_id: queryId, options: { ...body.options, numberFormat: "0,0" } });
        return json(200, { id: viz.id });
      }
    }
    if ((m = path.match(/^\/api\/v1\/visualizations\/(\d+)$/))) {
      const v = this.visualizations.get(Number(m[1]));
      if (!v) return notFound();
      if (method === "GET") return json(200, v);
      if (method === "PUT") {
        Object.assign(v, body, { options: { ...body.options, numberFormat: "0,0" } });
        return json(200, { id: v.id });
      }
      if (method === "DELETE") {
        if (this.failingVisualizationDeletes.has(v.id)) return json(500, { error: "An internal error occurred" });
        this.visualizations.delete(v.id);
        return json(200, { ok: true });
      }
    }

    if (method === "POST" && path === "/api/v1/dashboards") {
      if (body.is_private && this.privacy === "reject") return json(402, { error: "private dashboards limit reached" });
      const d = this.seedDashboard({ name: body.name, slug: body.name.toLowerCase().replace(/\W+/g, "-"), vizIds: [] });
      d.is_private = this.privacy === "ignore" ? false : (body.is_private ?? false);
      return json(200, this.#dash(d));
    }
    if ((m = path.match(/^\/api\/v1\/dashboards\/(\d+)\/archive$/)) && method === "POST") {
      if (!this.dashboardArchive) return notFound();
      this.dashboards.delete(Number(m[1]));
      return json(200, { ok: true });
    }
    if ((m = path.match(/^\/api\/v1\/dashboards\/by-slug\/([^/]+)\/([^/]+)$/))) {
      const d = [...this.dashboards.values()].find((x) => x.owner === m![1] && x.slug === m![2]);
      return d ? json(200, this.#dash(d)) : notFound();
    }
    if ((m = path.match(/^\/api\/v1\/dashboards\/(\d+)$/))) {
      const d = this.dashboards.get(Number(m[1]));
      if (!d) return notFound();
      if (method === "GET") return json(200, this.#dash(d));
      if (method === "PATCH") {
        for (const k of ["name", "slug", "is_private", "tags"] as const) if (body[k] !== undefined) Object.assign(d, { [k]: body[k] });
        if (body.is_private && this.privacy !== "ok") d.is_private = false;
        if (body.visualization_widgets)
          d.visualization_widgets = body.visualization_widgets.map((w: { visualization_id: number; position: Position }) => ({
            widget_id: this.#widget++,
            ...w,
          }));
        if (body.text_widgets)
          d.text_widgets = body.text_widgets.map((w: { text: string; position: Position }) => ({ widget_id: this.#widget++, ...w }));
        return json(200, this.#dash(d));
      }
    }

    if ((m = path.match(/^\/api\/v1\/query\/(\d+)\/results/)) && method === "GET") {
      const r = this.results.get(Number(m[1]));
      if (!r) return json(404, { error: "No execution found for the latest version of the query" });
      return json(200, {
        execution_id: `01RESULT${m[1]}`,
        state: r.state ?? "QUERY_STATE_COMPLETED",
        result: { rows: r.rows, metadata: { column_names: r.columns } },
      });
    }
    if ((m = path.match(/^\/api\/v1\/query\/(\d+)\/execute$/)) && method === "POST") {
      const id = `01EXEC${this.#next++}`;
      this.executions.set(id, { query_id: Number(m[1]), polls: 0 });
      return json(200, { execution_id: id, state: "QUERY_STATE_PENDING" });
    }
    if (method === "POST" && path === "/api/v1/sql/execute") {
      const id = `01EXEC${this.#next++}`;
      this.executions.set(id, { polls: 0, sql: body.sql });
      return json(200, { execution_id: id, state: "QUERY_STATE_PENDING" });
    }
    if ((m = path.match(/^\/api\/v1\/execution\/([^/]+)\/status$/))) {
      const e = this.executions.get(m[1]);
      if (!e) return notFound();
      e.polls++;
      const done = !this.executionsNeverFinish && e.polls > 1;
      return json(200, {
        execution_id: m[1],
        state: e.cancelled ? "QUERY_STATE_CANCELED" : done ? "QUERY_STATE_COMPLETED" : "QUERY_STATE_EXECUTING",
        is_execution_finished: done || e.cancelled,
        execution_cost_credits: done ? this.executionCredits : undefined,
      });
    }
    if ((m = path.match(/^\/api\/v1\/execution\/([^/]+)\/cancel$/)) && method === "POST") {
      const e = this.executions.get(m[1]);
      if (!e) return notFound();
      e.cancelled = true;
      return json(200, { success: true });
    }
    return json(400, { error: `fake Dune does not implement ${method} ${path}` });
  };
}
