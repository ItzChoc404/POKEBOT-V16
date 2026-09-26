import type { DiscordEmbed, DiscordMessage, DiscordThread, PokemonCard, PokemonSet, PriceChartingPrice } from "./types.js";
import type { DiscordRest } from "./discord-rest.js";
import { discordMessageUrl, truncate } from "./discord-rest.js";
import { makeCardEmbed } from "./embeds.js";
import type { StateStore } from "./state.js";

type Candidate = {
  guildId: string;
  channelId: string;
  message: DiscordMessage;
  threadName?: string;
  searchableText: string;
};

export async function locateMatches(
  rest: DiscordRest,
  state: StateStore,
  guildId: string,
  name: string,
  number: string,
): Promise<Candidate[]> {
  const channelIds = state.snapshot().locateChannels[guildId] ?? [];
  if (channelIds.length === 0) return [];
  const candidates = await scanGuild(rest, guildId, channelIds);
  const normalizedName = normalize(name);
  const normalizedNumber = normalize(number);
  return candidates.filter((candidate) => {
    if (!normalize(candidate.searchableText).includes(normalizedName)) return false;
    return normalize(candidate.searchableText).includes(normalizedNumber);
  });
}

async function scanGuild(
  rest: DiscordRest,
  guildId: string,
  requestedChannels: string[],
): Promise<Candidate[]> {
  const parents = [...new Set(requestedChannels)];
  const candidates: Candidate[] = [];
  const threadChannels = new Map<string, string>();

  for (const parentId of parents) {
    try {
      const channel = await rest.channel(parentId);
      if (channel.type === 11 || channel.type === 12) {
        threadChannels.set(channel.id, channel.name ?? "Thread");
        continue;
      }
      if (channel.type !== 15) {
        const messages = await listMessages(rest, parentId, 5);
        for (const message of messages) {
          candidates.push(makeCandidate(guildId, parentId, message));
        }
      }

      const archived = await listArchivedThreads(rest, parentId);
      for (const thread of archived) threadChannels.set(thread.id, thread.name ?? "Archived thread");
    } catch (error) {
      console.warn(`[locate] Could not read configured channel ${parentId}: ${(error as Error).message}`);
    }
  }

  try {
    const active = await rest.request<{ threads?: DiscordThread[] }>(
      `/guilds/${guildId}/threads/active`,
    );
    const parentSet = new Set(parents);
    for (const thread of active.threads ?? []) {
      if (thread.parent_id && parentSet.has(thread.parent_id)) {
        threadChannels.set(thread.id, thread.name ?? "Thread");
      }
    }
  } catch (error) {
    console.warn(`[locate] Could not list active threads: ${(error as Error).message}`);
  }

  for (const [threadId, threadName] of threadChannels) {
    try {
      const messages = await listMessages(rest, threadId, 10);
      for (const message of messages) {
        candidates.push(makeCandidate(guildId, threadId, message, threadName));
      }
    } catch (error) {
      console.warn(`[locate] Could not read thread ${threadId}: ${(error as Error).message}`);
    }
  }
  return candidates;
}

async function listMessages(
  rest: DiscordRest,
  channelId: string,
  maxPages: number,
): Promise<DiscordMessage[]> {
  const output: DiscordMessage[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const messages = await rest.request<DiscordMessage[]>(
      `/channels/${channelId}/messages?${query.toString()}`,
    );
    if (messages.length === 0) break;
    output.push(...messages);
    before = messages[messages.length - 1]?.id;
    if (messages.length < 100 || !before) break;
  }
  return output;
}

async function listArchivedThreads(rest: DiscordRest, parentId: string): Promise<DiscordThread[]> {
  const output: DiscordThread[] = [];
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    try {
      const result = await rest.request<{ threads?: DiscordThread[]; has_more?: boolean }>(
        `/channels/${parentId}/threads/archived/public?${query.toString()}`,
      );
      const threads = result.threads ?? [];
      output.push(...threads);
      if (!result.has_more || threads.length === 0) break;
      before = threads[threads.length - 1]?.thread_metadata?.archive_timestamp;
      if (!before) break;
    } catch {
      break;
    }
  }
  return output;
}

function makeCandidate(
  guildId: string,
  channelId: string,
  message: DiscordMessage,
  threadName?: string,
): Candidate {
  const embedText = (message.embeds ?? [])
    .flatMap((embed) => [
      embed.title,
      embed.description,
      embed.footer?.text,
      ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
    ])
    .filter(Boolean)
    .join("\n");
  return {
    guildId,
    channelId,
    message,
    threadName,
    searchableText: [threadName, message.content, embedText].filter(Boolean).join("\n"),
  };
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}