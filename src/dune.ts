// Minimal client for the Dune API. Endpoints and payloads follow the official Dune CLI
// (github.com/duneanalytics/cli v0.1.18) and its client duneapi-client-go v0.5.0; queries,
// execution and whoami are also documented at https://docs.dune.com/api-reference.

export type Position = { row: number; col: number; size_x: number; size_y: number };

export type QueryParameter = Record<string, unknown> & { key: string; type: string };

export type RemoteQuery = {
  query_id: number;
  name: string;
  description?: string | null;
  query_sql: string;
  owner?: string;
  is_private: boolean;
  is_archived: boolean;
  version?: number;
  tags?: string[] | null;
  parameters?: QueryParameter[] | null;
};

export type QueryWrite = {
  name: string;
  description: string;
  query_sql: string;
  tags: string[];
  parameters: QueryParameter[];
  is_private?: boolean;
};

export type RemoteVisualization = {
  id: number;
  query_id: number;
  name: string;
  description?: string | null;
  type: string;
  options: Record<string, unknown>;
};

export type VisualizationWrite = {
  name: string;
  type: string;
  description: string;
  options: Record<string, unknown>;
};

export type RemoteDashboard = {
  dashboard_id: number;
  name: string;
  slug: string;
  is_private: boolean;
  tags?: string[] | null;
  dashboard_url: string;
  visualization_widgets?: { widget_id: number; visualization_id: number; position?: Position }[] | null;
  text_widgets?: { widget_id: number; text: string; position?: Position }[] | null;
  param_widgets?: { widget_id: string; key: string; query_id: number; position?: Position }[] | null;
};

export type DashboardWrite = {
  name?: string;
  slug?: string;
  is_private?: boolean;
  tags?: string[];
  visualization_widgets?: { visualization_id: number; position: Position }[];
  text_widgets?: { text: string; position: Position }[];
};

export type Whoami = { customer_id: string; handle: string; api_key_id?: number; created_by?: number };

export type ExecutionState =
  | "QUERY_STATE_PENDING"
  | "QUERY_STATE_EXECUTING"
  | "QUERY_STATE_COMPLETED"
  | "QUERY_STATE_FAILED"
  | "QUERY_STATE_CANCELED"
  | "QUERY_STATE_EXPIRED"
  | "QUERY_STATE_COMPLETED_PARTIAL";

export type ExecutionStatus = {
  execution_id: string;
  state: ExecutionState;
  is_execution_finished?: boolean;
  execution_ended_at?: string;
  execution_cost_credits?: number;
  error?: { message?: string; type?: string };
};

export type Performance = "medium" | "large";

export class DuneApiError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`Dune API ${method} ${path} failed with ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

type Options = { baseUrl?: string; fetch?: typeof fetch; retries?: number; sleep?: (ms: number) => Promise<void> };

export class DuneClient {
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #retries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  // Every write made through this client, for dry-run assertions and logs.
  readonly writes: string[] = [];

  constructor(apiKey: string, options: Options = {}) {
    if (!apiKey) throw new Error("DUNE_API_KEY is not set");
    this.#key = apiKey;
    this.#base = options.baseUrl ?? process.env.DUNE_API_HOST ?? "https://api.dune.com";
    this.#fetch = options.fetch ?? fetch;
    this.#retries = options.retries ?? 4;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (method !== "GET") this.writes.push(`${method} ${path}`);
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { "X-DUNE-API-KEY": this.#key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.#retries) throw new DuneApiError(method, path, res.status, text);
      const retryAfter = Number(res.headers.get("retry-after"));
      await this.#sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
  }

  async #getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.#request<T>("GET", path);
    } catch (e) {
      if (e instanceof DuneApiError && e.status === 404) return null;
      throw e;
    }
  }

  // Identity of the API key (undocumented on docs.dune.com; used by `dune whoami`).
  whoami() {
    return this.#request<Whoami>("GET", "/api/whoami");
  }

  // Queries

  getQuery(id: number) {
    return this.#getOrNull<RemoteQuery>(`/api/v1/query/${id}`);
  }

  async listQueries(): Promise<{ id: number; name: string; tags?: string[] | null }[]> {
    const all = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.#request<{ queries: { id: number; name: string; tags?: string[] | null }[] }>(
        "GET",
        `/api/v1/queries?limit=100&offset=${offset}`,
      );
      all.push(...(page.queries ?? []));
      if ((page.queries ?? []).length < 100) return all;
    }
  }

  async createQuery(q: QueryWrite): Promise<number> {
    const res = await this.#request<{ query_id: number }>("POST", "/api/v1/query", { ...q, is_temp: false });
    return res.query_id;
  }

  async updateQuery(id: number, q: QueryWrite): Promise<void> {
    await this.#request("PATCH", `/api/v1/query/${id}`, q);
  }

  async setQueryPrivate(id: number, isPrivate: boolean): Promise<void> {
    await this.#request("POST", `/api/v1/query/${id}/${isPrivate ? "private" : "unprivate"}`);
  }

  async archiveQuery(id: number): Promise<void> {
    await this.#request("POST", `/api/v1/query/${id}/archive`);
  }

  async unarchiveQuery(id: number): Promise<void> {
    await this.#request("POST", `/api/v1/query/${id}/unarchive`);
  }

  // Visualizations

  getVisualization(id: number) {
    return this.#getOrNull<RemoteVisualization>(`/api/v1/visualizations/${id}`);
  }

  async listVisualizations(queryId: number): Promise<{ id: number; name: string; type: string }[]> {
    const res = await this.#request<{ results?: { id: number; name: string; type: string }[] | null }>(
      "GET",
      `/api/v1/queries/${queryId}/visualizations?limit=100&offset=0`,
    );
    return res.results ?? [];
  }

  async createVisualization(queryId: number, v: VisualizationWrite): Promise<number> {
    const res = await this.#request<{ id: number }>("POST", `/api/v1/queries/${queryId}/visualizations`, {
      query_id: queryId,
      ...v,
    });
    return res.id;
  }

  // Full replace of name, type, description and options.
  async updateVisualization(id: number, v: VisualizationWrite): Promise<void> {
    await this.#request("PUT", `/api/v1/visualizations/${id}`, v);
  }

  async deleteVisualization(id: number): Promise<void> {
    await this.#request("DELETE", `/api/v1/visualizations/${id}`);
  }

  // Dashboards

  getDashboard(id: number) {
    return this.#getOrNull<RemoteDashboard>(`/api/v1/dashboards/${id}`);
  }

  getDashboardBySlug(owner: string, slug: string) {
    return this.#getOrNull<RemoteDashboard>(
      `/api/v1/dashboards/by-slug/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
    );
  }

  createDashboard(d: { name: string; is_private: boolean }) {
    return this.#request<RemoteDashboard>("POST", "/api/v1/dashboards", d);
  }

  // Each widget array sent replaces all existing widgets of that kind.
  updateDashboard(id: number, d: DashboardWrite) {
    return this.#request<RemoteDashboard>("PATCH", `/api/v1/dashboards/${id}`, d);
  }

  // Execution

  async execute(queryId: number, performance: Performance): Promise<string> {
    const res = await this.#request<{ execution_id: string }>(
      "POST",
      `/api/v1/query/${queryId}/execute?performance=${performance}`,
      { performance },
    );
    return res.execution_id;
  }

  async executeSql(sql: string, performance: Performance): Promise<string> {
    const res = await this.#request<{ execution_id: string }>("POST", "/api/v1/sql/execute", { sql, performance });
    return res.execution_id;
  }

  executionStatus(executionId: string) {
    return this.#request<ExecutionStatus>("GET", `/api/v1/execution/${executionId}/status`);
  }

  executionResults(executionId: string, limit = 1000) {
    return this.#request<ResultsResponse>("GET", `/api/v1/execution/${executionId}/results?limit=${limit}`).then(
      flattenResults,
    );
  }

  // Latest stored result of a saved query; does not execute it.
  latestResults(queryId: number, limit = 10000) {
    return this.#request<ResultsResponse>("GET", `/api/v1/query/${queryId}/results?limit=${limit}`).then(
      flattenResults,
    );
  }

  async waitForExecution(executionId: string, timeoutMs: number, pollMs = 5000): Promise<ExecutionStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.executionStatus(executionId);
      if (status.is_execution_finished || !["QUERY_STATE_PENDING", "QUERY_STATE_EXECUTING"].includes(status.state))
        return status;
      if (Date.now() > deadline) throw new Error(`execution ${executionId} still ${status.state} after ${timeoutMs} ms`);
      await this.#sleep(pollMs);
    }
  }
}

type ResultsResponse = {
  execution_id: string;
  state: ExecutionState;
  execution_ended_at?: string;
  result?: { rows: Record<string, unknown>[]; metadata?: { column_names?: string[] } };
};

function flattenResults(r: ResultsResponse) {
  return {
    execution_id: r.execution_id,
    state: r.state,
    execution_ended_at: r.execution_ended_at,
    columns: r.result?.metadata?.column_names ?? [],
    rows: r.result?.rows ?? [],
  };
}
