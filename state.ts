import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BotState } from "./types.js";

const statePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "data/pokemon-discord-bot-state.json",
);
const legacyStatePath = resolve(process.cwd(), "data/pokemon-discord-bot-state.json");

const emptyState = (): BotState => ({
  locateChannels: {},
  trackedPosts: [],
  priceHistory: {},
  postedCrossLinks: [],
  auctions: [],
  tickets: [],
  ticketConfigs: {},
  ticketPanels: {},
  auctionPages: {},
  auctionOwnerRoles: {},
  buyPageChannels: {},
  ticketLogChannels: {},
  buyListings: [],
});

export class StateStore {
  private value = emptyState();
  private saveQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    let contents: string | undefined;
    let loadedLegacyState = false;
    try {
      contents = await readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Could not read bot state: ${(error as Error).message}`);
      }
      if (legacyStatePath !== statePath) {
        try {
          contents = await readFile(legacyStatePath, "utf8");
          loadedLegacyState = true;
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new Error(`Could not read legacy bot state: ${(legacyError as Error).message}`);
          }
        }
      }
    }

    if (contents === undefined) {
      this.value = emptyState();
      await this.save();
      return;
    }

    try {
      const parsed = JSON.parse(contents) as Partial<BotState>;
      this.value = {
        locateChannels: parsed.locateChannels ?? {},
        trackedPosts: parsed.trackedPosts ?? [],
        priceHistory: parsed.priceHistory ?? {},
        postedCrossLinks: parsed.postedCrossLinks ?? [],
        auctions: parsed.auctions ?? [],
        tickets: parsed.tickets ?? [],
        ticketConfigs: parsed.ticketConfigs ?? {},
        ticketPanels: parsed.ticketPanels ?? {},
        auctionPages: parsed.auctionPages ?? {},
        auctionOwnerRoles: parsed.auctionOwnerRoles ?? {},
        buyPageChannels: parsed.buyPageChannels ?? {},
        ticketLogChannels: parsed.ticketLogChannels ?? {},
        buyListings: parsed.buyListings ?? [],
      };
    } catch (error) {
      throw new Error(`Could not parse bot state: ${(error as Error).message}`);
    }
    if (loadedLegacyState) await this.save();
  }

  snapshot(): BotState {
    return structuredClone(this.value);
  }

  async save(): Promise<void> {
    const contents = JSON.stringify(this.value, null, 2);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(statePath), { recursive: true });
        const temporaryPath = `${statePath}.tmp`;
        await writeFile(temporaryPath, contents, "utf8");
        await rename(temporaryPath, statePath);
      });
    await this.saveQueue;
  }

  async addLocateChannel(guildId: string, channelId: string): Promise<boolean> {
    const channels = (this.value.locateChannels[guildId] ??= []);
    if (channels.includes(channelId)) return false;
    channels.push(channelId);
    await this.save();
    return true;
  }

  async removeLocateChannel(guildId: string, channelId: string): Promise<boolean> {
    const channels = this.value.locateChannels[guildId] ?? [];
    const next = channels.filter((id) => id !== channelId);
    if (next.length === channels.length) return false;
    this.value.locateChannels[guildId] = next;
    await this.save();
    return true;
  }

  async addTrackedPosts(posts: BotState["trackedPosts"]): Promise<void> {
    this.value.trackedPosts.push(...posts);
    await this.save();
  }

  async addAuction(auction: BotState["auctions"][number]): Promise<void> {
    this.value.auctions.push(auction);
    await this.save();
  }

  async updateAuction(id: string, update: Partial<BotState["auctions"][number]>): Promise<boolean> {
    const auction = this.value.auctions.find((item) => item.id === id);
    if (!auction) return false;
    Object.assign(auction, update);
    await this.save();
    return true;
  }

  async addTicket(ticket: BotState["tickets"][number]): Promise<void> {
    this.value.tickets.push(ticket);
    await this.save();
  }

  async setTicketConfig(guildId: string, config: BotState["ticketConfigs"][string]): Promise<void> {
    this.value.ticketConfigs[guildId] = config;
    await this.save();
  }

  async addTicketPanel(panel: BotState["ticketPanels"][string][number]): Promise<void> {
    (this.value.ticketPanels[panel.guildId] ??= []).push(panel);
    await this.save();
  }

  async updateTicketPanel(
    guildId: string,
    panelId: string,
    update: Partial<BotState["ticketPanels"][string][number]>,
  ): Promise<boolean> {
    const panel = (this.value.ticketPanels[guildId] ?? []).find((item) => item.id === panelId);
    if (!panel) return false;
    Object.assign(panel, update);
    await this.save();
    return true;
  }

  async setTicketLogChannel(guildId: string, channelId: string): Promise<void> {
    this.value.ticketLogChannels[guildId] = channelId;
    await this.save();
  }

  async setAuctionPageChannels(guildId: string, channels: string[]): Promise<void> {
    this.value.auctionPages[guildId] = [...new Set(channels)];
    await this.save();
  }

  async setAuctionOwnerRole(guildId: string, roleId: string | undefined): Promise<void> {
    if (roleId) this.value.auctionOwnerRoles[guildId] = roleId;
    else delete this.value.auctionOwnerRoles[guildId];
    await this.save();
  }

  async setBuyPageChannels(guildId: string, channels: string[]): Promise<void> {
    this.value.buyPageChannels[guildId] = [...new Set(channels)];
    await this.save();
  }

  async addBuyListing(listing: BotState["buyListings"][number]): Promise<void> {
    this.value.buyListings.push(listing);
    await this.save();
  }

  async updateBuyListing(id: string, update: Partial<BotState["buyListings"][number]>): Promise<boolean> {
    const listing = this.value.buyListings.find((item) => item.id === id);
    if (!listing) return false;
    Object.assign(listing, update);
    await this.save();
    return true;
  }

  async updateTicket(id: string, update: Partial<BotState["tickets"][number]>): Promise<boolean> {
    const ticket = this.value.tickets.find((item) => item.id === id);
    if (!ticket) return false;
    Object.assign(ticket, update);
    await this.save();
    return true;
  }

  async recordPriceLookups(
    lookups: Array<{ messageId: string; attemptedAt: number; productId?: string }>,
  ): Promise<void> {
    const trackedByMessage = new Map(
      this.value.trackedPosts.map((tracked) => [tracked.messageId, tracked]),
    );
    for (const lookup of lookups) {
      const tracked = trackedByMessage.get(lookup.messageId);
      if (!tracked) continue;
      tracked.lastPriceLookupAt = lookup.attemptedAt;
      if (lookup.productId) tracked.priceProductId = lookup.productId;
    }
    await this.save();
  }

  async recordSnapshot(productId: string, snapshot: BotState["priceHistory"][string][number]): Promise<void> {
    const rows = (this.value.priceHistory[productId] ??= []);
    rows.push(snapshot);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.value.priceHistory[productId] = rows.filter((row) => row.at >= cutoff);
    await this.save();
  }

  hasCrossLink(key: string): boolean {
    return this.value.postedCrossLinks.includes(key);
  }

  async markCrossLink(key: string): Promise<void> {
    this.value.postedCrossLinks.push(key);
    if (this.value.postedCrossLinks.length > 20_000) {
      this.value.postedCrossLinks.splice(0, this.value.postedCrossLinks.length - 20_000);
    }
    await this.save();
  }
}