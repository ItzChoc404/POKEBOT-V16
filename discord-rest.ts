import type { DiscordChannel } from "./types.js";

const API_ROOT = "https://discord.com/api/v10";

export class DiscordRest {
  constructor(private readonly token: string) {}

  async request<T = unknown>(
    route: string,
    options: { method?: string; body?: unknown; authorization?: string } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    let attempts = 0;
    while (true) {
      const response = await fetch(`${API_ROOT}${route}`, {
        method,
        headers: {
          authorization: options.authorization ?? `Bot ${this.token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempts < 8) {
        const body = (await response.json()) as { retry_after?: number };
        attempts++;
        await delay(Math.max(500, Math.ceil((body.retry_after ?? 1) * 1000)));
        continue;
      }
      if (response.status >= 500 && attempts < 4) {
        attempts++;
        await delay(500 * 2 ** attempts);
        continue;
      }
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Discord API ${method} ${route} returned HTTP ${response.status}` +
            (body ? `: ${body.slice(0, 200)}` : ""),
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  channel(channelId: string): Promise<DiscordChannel> {
    return this.request(`/channels/${encodeURIComponent(channelId)}`);
  }

  async createMessage(channelId: string, payload: unknown): Promise<{ id: string; channel_id?: string }> {
    return this.request(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      body: payload,
    });
  }

  listMessages(channelId: string, limit = 25): Promise<Array<{
    id: string;
    channel_id: string;
    guild_id?: string;
    author?: { id: string; bot?: boolean; username?: string };
    content?: string;
  }>> {
    const query = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, limit))) });
    return this.request(`/channels/${encodeURIComponent(channelId)}/messages?${query.toString()}`);
  }


  async listActiveGuildThreads(guildId: string): Promise<Array<DiscordChannel & { parent_id?: string }>> {
    const body = await this.request<{ threads?: Array<DiscordChannel & { parent_id?: string }> }>(`/guilds/${encodeURIComponent(guildId)}/threads/active`);
    return body.threads ?? [];
  }

  async listArchivedPublicThreads(channelId: string): Promise<Array<DiscordChannel & { parent_id?: string }>> {
    const body = await this.request<{ threads?: Array<DiscordChannel & { parent_id?: string }> }>(`/channels/${encodeURIComponent(channelId)}/threads/archived/public?limit=100`);
    return body.threads ?? [];
  }

  async createGuildChannel(
    guildId: string,
    payload: unknown,
  ): Promise<{ id: string; name?: string }> {
    return this.request(`/guilds/${encodeURIComponent(guildId)}/channels`, {
      method: "POST",
      body: payload,
    });
  }

  async editChannel(channelId: string, payload: unknown): Promise<void> {
    await this.request(`/channels/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      body: payload,
    });
  }

  async editChannelPermission(channelId: string, overwriteId: string, payload: unknown): Promise<void> {
    await this.request(
      `/channels/${encodeURIComponent(channelId)}/permissions/${encodeURIComponent(overwriteId)}`,
      {
        method: "PUT",
        body: payload,
      },
    );
  }

  async createThread(
    channelId: string,
    payload: unknown,
  ): Promise<{ id: string; message?: { id: string } }> {
    return this.request(`/channels/${encodeURIComponent(channelId)}/threads`, {
      method: "POST",
      body: payload,
    });
  }

  async createFileMessage(channelId: string, filename: string, content: string, messageContent?: string): Promise<{ id: string }> {
    const form = new FormData();
    if (messageContent) form.append("payload_json", JSON.stringify({ content: messageContent, allowed_mentions: { parse: [] } }));
    else form.append("payload_json", JSON.stringify({ allowed_mentions: { parse: [] } }));
    form.append("files[0]", new Blob([content], { type: "text/plain; charset=utf-8" }), filename);
    let attempts = 0;
    while (true) {
      const response = await fetch(`${API_ROOT}/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${this.token}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempts < 8) {
        const body = await response.json() as { retry_after?: number };
        attempts++;
        await delay(Math.max(500, Math.ceil((body.retry_after ?? 1) * 1000)));
        continue;
      }
      if (!response.ok) throw new Error(`Discord file upload returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return await response.json() as { id: string };
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request(`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    });
  }

  async editMessage(channelId: string, messageId: string, payload: unknown): Promise<void> {
    await this.request(`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: payload,
    });
  }

  async respond(interactionId: string, token: string, payload: unknown): Promise<void> {
    await this.request(`/interactions/${interactionId}/${token}/callback`, {
      method: "POST",
      body: payload,
    });
  }

  async editOriginalResponse(applicationId: string, token: string, payload: unknown): Promise<void> {
    await this.request(`/webhooks/${applicationId}/${token}/messages/@original`, {
      method: "PATCH",
      body: payload,
    });
  }

  async followup(applicationId: string, token: string, payload: unknown): Promise<void> {
    await this.request(`/webhooks/${applicationId}/${token}`, {
      method: "POST",
      body: payload,
    });
  }
}

export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}