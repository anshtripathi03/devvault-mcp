/**
 * Typed client for the DevVault API.
 *
 * Runs on the user's machine (stdio) or on our server (http). Either way the
 * access token goes only between this process and the DevVault API — it is
 * never part of a model request.
 */

export interface ManifestEntry {
  slug_or_id: string;
  title: string;
  summary: string;
  has_rules: boolean;
}

export interface ContextPayload {
  collection: string;
  resolved_from: string | null;
  core: string;
  manifest: ManifestEntry[];
  core_tokens: number;
  note: string | null;
}

export interface RoutedCollection {
  slug: string;
  name: string;
  score: number;
  selected: boolean;
}

export interface RoutePayload {
  task: string;
  routed: RoutedCollection[];
  core: string;
  manifest: ManifestEntry[];
  note: string | null;
}

export interface SearchHit {
  container_id: string;
  title: string;
  score: number;
  content: string;
  has_rules: boolean;
  tokens: number;
}

export interface SearchPayload {
  query: string;
  collection: string | null;
  hits: SearchHit[];
  omitted: string[];
}

export interface CollectionSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  member_count: number;
}

export interface ImportAdjustment {
  container: string;
  kind: string;
  detail: string;
}

export interface ImportPayload {
  collection: { id: string; slug: string; name: string };
  root_id: string;
  containers: Array<{
    id: string;
    title: string;
    parent_id: string | null;
    depth: number;
    block_count: number;
    external_key: string | null;
  }>;
  blocks_created: number;
  adjustments: ImportAdjustment[];
}

export class DevVaultError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DevVaultError";
  }
}

export class DevVaultClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const body = await response.text();
    if (!response.ok) {
      let detail = body;
      try {
        const parsed = JSON.parse(body);
        detail = parsed.detail ?? parsed.message ?? body;
      } catch {
        /* keep the raw body */
      }
      if (response.status === 401) {
        throw new DevVaultError(
          "DevVault rejected the access token. Create a new one in Settings → Connected Agents and update DEVVAULT_TOKEN.",
          401,
        );
      }
      if (response.status === 403) {
        throw new DevVaultError(
          `This token lacks the required permission. ${detail}`,
          403,
        );
      }
      throw new DevVaultError(
        typeof detail === "string" ? detail : JSON.stringify(detail),
        response.status,
      );
    }

    return body ? (JSON.parse(body) as T) : ({} as T);
  }

  listCollections() {
    return this.request<CollectionSummary[]>("/api/v1/collections/");
  }

  context(slug: string) {
    return this.request<ContextPayload>(
      `/api/v1/context/${encodeURIComponent(slug)}`,
    );
  }

  route(task: string) {
    return this.request<RoutePayload>(
      `/api/v1/context/route?task=${encodeURIComponent(task)}`,
      { method: "POST" },
    );
  }

  search(slug: string, query: string, limit = 3) {
    return this.request<SearchPayload>(
      `/api/v1/context/${encodeURIComponent(slug)}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }

  async containerMarkdown(containerId: string, depth = 0): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/containers/${encodeURIComponent(containerId)}/export.md?depth=${depth}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok) {
      throw new DevVaultError(
        `Could not read container ${containerId} (${response.status}).`,
        response.status,
      );
    }
    return response.text();
  }

  writeRules(containerId: string, rules: string) {
    return this.request<{ updated: boolean; reason?: string }>(
      `/api/v1/containers/${encodeURIComponent(containerId)}/rules`,
      { method: "PUT", body: JSON.stringify({ rules }) },
    );
  }

  import(payload: unknown) {
    return this.request<ImportPayload>("/api/v1/containers/import", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  containerRules() {
    return this.request<Record<string, unknown>>("/api/v1/schema/container-rules");
  }
}
