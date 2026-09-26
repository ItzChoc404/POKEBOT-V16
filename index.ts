import { BotCommands } from "./commands.js";
import { DiscordRest } from "./discord-rest.js";
import { DiscordGateway } from "./gateway.js";
import { makeCardEmbed } from "./embeds.js";
import { PriceChartingClient } from "./pricecharting.js";
import { StateStore } from "./state.js";
import { TCGdexClient } from "./tcgdex.js";
import type { PokemonSet, PriceChartingPrice } from "./types.js";

const token = process.env.DISCORD_BOT_TOKEN;
const BOT_INVITE_PERMISSIONS = "309237816336";

if (!token) {
  console.error(
    "DISCORD_BOT_TOKEN is missing. Add it as a Replit Secret, then start the Pokémon Discord Bot workflow.",
  );
  process.exitCode = 1;
} else {
  await runBot(token);
}

async function runBot(botToken: string): Promise<void> {
  const rest = new DiscordRest(botToken);
  const state = new StateStore();
  const catalog = new TCGdexClient();
  const market = new PriceChartingClient();
  await state.load();

  if (!market.isConfigured) {
    console.warn(
      "[pricecharting] PRICECHARTING_API_TOKEN is not configured. Set publishing will work, but prices and daily updates will be unavailable.",
    );
  } else {
    console.info("[pricecharting] API token is configured.");
  }

  await Promise.all(
    (["en", "ja", "zh-cn", "zh-tw"] as const).map(async (language) => {
      try {
        const sets = await catalog.listSets(language);
        console.info(`[tcgdex] Cached ${sets.length} ${language} sets for autocomplete.`);
      } catch (error) {
        console.warn(`[tcgdex] Could not preload ${language} sets: ${(error as Error).message}`);
      }
    }),
  );

  const commands = new BotCommands(rest, catalog, state, market);
  const gateway = new DiscordGateway(botToken, rest, commands);
  const applicationId = await gateway.start();
  const inviteUrl =
    `https://discord.com/oauth2/authorize?client_id=${applicationId}` +
    `&permissions=${BOT_INVITE_PERMISSIONS}&scope=bot%20applications.commands`;
  console.info(`[setup] Bot invite link: ${inviteUrl}`);
  console.info("[setup] Configure /locateRange add after inviting the bot.");

  void commands.expireAuctions();
  const auctionTimer = setInterval(() => void commands.expireAuctions(), 60_000);
  let refreshing = false;
  const refresh = async (): Promise<void> => {
    if (refreshing || !market.isAvailable) return;
    const snapshot = state.snapshot();
    const now = Date.now();
    const recheckAfter = 7 * 24 * 60 * 60 * 1000;
    const unresolved = snapshot.trackedPosts.filter(
      (tracked) =>
        !tracked.priceProductId &&
        (!tracked.lastPriceLookupAt || now - tracked.lastPriceLookupAt >= recheckAfter),
    );
    const unresolvedBySet = new Map<string, typeof unresolved>();
    for (const tracked of unresolved) {
      const key = `${tracked.language}:${tracked.setId}`;
      const group = unresolvedBySet.get(key) ?? [];
      group.push(tracked);
      unresolvedBySet.set(key, group);
    }

    const productIds = [
      ...new Set(
        snapshot.trackedPosts
          .map((tracked) => tracked.priceProductId)
          .filter((productId): productId is string => Boolean(productId)),
      ),
    ];
    if (productIds.length === 0 && unresolvedBySet.size === 0) return;

    refreshing = true;
    try {
      const prices = await market.pricesForProducts(productIds);
      const resolvedByMessage = new Map<string, PriceChartingPrice>();
      for (const trackedGroup of unresolvedBySet.values()) {
        const first = trackedGroup[0];
        if (!first) continue;
        const set: PokemonSet = {
          id: first.setId,
          name: first.setName,
          language: first.language,
        };
        const uniqueCards = [...new Map(trackedGroup.map((tracked) => [tracked.card.id, tracked.card])).values()];
        const matches = await market.pricesForSet(set, uniqueCards);
        const lookupUpdates: Array<{ messageId: string; attemptedAt: number; productId?: string }> = [];
        for (const tracked of trackedGroup) {
          const price = matches.get(tracked.card.id);
          lookupUpdates.push({
            messageId: tracked.messageId,
            attemptedAt: now,
            ...(price ? { productId: price.productId } : {}),
          });
          if (price) resolvedByMessage.set(tracked.messageId, price);
        }
        if (market.hasVerifiedAccess) await state.recordPriceLookups(lookupUpdates);
      }

      for (const tracked of snapshot.trackedPosts) {
        const productId = tracked.priceProductId;
        const price = resolvedByMessage.get(tracked.messageId) ??
          (productId ? prices.get(productId) : undefined);
        if (!price) continue;
        const resolvedProductId = price.productId;
        const history = snapshot.priceHistory[resolvedProductId] ?? [];
        if (price.ungradedPrice !== undefined) {
          await state.recordSnapshot(resolvedProductId, {
            at: now,
            ungradedPrice: price.ungradedPrice,
          });
        }
        const set: PokemonSet = {
          id: tracked.setId,
          name: tracked.setName,
          language: tracked.language,
        };
        try {
          await rest.editMessage(tracked.channelId, tracked.messageId, {
            embeds: [makeCardEmbed(tracked.card, set, price, history)],
            allowed_mentions: { parse: [] },
          });
        } catch (error) {
          console.warn(
            `[prices] Could not update ${tracked.card.name} (${tracked.messageId}): ${(error as Error).message}`,
          );
        }
      }
      console.info(`[prices] Updated ${prices.size} PriceCharting price records.`);
    } catch (error) {
      console.error(`[prices] Daily PriceCharting refresh failed: ${(error as Error).message}`);
    } finally {
      refreshing = false;
    }
  };

  const refreshTimer = setInterval(() => void refresh(), 24 * 60 * 60 * 1000);
  void refresh();
  const stop = (): void => {
    clearInterval(refreshTimer);
    clearInterval(auctionTimer);
    gateway.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}