import { DiscordRest, truncate } from "./discord-rest.js";
import type { StateStore } from "./state.js";
import type { PriceChartingClient } from "./pricecharting.js";
import type {
  DiscordChannel,
  PokemonCard,
  PokemonSet,
} from "./types.js";

const FORUM_CHANNEL = 15;

export class SetPublisher {
  constructor(
    private readonly rest: DiscordRest,
    private readonly state: StateStore,
    private readonly market: PriceChartingClient,
  ) {}

  async publish(
    guildId: string,
    destinationId: string,
    set: PokemonSet,
    cards: PokemonCard[],
    onProgress: (completed: number, total: number) => Promise<void>,
    options: { privateBrowseOnly?: boolean } = {},
  ): Promise<number> {
    const destination: DiscordChannel = await this.rest.channel(destinationId);
    if (destination.guild_id !== guildId || ![0, FORUM_CHANNEL].includes(destination.type)) {
      throw new Error("Choose a text or forum channel in this server.");
    }

    const payload = {
      content: `**${set.name}**${set.language !== "en" && set.englishName && set.englishName !== set.name ? ` · **English: ${set.englishName}**` : ""} · ${languageLabel(set.language)}`,
      embeds: [setSummaryEmbed(set, cards)],
      components: [setSortComponents(set)],
      allowed_mentions: { parse: [] },
    };

    const setPost = destination.type === FORUM_CHANNEL
      ? await this.rest.createThread(destinationId, {
          name: truncate(`${set.name}${set.language !== "en" && set.englishName && set.englishName !== set.name ? ` — ${set.englishName}` : ""} · ${languageLabel(set.language)}`, 100),
          auto_archive_duration: 10080,
          message: payload,
        })
      : await this.rest.createMessage(destinationId, payload);

    // Quickset forum posts should contain only the set summary and browser controls.
    // Cards are loaded only when a user chooses a sort option; that response is ephemeral.
    if (options.privateBrowseOnly && destination.type === FORUM_CHANNEL) {
      await onProgress(cards.length, cards.length);
      return setPost.id ? cards.length : 0;
    }

    // Legacy /set behaviour: post every card as its own Discord message.
    const cardChannelId = destination.type === FORUM_CHANNEL ? setPost.id : destinationId;
    if (!cardChannelId) throw new Error("Discord did not return the set post/thread ID.");

    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const displayName = card.englishName && card.englishName !== card.name
        ? `${card.name} (${card.englishName})`
        : card.name;
      const imageUrl = card.image || undefined;

      await this.rest.createMessage(cardChannelId, {
        content: `**${displayName}**`,
        embeds: [{
          title: truncate(displayName, 256),
          description: [
            `**Number:** ${card.localId}`,
            `**Rarity:** ${card.rarity ?? "Unknown"}`,
          ].join("\n"),
          ...(imageUrl ? { image: { url: imageUrl } } : {}),
          footer: { text: `${set.englishName ?? set.name} · ${card.localId}` },
        }],
        allowed_mentions: { parse: [] },
      });

      await onProgress(index + 1, cards.length);
    }

    return setPost.id ? cards.length : 0;
  }
}

function languageLabel(language: PokemonSet["language"]): string {
  if (language === "en") return "English";
  if (language === "ja") return "Japanese";
  return language === "zh-cn" ? "Chinese" : "Chinese (Traditional)";
}

function setSummaryEmbed(set: PokemonSet, cards: PokemonCard[]) {
  const total = set.cardCount?.total ?? cards.length;
  const official = set.cardCount?.official;
  return {
    title: truncate(set.name, 256),
    description: [
      ...(set.language !== "en" && set.englishName && set.englishName !== set.name ? [`**English translation:** ${set.englishName}`] : []),
      `**Language:** ${languageLabel(set.language)}`,
      set.eraName ? `**Era:** ${set.eraName}` : "",
      `**Set ID:** \`${set.id}\``,
    ].filter(Boolean).join("\n"),
    color: 0x3b82f6,
    fields: [
      { name: "Total cards", value: String(total), inline: true },
      ...(official !== undefined ? [{ name: "Official cards", value: String(official), inline: true }] : []),
      { name: "Loaded cards", value: String(cards.length), inline: true },
      { name: "How to browse", value: "Use the dropdown below to view every card privately, sorted by name, number, or rarity." },
    ],
    ...(set.image ? { image: { url: set.image } } : {}),
    footer: { text: `TCGdex set summary${set.englishName && set.englishName !== set.name ? ` • English: ${set.englishName}` : ""}` },
  };
}

function setSortComponents(set: PokemonSet) {
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: `set-sort|${set.language}|${set.id}`,
      placeholder: "Sort and view all cards",
      options: [
        { label: "Name · Ascending (A–Z)", value: "name-asc", description: "Card names from A to Z" },
        { label: "Name · Descending (Z–A)", value: "name-desc", description: "Card names from Z to A" },
        { label: "Number · Ascending", value: "number-asc", description: "Lowest card number first" },
        { label: "Number · Descending", value: "number-desc", description: "Highest card number first" },
        { label: "Rarity · Ascending", value: "rarity-asc", description: "Rarity from lowest to highest" },
        { label: "Rarity · Descending", value: "rarity-desc", description: "Rarity from highest to lowest" },
      ],
    }],
  };
}