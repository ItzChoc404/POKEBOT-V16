import { randomUUID } from "node:crypto";
import { DiscordRest, discordMessageUrl, truncate } from "./discord-rest.js";
import { locateMatches } from "./locate.js";
import { SetPublisher } from "./publisher.js";
import type { PriceChartingClient } from "./pricecharting.js";
import type { StateStore } from "./state.js";
import { parseSetChoice, TCGdexClient } from "./tcgdex.js";
import type {
  Auction,
  DiscordChannel,
  DiscordInteraction,
  DiscordEmbed,
  DiscordMessage,
  LanguageCode,
  PokemonSet,
  Ticket,
} from "./types.js";

const LANGUAGES: LanguageCode[] = ["en", "ja", "zh-cn", "zh-tw"];
const DESTINATION_CHANNEL_TYPES = [15];
const AUCTION_PAGE_CHANNEL_TYPES = [15];
const LOCATE_CHANNEL_TYPES = [15];
const EPHEMERAL = 64;
const VIEW_CHANNEL = 1024;
const SEND_MESSAGES = 2048;
const READ_MESSAGE_HISTORY = 65536;
const EMBED_LINKS = 16384;
const MANAGE_CHANNELS = 16;
const TICKET_MEMBER_PERMISSIONS = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | EMBED_LINKS;
const TICKET_BOT_PERMISSIONS = TICKET_MEMBER_PERMISSIONS | MANAGE_CHANNELS;
function quicksetLanguageLabel(language: LanguageCode): string {
  if (language === "en") return "English";
  if (language === "ja") return "Japanese";
  return language === "zh-cn" ? "Chinese (Simplified)" : "Chinese (Traditional)";
}

const SET_LABEL_OVERRIDES: Record<string, string> = {
  "ja:sv10": "Destined Rivals",
  "zh-cn:sv10": "Destined Rivals",
  "zh-tw:sv10": "Destined Rivals",
};

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

type TicketSetupDraft = {
  guildId: string;
  userId: string;
  categoryId?: string;
  panelChannelId?: string;
  staffRoleId?: string;
  pingRoleIds: string[];
  name: string;
  description: string;
};

export class BotCommands {
  private readonly publisher: SetPublisher;
  private readonly ticketSetupDrafts = new Map<string, TicketSetupDraft>();
  private readonly forumProcessing = new Set<string>();

  constructor(
    private readonly rest: DiscordRest,
    private readonly catalog: TCGdexClient,
    private readonly state: StateStore,
    market: PriceChartingClient,
  ) {
    this.publisher = new SetPublisher(rest, state, market);
  }

  async handle(interaction: DiscordInteraction): Promise<void> {
    if (interaction.type === 4) {
      await this.handleAutocomplete(interaction);
      return;
    }
    if (interaction.type === 3) {
      await this.handleComponent(interaction);
      return;
    }
    if (interaction.type === 5) {
      await this.handleModal(interaction);
      return;
    }
    if (interaction.type !== 2 || !interaction.data?.name) return;

    try {
      if (interaction.data.name === "set") {
        await this.handleSet(interaction);
      } else if (interaction.data.name === "quickset") {
        await this.handleQuickset(interaction);
      } else if (interaction.data.name === "locate") {
        await this.handleLocate(interaction);
      } else if (interaction.data.name === "locaterange") {
        await this.handleLocateRange(interaction);
      } else if (interaction.data.name === "locateadd") {
        await this.handleLocateAdd(interaction);
      } else if (interaction.data.name === "auctionpage") {
        await this.handleAuctionPage(interaction);
      } else if (interaction.data.name === "buypagelocate") {
        await this.handleBuyPageLocate(interaction);
      } else if (interaction.data.name === "buy") {
        await this.handleBuyCommand(interaction);
      } else if (interaction.data.name === "ticket") {
        await this.handleTicketCommand(interaction);
      } else if (interaction.data.name === "tlog") {
        await this.handleTlog(interaction);
      } else if (interaction.data.name === "auction") {
        await this.handleAuctionCommand(interaction);
      } else {
        await this.reply(interaction, `Unknown command: ${interaction.data.name}`);
      }
    } catch (error) {
      console.error(`[commands] ${interaction.data.name} failed: ${(error as Error).message}`);
      await this.reply(interaction, `Could not complete the command: ${(error as Error).message}`);
    }
  }

  async handleMessage(message: DiscordMessage): Promise<void> {
    if (!message.guild_id || !message.channel_id || message.author?.bot) return;
    const channel = await this.rest.channel(message.channel_id);
    if (channel.type !== 11 && channel.type !== 12) return;
    const parentId = channel.parent_id;
    if (!parentId) return;
    const snapshot = this.state.snapshot();
    // Forum starter messages are normally accompanied by THREAD_CREATE. Keep
    // MESSAGE_CREATE as a fallback for gateways/configurations that deliver the
    // starter message first.
    if (message.id === channel.id) {
      await this.processForumPost(message.guild_id, channel, message);
    } else if ((snapshot.buyPageChannels[message.guild_id] ?? []).includes(parentId)) {
      await this.createBuyListing(message.guild_id, parentId, channel, message);
    }
  }

  async handleThreadCreate(thread: DiscordChannel & { guild_id?: string; parent_id?: string }): Promise<void> {
    if (!thread.guild_id || !thread.parent_id || (thread.type !== 11 && thread.type !== 12)) return;
    await this.processForumPost(thread.guild_id, thread, undefined);
  }

  private async processForumPost(
    guildId: string,
    thread: DiscordChannel & { parent_id?: string },
    starterMessage?: DiscordMessage,
  ): Promise<void> {
    const parentId = thread.parent_id;
    if (!parentId) return;
    const snapshot = this.state.snapshot();
    const isAuction = (snapshot.auctionPages[guildId] ?? []).includes(parentId);
    const isBuy = (snapshot.buyPageChannels[guildId] ?? []).includes(parentId);
    if (!isAuction && !isBuy) return;

    const processingKey = `${guildId}:${thread.id}`;
    if (this.forumProcessing.has(processingKey)) return;
    this.forumProcessing.add(processingKey);
    try {
      let source = starterMessage;
      if (!source) {
        source = await this.getForumStarterMessageWithRetry(thread.id);
      }
      if (!source) {
        try {
          await this.rest.createMessage(thread.id, { content: "⚠️ PokeMarket could not read the original forum post after several attempts. Please check the bot permissions: View Channel, View Threads, Send Messages and Read Message History." });
        } catch {}
        return;
      }

      if (isAuction) {
      try {
        await this.createAuctionFromMessage(guildId, thread.id, source, thread.name);
      } catch (error) {
        console.error(`[auction] Could not process new forum post ${thread.id}: ${(error as Error).message}`);
        try {
          await this.rest.createMessage(thread.id, { content: `⚠️ PokeMarket could not create the auction from this post: ${(error as Error).message.slice(0, 500)}` });
        } catch {}
      }
    }
      if (isBuy) {
        try {
          await this.createBuyListing(guildId, parentId, thread, source);
        } catch (error) {
          console.error(`[buy] Could not process new forum post ${thread.id}: ${(error as Error).message}`);
          try {
            await this.rest.createMessage(thread.id, { content: `⚠️ PokeMarket could not create the buy listing buttons: ${(error as Error).message.slice(0, 500)}` });
          } catch {}
        }
      }
    } finally {
      this.forumProcessing.delete(processingKey);
    }
  }

  private async getForumStarterMessageWithRetry(threadId: string): Promise<DiscordMessage | undefined> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const messages = await this.rest.listMessages(threadId, 20);
        const starter = messages.find((message) => message.id === threadId) ?? messages[0];
        if (starter) return starter as DiscordMessage;
      } catch (error) {
        console.warn(`[forum] Could not read starter message for ${threadId} (attempt ${attempt + 1}): ${(error as Error).message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    return undefined;
  }

  private async handleTicketCommand(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id) {
      await this.reply(interaction, "Use `/ticket` inside a server.");
      return;
    }
    const subcommand = interaction.data?.options?.[0]?.name;
    if (subcommand === "setup") {
      if (!isManager(interaction)) {
        await this.reply(interaction, "Only server managers can configure tickets.");
        return;
      }
      const userId = actorId(interaction);
      if (!userId) {
        await this.reply(interaction, "Could not identify your Discord account.");
        return;
      }
      this.ticketSetupDrafts.set(`${interaction.guild_id}:${userId}`, {
        guildId: interaction.guild_id,
        userId,
        pingRoleIds: [],
        name: "PokeMarket Tickets",
        description: "Open a private ticket for support, purchases, negotiations, or other marketplace help.",
      });
      await this.showModal(interaction, {
        custom_id: "ticket-setup-details-modal",
        title: "Ticket Panel Details",
        components: [
          textInput("ticket-setup-name", "Ticket panel name", 1, 100),
          textInput("ticket-setup-description", "Ticket panel description", 2, 1_000),
        ],
      });
      return;
    }
    if (subcommand === "mediator" || subcommand === "dispute") {
      const roleId = nestedOptionValue(interaction, "role");
      if (!roleId || !isSnowflake(roleId)) {
        await this.reply(interaction, "Choose a valid role.");
        return;
      }
      const roleLabel = subcommand === "mediator" ? "mediator" : "dispute";
      const current = this.state.snapshot().ticketConfigs[interaction.guild_id] ?? {
        categoryId: "",
        categories: ["Support", "Negotiation", "Auction purchase"],
        staffRoleIds: [],
      };
      await this.state.setTicketConfig(interaction.guild_id, {
        ...current,
        ...(subcommand === "mediator" ? { middlemanRoleId: roleId } : { disputeRoleId: roleId }),
      });
      await this.reply(interaction, `Ticket ${roleLabel} role set to <@&${roleId}>.`);
      return;
    }
    if (subcommand !== "open") {
      await this.reply(interaction, "Choose `/ticket setup`, `/ticket mediator`, `/ticket dispute`, or `/ticket open`.");
      return;
    }
    await this.showModal(interaction, {
      custom_id: "ticket-open-modal",
      title: "Open a private ticket",
      components: [
        textInput("ticket-subject", "Subject", 1, 100),
        textInput("ticket-category", "Category", 1, 50),
        textInput("ticket-item", "Item or order reference", 1, 100),
        textInput("ticket-details", "Tell us what you need", 2, 1_000),
      ],
    });
  }

  private async handleTlog(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id || !isManager(interaction)) {
      await this.reply(interaction, "Only server managers can configure the ticket log.");
      return;
    }
    const channelId = optionValue(interaction, "channel");
    if (!channelId) {
      await this.reply(interaction, "Choose a channel for ticket transcript files.");
      return;
    }
    const channel = await this.rest.channel(channelId);
    if (channel.guild_id !== interaction.guild_id || ![0, 5].includes(channel.type)) {
      await this.reply(interaction, "Choose a text channel in this server.");
      return;
    }
    await this.state.setTicketLogChannel(interaction.guild_id, channelId);
    await this.reply(interaction, `Ticket transcripts will be uploaded as files to <#${channelId}> when tickets close.`);
  }

  private async handleAuctionCommand(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id) {
      await this.reply(interaction, "Use `/auction` inside a server.");
      return;
    }
    const subcommand = interaction.data?.options?.[0]?.name;
    if (subcommand === "create") {
      await this.createAuctionFromLatestMessage(interaction);
      return;
    }
    if (subcommand === "end") {
      await this.endAuction(interaction, nestedOptionValue(interaction, "auction_id"));
      return;
    }
    await this.reply(interaction, "Choose `/auction create` or `/auction end`.");
  }

  private async handleComponent(interaction: DiscordInteraction): Promise<void> {
    const customId = interaction.data?.custom_id ?? "";
    if (customId.startsWith("set-destination|")) {
      await this.handleDestinationSelect(interaction);
      return;
    }
    if (customId.startsWith("set-sort|")) {
      await this.handleSetSort(interaction);
      return;
    }
    if (customId.startsWith("ticket-setup-select|")) {
      await this.handleTicketSetupSelect(interaction);
      return;
    }
    if (customId === "ticket-setup-create") {
      await this.createTicketPanelFromDraft(interaction);
      return;
    }
    if (customId.startsWith("ticket-panel-open|")) {
      await this.openPanelTicket(interaction, customId.slice("ticket-panel-open|".length));
      return;
    }
    const [action, id] = customId.split("|");
    if (!id) {
      await this.reply(interaction, "This button has expired.");
      return;
    }
    if (action === "auction-bid") {
      await this.showBidModal(interaction, id);
    } else if (action === "auction-buy") {
      await this.buyAuction(interaction, id);
    } else if (action === "auction-end") {
      await this.endAuction(interaction, id);
    } else if (action === "auction-bids") {
      await this.showBiddingList(interaction, id);
    } else if (action === "buy-negotiate") {
      await this.openBuyTicket(interaction, id, false);
    } else if (action === "buy-now") {
      await this.openBuyTicket(interaction, id, true);
    } else if (action === "ticket-close") {
      await this.closeTicket(interaction, id);
    } else if (action === "ticket-middleman") {
      await this.addTicketRole(interaction, id, "middleman");
    } else if (action === "ticket-dispute") {
      await this.addTicketRole(interaction, id, "dispute");
    } else {
      await this.reply(interaction, "This button is no longer active.");
    }
  }

  private async handleModal(interaction: DiscordInteraction): Promise<void> {
    const customId = interaction.data?.custom_id ?? "";
    if (customId === "ticket-setup-details-modal") {
      await this.submitTicketSetupDetails(interaction);
    } else if (customId === "ticket-open-modal") {
      await this.submitTicket(interaction);
    } else if (customId === "auction-create-modal") {
      await this.submitAuction(interaction);
    } else if (customId.startsWith("auction-bid-modal|")) {
      await this.submitBid(interaction, customId.slice("auction-bid-modal|".length));
    } else {
      await this.reply(interaction, "This form has expired.");
    }
  }

  private async submitTicketSetupDetails(interaction: DiscordInteraction): Promise<void> {
    const guildId = interaction.guild_id;
    const userId = actorId(interaction);
    if (!guildId || !userId || !isManager(interaction)) {
      await this.reply(interaction, "Only server managers can configure tickets.");
      return;
    }
    const key = `${guildId}:${userId}`;
    const draft = this.ticketSetupDrafts.get(key);
    if (!draft) {
      await this.reply(interaction, "This ticket setup has expired. Run `/ticket setup` again.");
      return;
    }
    const name = modalValue(interaction, "ticket-setup-name")?.trim();
    const description = modalValue(interaction, "ticket-setup-description")?.trim();
    if (!name || !description) {
      await this.reply(interaction, "Please provide both a ticket panel name and description.");
      return;
    }
    draft.name = name;
    draft.description = description;
    this.ticketSetupDrafts.set(key, draft);
    await this.rest.respond(interaction.id, interaction.token, {
      type: 4,
      data: {
        content: ticketSetupStatusText(draft),
        flags: EPHEMERAL,
        components: ticketSetupComponents(draft),
      },
    });
  }

  private async showTicketSetupSelector(interaction: DiscordInteraction): Promise<void> {
    await this.rest.respond(interaction.id, interaction.token, {
      type: 4,
      data: {
        content: "🎫 **Ticket Panel Setup**\n\nUse the dropdowns below to choose where tickets are created, where the panel is posted, which staff role has access, and which roles should be pinged.\n\n**Defaults:** Panel name `PokeMarket Tickets` · Button `Open Ticket`",
        flags: EPHEMERAL,
        components: ticketSetupComponents(),
      },
    });
  }

  private async handleTicketSetupSelect(interaction: DiscordInteraction): Promise<void> {
    const guildId = interaction.guild_id;
    const userId = actorId(interaction);
    if (!guildId || !userId || !isManager(interaction)) {
      await this.reply(interaction, "Only server managers can configure tickets.");
      return;
    }
    const key = `${guildId}:${userId}`;
    const draft = this.ticketSetupDrafts.get(key);
    if (!draft) {
      await this.reply(interaction, "This ticket setup has expired. Run `/ticket setup` again.");
      return;
    }
    const customId = interaction.data?.custom_id ?? "";
    const values = interaction.data?.values ?? [];
    if (!values.length) {
      await this.reply(interaction, "Please choose an option from the dropdown.");
      return;
    }
    const field = customId.split("|")[1];
    if (field === "category") draft.categoryId = values[0];
    else if (field === "panel") draft.panelChannelId = values[0];
    else if (field === "staff") draft.staffRoleId = values[0];
    else if (field === "ping") draft.pingRoleIds = values.slice(0, 10);
    else {
      await this.reply(interaction, "Unknown ticket setup option.");
      return;
    }
    this.ticketSetupDrafts.set(key, draft);
    await this.rest.respond(interaction.id, interaction.token, { type: 6 });
    await this.rest.editOriginalResponse(interaction.application_id, interaction.token, {
      content: ticketSetupStatusText(draft),
      components: ticketSetupComponents(draft),
    });
  }

  private async createTicketPanelFromDraft(interaction: DiscordInteraction): Promise<void> {
    const guildId = interaction.guild_id;
    const userId = actorId(interaction);
    if (!guildId || !userId || !isManager(interaction)) {
      await this.reply(interaction, "Only server managers can configure tickets.");
      return;
    }
    const key = `${guildId}:${userId}`;
    const draft = this.ticketSetupDrafts.get(key);
    if (!draft || !draft.categoryId || !draft.panelChannelId || !draft.staffRoleId) {
      await this.reply(interaction, "Choose the ticket category, panel channel, and staff role first.");
      return;
    }
    try {
      const category = await this.rest.channel(draft.categoryId);
      const panelChannel = await this.rest.channel(draft.panelChannelId);
      if (category.guild_id !== guildId || category.type !== 4) {
        throw new Error("The ticket destination must be a category channel from this server.");
      }
      if (panelChannel.guild_id !== guildId || ![0, 5].includes(panelChannel.type)) {
        throw new Error("The panel channel must be a text or announcement channel from this server.");
      }
      const current = this.state.snapshot().ticketConfigs[guildId];
      await this.state.setTicketConfig(guildId, {
        categoryId: draft.categoryId,
        categories: ["Support", "Negotiation", "Auction purchase"],
        staffRoleIds: [draft.staffRoleId],
        ...(current?.middlemanRoleId ? { middlemanRoleId: current.middlemanRoleId } : {}),
        ...(current?.disputeRoleId ? { disputeRoleId: current.disputeRoleId } : {}),
      });
      const panelId = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
      const panel: import("./types.js").TicketPanel = {
        id: panelId,
        guildId,
        panelChannelId: draft.panelChannelId,
        panelMessageId: "",
        name: draft.name,
        description: draft.description,
        buttonLabel: "Open Ticket",
        categoryId: draft.categoryId,
        staffRoleId: draft.staffRoleId,
        ...(draft.pingRoleIds.length ? { pingRoleIds: draft.pingRoleIds } : {}),
        namingFormat: "ticket-{username}",
        ...(current?.middlemanRoleId ? { middlemanRoleId: current.middlemanRoleId } : {}),
        ...(current?.disputeRoleId ? { disputeRoleId: current.disputeRoleId } : {}),
        enabled: true,
      };
      await this.state.addTicketPanel(panel);
      const panelMessage = await this.rest.createMessage(panel.panelChannelId, ticketPanelPayload(panel));
      await this.state.updateTicketPanel(guildId, panelId, { panelMessageId: panelMessage.id });
      this.ticketSetupDrafts.delete(key);
      await this.rest.editOriginalResponse(interaction.application_id, interaction.token, {
        content: `✅ **Ticket panel created!**\n\nPanel: <#${draft.panelChannelId}>\nTicket category: <#${draft.categoryId}>\nStaff: <@&${draft.staffRoleId}>\nPing roles: ${draft.pingRoleIds.length ? draft.pingRoleIds.map((id) => `<@&${id}>`).join(", ") : "None"}`,
        components: [],
      });
    } catch (error) {
      await this.reply(interaction, `Could not save ticket setup: ${(error as Error).message}`);
    }
  }


  private async showModal(
    interaction: DiscordInteraction,
    modal: { custom_id: string; title: string; components: unknown[] },
  ): Promise<void> {
    await this.rest.respond(interaction.id, interaction.token, {
      type: 9,
      data: modal,
    });
  }

  private async showBidModal(interaction: DiscordInteraction, auctionId: string): Promise<void> {
    const auction = this.state.snapshot().auctions.find((item) => item.id === auctionId);
    if (!auction || auction.status !== "open" || auction.endsAt <= Date.now()) {
      await this.reply(interaction, "This auction is closed.");
      return;
    }
    await this.showModal(interaction, {
      custom_id: `auction-bid-modal|${auctionId}`,
      title: `Bid on ${truncate(auction.title, 35)}`,
      components: [textInput("auction-bid-amount", "Your bid (USD)", 1, 20)],
    });
  }

  private async createAuctionFromLatestMessage(interaction: DiscordInteraction): Promise<void> {
    const guildId = interaction.guild_id;
    const channelId = interaction.channel_id;
    const sellerId = actorId(interaction);
    if (!guildId || !channelId || !sellerId) {
      await this.reply(interaction, "Auctions can only be created inside a server channel.");
      return;
    }
    const messages = await this.rest.listMessages(channelId, 25);
    const source = messages.find((message) => message.author?.id === sellerId && !message.author.bot) ?? messages[0];
    if (!source) {
      await this.reply(interaction, "Post the auction details in this channel first.");
      return;
    }
    const title = optionValue(interaction, "title") ?? (await this.rest.channel(channelId)).name ?? "Auction";
    await this.createAuctionFromMessage(guildId, channelId, source, title, interaction);
  }

  private async createAuctionFromMessage(
    guildId: string,
    channelId: string,
    source: DiscordMessage,
    title?: string,
    interaction?: DiscordInteraction,
  ): Promise<void> {
    if (this.state.snapshot().auctions.some((auction) => auction.sourceMessageId === source.id)) {
      if (interaction) await this.reply(interaction, "An auction already exists for that message.");
      return;
    }
    const content = source.content ?? "";
    const sourceImageUrl = extractMessageImageUrl(source);
    const ai = await extractAuctionInfoWithAI(content, source.embeds ?? [], title);
    const startingBid = ai?.startingBid ?? extractLabeledMoney(content, ["starting bid", "starting", "start"]);
    const buyNowPrice = ai?.buyNowPrice ?? extractLabeledMoney(content, ["buy now", "buy-now", "bin"]);
    const durationMinutes = ai?.durationMinutes ?? 7 * 24 * 60;
    const detectedCardName = ai?.cardName || title || "Pokémon Card";
    const detectedTitle = ai?.title || detectedCardName || "Auction";
    const detectedDescription = ai?.description || content || "Auction listing";
    const detectedCountry = detectCountry(content, title, source.embeds ?? []);
    const detectedShipping = detectShipping(content, title, source.embeds ?? []);
    if (!sourceImageUrl) {
      const message = "⚠️ **Auction not created:** attach a card image to the forum post.";
      if (interaction) await this.reply(interaction, message);
      else await this.rest.createMessage(channelId, { content: message }).catch(() => undefined);
      return;
    }
    if (startingBid === undefined || buyNowPrice === undefined || buyNowPrice <= startingBid) {
      const message = "⚠️ **Auction not created:** I need a starting bid and a higher Buy Now price. Example: `Starting Bid: R100` and `Buy Now: R250`.";
      if (interaction) await this.reply(interaction, message);
      else await this.rest.createMessage(channelId, { content: message }).catch(() => undefined);
      return;
    }
    const now = Date.now();
    const schedule = parseAuctionSchedule(content, now, durationMinutes);
    const auction: Auction = {
      id: randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
      guildId,
      channelId,
      messageId: "",
      sourceMessageId: source.id,
      sellerId: source.author?.id ?? (interaction ? actorId(interaction) : undefined) ?? "",
      title: truncate(detectedTitle, 100),
      description: detectedDescription,
      startingBid,
      buyNowPrice,
      startsAt: schedule.startsAt,
      endsAt: schedule.endsAt,
      status: "open",
      ...(this.state.snapshot().auctionOwnerRoles[guildId]
        ? { ownerRoleId: this.state.snapshot().auctionOwnerRoles[guildId] }
        : {}),
      cardName: detectedCardName,
      cardImageUrl: sourceImageUrl,
      ...(detectedCountry ? { country: detectedCountry } : {}),
      ...(detectedShipping ? { shipping: detectedShipping } : {}),
    };
    const message = await this.rest.createMessage(channelId, auctionMessagePayload(auction));
    auction.messageId = message.id;
    await this.state.addAuction(auction);
    await this.updateAuctionStatusTag(auction, getAuctionPhase(auction) === "upcoming" ? "upcoming" : "live");
    if (!detectedCountry || !detectedShipping) {
      try {
        await this.rest.createMessage(channelId, { content: `ℹ️ Auction shipping details: ${detectedCountry ? `Country: **${detectedCountry}**` : "Country not detected — add `Country: <country>`"} · ${detectedShipping ? `Shipping: **${detectedShipping === "national" ? "National" : "International"}**` : "Shipping not detected — add `Shipping: National` or `Shipping: International`"}.` });
      } catch {
        // Do not fail the auction if the information notice cannot be posted.
      }
    }
    if (interaction) await this.reply(interaction, `Auction **${auction.id}** created in <#${channelId}>.`);
  }

  private async createBuyListing(
    guildId: string,
    parentChannelId: string,
    channel: DiscordChannel,
    source: DiscordMessage,
  ): Promise<void> {
    const snapshot = this.state.snapshot();
    if (snapshot.buyListings.some((listing) => listing.sourceChannelId === channel.id)) return;
    const sellerId = source.author?.id;
    if (!sellerId) return;
    const description = source.content?.trim() || "Forum listing";
    const buyNowPrice = extractLabeledMoney(description, ["buy now", "price", "asking"]);
    const listing: import("./types.js").BuyListing = {
      id: randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
      guildId,
      sourceChannelId: channel.id,
      sourceMessageId: source.id,
      sellerId,
      title: truncate(channel.name ?? "Buy listing", 100),
      description,
      ...(buyNowPrice !== undefined ? { buyNowPrice } : {}),
      messageId: "",
      status: "available",
    };
    const message = await this.rest.createMessage(channel.id, buyListingPayload(listing));
    listing.messageId = message.id;
    await this.state.addBuyListing(listing);
    void parentChannelId;
  }

  private async openBuyTicket(
    interaction: DiscordInteraction,
    listingId: string,
    buyNow: boolean,
  ): Promise<void> {
    const buyerId = actorId(interaction);
    const listing = this.state.snapshot().buyListings.find((item) => item.id === listingId);
    if (!buyerId || !listing || listing.status !== "available") {
      await this.reply(interaction, "This listing is no longer available.");
      return;
    }
    if (buyerId === listing.sellerId) {
      await this.reply(interaction, "You cannot buy or negotiate your own listing.");
      return;
    }
    try {
      const ticket = await this.createPrivateTicket(interaction, {
        guildId: listing.guildId,
        createdById: buyerId,
        buyerId,
        sellerId: listing.sellerId,
        subject: `${buyNow ? "Buy now" : "Negotiate"}: ${listing.title}`,
        category: buyNow ? "Auction purchase" : "Negotiation",
        details:
          `Buyer: <@${buyerId}>\nSeller: <@${listing.sellerId}>\n` +
          `Listing: ${listing.title}\n` +
          `${listing.buyNowPrice !== undefined ? `Buy now price: ${money(listing.buyNowPrice)}\n` : ""}` +
          "\nUse the Middleman or Dispute button if staff assistance is needed.",
      });
      if (buyNow) await this.state.updateBuyListing(listing.id, { status: "sold" });
      await this.reply(interaction, `Private buyer-seller ticket created: <#${ticket.channelId}>`);
    } catch (error) {
      await this.reply(interaction, `Could not create the purchase ticket: ${(error as Error).message}`);
    }
  }

  private async submitTicket(interaction: DiscordInteraction): Promise<void> {
    const guildId = interaction.guild_id;
    const userId = actorId(interaction);
    if (!guildId || !userId) {
      await this.reply(interaction, "Tickets can only be opened inside a server.");
      return;
    }
    const subject = modalValue(interaction, "ticket-subject");
    const category = modalValue(interaction, "ticket-category");
    const item = modalValue(interaction, "ticket-item");
    const details = modalValue(interaction, "ticket-details");
    if (!subject || !category || !item || !details) {
      await this.reply(interaction, "Complete every ticket field before submitting.");
      return;
    }
    try {
      const ticket = await this.createPrivateTicket(interaction, {
        guildId,
        createdById: userId,
        subject,
        category,
        details: `Item or order reference: ${item}\n\n${details}`,
      });
      await this.reply(interaction, `Your private ticket is ready: <#${ticket.channelId}>`);
    } catch (error) {
      await this.reply(interaction, `Could not open the private ticket: ${(error as Error).message}`);
    }
  }

  private async submitAuction(interaction: DiscordInteraction): Promise<void> {
    const guildId = interaction.guild_id;
    const channelId = interaction.channel_id;
    const sellerId = actorId(interaction);
    if (!guildId || !channelId || !sellerId) {
      await this.reply(interaction, "Auctions can only be created inside a server channel.");
      return;
    }
    const title = modalValue(interaction, "auction-title");
    const description = modalValue(interaction, "auction-description");
    const startingBid = parseMoney(modalValue(interaction, "auction-starting-bid"));
    const buyNowPrice = parseMoney(modalValue(interaction, "auction-buy-now"));
    const durationMinutes = Number.parseInt(modalValue(interaction, "auction-duration") ?? "", 10);
    const country = detectCountry(description, title);
    if (
      !title ||
      !description ||
      startingBid === undefined ||
      buyNowPrice === undefined ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 5 ||
      durationMinutes > 10_080 ||
      buyNowPrice <= startingBid
    ) {
      await this.reply(
        interaction,
        "Check the form: prices must be valid, buy now must be higher than the starting bid, and duration must be 5–10080 minutes.",
      );
      return;
    }

    const auction: Auction = {
      id: randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
      guildId,
      channelId,
      messageId: "",
      sellerId,
      title,
      description,
      startingBid,
      buyNowPrice,
      endsAt: Date.now() + durationMinutes * 60_000,
      status: "open",
      ...(country ? { country } : {}),
    };
    try {
      const message = await this.rest.createMessage(channelId, auctionMessagePayload(auction));
      auction.messageId = message.id;
      await this.state.addAuction(auction);
      await this.reply(interaction, `Auction **${auction.id}** created: <#${channelId}>`);
    } catch (error) {
      await this.reply(interaction, `Could not create the auction: ${(error as Error).message}`);
    }
  }

  private async submitBid(interaction: DiscordInteraction, auctionId: string): Promise<void> {
    const bidderId = actorId(interaction);
    const auction = this.state.snapshot().auctions.find((item) => item.id === auctionId);
    const amount = parseMoney(modalValue(interaction, "auction-bid-amount"));
    if (!auction || auction.status !== "open" || auction.endsAt <= Date.now()) {
      await this.reply(interaction, "This auction is closed.");
      return;
    }
    const ownerRoleId = auction.ownerRoleId ?? this.state.snapshot().auctionOwnerRoles[auction.guildId];
    const ownerMayBid = Boolean(ownerRoleId && interaction.member?.roles?.includes(ownerRoleId));
    if (!bidderId || (bidderId === auction.sellerId && !ownerMayBid)) {
      await this.reply(interaction, ownerRoleId
        ? `Only members with <@&${ownerRoleId}> may bid on their own auction.`
        : "The seller cannot bid on their own auction.");
      return;
    }
    const minimum = auction.currentBid ?? auction.startingBid;
    if (amount === undefined || amount <= minimum || amount >= auction.buyNowPrice) {
      await this.reply(
        interaction,
        `Enter a bid higher than ${money(minimum)} and lower than the buy-now price of ${money(auction.buyNowPrice)}.`,
      );
      return;
    }
    const bids = [...(auction.bids ?? []), { bidderId, amount, at: Date.now() }];
    await this.state.updateAuction(auctionId, {
      currentBid: amount,
      currentBidderId: bidderId,
      bids,
    });
    const updated = { ...auction, currentBid: amount, currentBidderId: bidderId, bids };
    await this.updateAuctionMessage(updated);
    await this.reply(interaction, `Your bid of **${money(amount)}** is now the highest bid.`);
  }

  private async showBiddingList(interaction: DiscordInteraction, auctionId: string): Promise<void> {
    const auction = this.state.snapshot().auctions.find((item) => item.id === auctionId);
    if (!auction) {
      await this.reply(interaction, "This auction no longer exists.");
      return;
    }
    const bids = [...(auction.bids ?? [])].sort((a, b) => b.amount - a.amount || b.at - a.at);
    if (!bids.length) {
      await this.reply(interaction, "📋 **Bidding list**\n\nNo bids have been placed yet.", true);
      return;
    }
    const lines = bids.slice(0, 50).map((bid, index) =>
      `**${index + 1}.** <@${bid.bidderId}> — **${money(bid.amount)}** · <t:${Math.floor(bid.at / 1000)}:R>`,
    );
    await this.reply(interaction, `📋 **Bidding list — ${auction.title}**\n\n${lines.join("\n")}`, true);
  }

  private async buyAuction(interaction: DiscordInteraction, auctionId: string): Promise<void> {
    const buyerId = actorId(interaction);
    const guildId = interaction.guild_id;
    const auction = this.state.snapshot().auctions.find((item) => item.id === auctionId);
    if (!guildId || !buyerId) {
      await this.reply(interaction, "You must be identified inside a server to buy.");
      return;
    }
    if (!auction || auction.status !== "open" || auction.endsAt <= Date.now()) {
      await this.reply(interaction, "This auction is closed.");
      return;
    }
    if (buyerId === auction.sellerId) {
      await this.reply(interaction, "You cannot buy your own listing.");
      return;
    }
    try {
      const ticket = await this.createPrivateTicket(interaction, {
        guildId,
        createdById: buyerId,
        buyerId,
        sellerId: auction.sellerId,
        auctionId: auction.id,
        subject: `Buy: ${auction.title}`,
        category: "Auction purchase",
        details:
          `Buyer: <@${buyerId}>\nSeller: <@${auction.sellerId}>\n` +
          `Agreed buy-now price: ${money(auction.buyNowPrice)}\nAuction ID: ${auction.id}\n\n` +
          "Use this private ticket to confirm payment and delivery details.",
      });
      const sold = {
        ...auction,
        status: "sold" as const,
        soldToId: buyerId,
        soldPrice: auction.buyNowPrice,
      };
      await this.state.updateAuction(auctionId, {
        status: sold.status,
        soldToId: sold.soldToId,
        soldPrice: sold.soldPrice,
      });
      await this.updateAuctionMessage(sold);
      await this.updateAuctionStatusTag(sold, "sold");
      await this.reply(interaction, `Private buyer-seller ticket created: <#${ticket.channelId}>`);
    } catch (error) {
      await this.reply(interaction, `Could not create the purchase ticket: ${(error as Error).message}`);
    }
  }

  private async endAuction(interaction: DiscordInteraction, auctionId: string | undefined): Promise<void> {
    const actor = actorId(interaction);
    const auction = auctionId
      ? this.state.snapshot().auctions.find((item) => item.id === auctionId)
      : undefined;
    if (!auction) {
      await this.reply(interaction, "Enter a valid auction ID.");
      return;
    }
    if (actor !== auction.sellerId && !isManager(interaction)) {
      await this.reply(interaction, "Only the seller or a server manager can end this auction.");
      return;
    }
    if (auction.status !== "open") {
      await this.reply(interaction, `This auction is already ${auction.status}.`);
      return;
    }
    await this.state.updateAuction(auction.id, { status: "closed" });
    const ended = { ...auction, status: "closed" as const };
    await this.updateAuctionMessage(ended);
    await this.updateAuctionStatusTag(ended, "ended");
    await this.reply(interaction, `Auction **${auction.id}** ended.`);
  }

  async expireAuctions(): Promise<void> {
    const now = Date.now();
    const auctions = this.state.snapshot().auctions;
    for (const auction of auctions) {
      const phase = getAuctionPhase(auction, now);
      if (auction.status === "open" && phase === "ended") {
        await this.state.updateAuction(auction.id, { status: "closed" });
        const closed = { ...auction, status: "closed" as const };
        await this.updateAuctionMessage(closed);
        await this.updateAuctionStatusTag(closed, "ended");
      } else if (phase === "upcoming") {
        await this.updateAuctionStatusTag(auction, "upcoming");
        await this.updateAuctionMessage(auction);
      } else if (phase === "live") {
        await this.updateAuctionStatusTag(auction, "live");
        await this.updateAuctionMessage(auction);
      } else if (auction.status === "sold") {
        await this.updateAuctionStatusTag(auction, "sold");
        await this.updateAuctionMessage(auction);
      } else {
        await this.updateAuctionStatusTag(auction, "ended");
      }
    }
  }

  private async updateAuctionStatusTag(auction: Auction, status: "upcoming" | "live" | "ended" | "sold"): Promise<void> {
    try {
      const post = await this.rest.channel(auction.channelId);
      if (!post.parent_id) {
        console.warn(`[auction] ${auction.id} is not a forum post/thread; cannot apply a forum status tag.`);
        return;
      }

      const forum = await this.rest.channel(post.parent_id);
      const tags = forum.available_tags ?? [];
      if (!tags.length) {
        console.warn(`[auction] Forum ${post.parent_id} has no available tags. Create Upcoming, Live, Ended and Sold tags first.`);
        return;
      }

      // Match normal names as well as common decorated names such as "🟢 Live" or "Live | Auction".
      const aliases: Record<string, string[]> = {
        upcoming: ["upcoming", "starting soon", "starting", "not started", "future"],
        live: ["live", "active", "running", "current"],
        ended: ["ended", "end", "finished", "expired", "closed"],
        sold: ["sold", "sale complete", "completed"],
      };
      const normalizeTag = (name: string): string =>
        name.toLocaleLowerCase().replace(/[🟢🟡🟠🔴🔵🟣⚪⚫🟩🟨🟥🟦🟪]/gu, " ").replace(/[^a-z0-9]+/g, " ").trim();
      const matchesAlias = (tagName: string, aliasesForStatus: string[]): boolean => {
        const normalized = normalizeTag(tagName);
        return aliasesForStatus.some((alias) => {
          const a = normalizeTag(alias);
          return normalized === a || normalized.includes(a);
        });
      };

      let target = tags.find((tag) => matchesAlias(tag.name, aliases[status]));
      if (!target) {
        // Create the missing status tag automatically instead of silently leaving
        // the forum post without an Upcoming/Live/Ended/Sold tag. Discord allows
        // up to 20 forum tags, so only add one when there is room.
        const canonicalNames: Record<string, string> = {
          upcoming: "Upcoming",
          live: "Live",
          ended: "Ended",
          sold: "Sold",
        };
        if (tags.length >= 20) {
          console.warn(`[auction] Could not create the ${status} forum tag in ${post.parent_id}: the forum already has 20 tags.`);
          return;
        }
        const newTag = { name: canonicalNames[status], moderated: false };
        await this.rest.editChannel(post.parent_id, {
          available_tags: [...tags, newTag],
        });
        const refreshedForum = await this.rest.channel(post.parent_id);
        const refreshedTags = refreshedForum.available_tags ?? [];
        target = refreshedTags.find((tag) => matchesAlias(tag.name, aliases[status]));
        if (!target) {
          console.warn(`[auction] Discord did not return the newly-created ${canonicalNames[status]} forum tag.`);
          return;
        }
        // Use the refreshed tag list for status-tag cleanup below.
        tags.splice(0, tags.length, ...refreshedTags);
        console.info(`[auction] Created missing ${canonicalNames[status]} forum tag in ${post.parent_id}.`);
      }

      const statusTagIds = new Set(
        tags.filter((tag) => Object.values(aliases).some((names) => matchesAlias(tag.name, names))).map((tag) => tag.id),
      );
      const existing = post.applied_tags ?? [];
      const preserved = existing.filter((id) => !statusTagIds.has(id));
      const nextTags = [...preserved, target.id].slice(0, 5);

      await this.rest.editChannel(auction.channelId, { applied_tags: nextTags });
      console.info(`[auction] ${auction.id}: ${status} tag -> ${target.name}`);
    } catch (error) {
      console.warn(`[auction] Could not update status tag for ${auction.id}: ${(error as Error).message}`);
    }
  }

  private async updateAuctionMessage(auction: Auction): Promise<void> {
    try {
      await this.rest.editMessage(auction.channelId, auction.messageId, auctionMessagePayload(auction));
    } catch (error) {
      console.warn(`[auction] Could not update ${auction.id}: ${(error as Error).message}`);
    }
  }

  private async createPrivateTicket(
    interaction: DiscordInteraction,
    input: {
      guildId: string;
      createdById: string;
      subject: string;
      category: string;
      details: string;
      auctionId?: string;
      buyerId?: string;
      sellerId?: string;
      panelId?: string;
    },
  ): Promise<Ticket> {
    const snapshot = this.state.snapshot();
    const config = snapshot.ticketConfigs[input.guildId];
    const panel = input.panelId
      ? (snapshot.ticketPanels[input.guildId] ?? []).find((item) => item.id === input.panelId)
      : undefined;
    if (!config) {
      throw new Error("A server manager must run `/ticket setup` before tickets can be opened.");
    }
    const configuredCategory = panel
      ? "Support"
      : config.categories.find(
          (category) => category.toLocaleLowerCase() === input.category.toLocaleLowerCase(),
        );
    if (!configuredCategory || (input.panelId && !panel)) {
      throw new Error(
        `The ticket category **${input.category}** is not configured. Ask a manager to update \`/ticket setup\`.`,
      );
    }
    const ticketId = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    const participants = [...new Set([input.createdById, input.buyerId, input.sellerId].filter(Boolean))];
    const permissionOverwrites = [
      { id: input.guildId, type: 0, deny: String(VIEW_CHANNEL) },
      ...participants.map((id) => ({
        id,
        type: 1,
        allow: String(TICKET_MEMBER_PERMISSIONS),
      })),
      ...(panel ? [panel.staffRoleId] : config.staffRoleIds).map((id) => ({
        id,
        type: 0,
        allow: String(TICKET_MEMBER_PERMISSIONS),
      })),
      {
        id: interaction.application_id,
        type: 1,
        allow: String(TICKET_BOT_PERMISSIONS),
      },
    ];
    const namingFormat = panel?.namingFormat ?? "ticket-{id}";
    const channelName = namingFormat
      .replaceAll("{id}", ticketId.toLocaleLowerCase())
      .replaceAll("{username}", `user-${input.createdById.slice(-6)}`)
      .replace(/[^a-z0-9-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || `ticket-${ticketId.toLocaleLowerCase()}`;
    const channel = await this.rest.createGuildChannel(input.guildId, {
      name: channelName,
      type: 0,
      parent_id: panel?.categoryId ?? config.categoryId,
      topic: `${input.category} • ${input.subject}`,
      permission_overwrites: permissionOverwrites,
    });
    const ticket: Ticket = {
      id: ticketId,
      guildId: input.guildId,
      channelId: channel.id,
      createdById: input.createdById,
      subject: input.subject,
      category: input.category,
      details: input.details,
      status: "open",
      createdAt: Date.now(),
      ...(input.panelId ? { panelId: input.panelId } : {}),
      ...(input.auctionId ? { auctionId: input.auctionId } : {}),
      ...(input.buyerId ? { buyerId: input.buyerId } : {}),
      ...(input.sellerId ? { sellerId: input.sellerId } : {}),
    };
    await this.state.addTicket(ticket);
    await this.rest.createMessage(channel.id, {
      content: participants.map((id) => `<@${id}>`).join(" "),
      embeds: [
        {
          title: truncate(input.subject, 256),
          description: truncate(input.details, 4_000),
          color: 0x3b82f6,
          fields: [
            { name: "Creator", value: `<@${input.createdById}>`, inline: true },
            { name: "Category", value: truncate(configuredCategory, 1_024), inline: true },
            { name: "Created", value: `<t:${Math.floor(ticket.createdAt / 1000)}:F>`, inline: true },
          ],
          footer: { text: `Private ticket ${ticketId}` },
        },
      ],
      components: ticketComponents(ticketId, Boolean(input.buyerId && input.sellerId)),
      allowed_mentions: { users: participants },
    });
    const pingRoleIds = panel?.pingRoleIds?.length ? panel.pingRoleIds : (panel?.pingRoleId ? [panel.pingRoleId] : []);
    if (pingRoleIds.length) {
      await this.rest.createMessage(channel.id, {
        content: pingRoleIds.map((roleId) => `<@&${roleId}>`).join(" "),
        allowed_mentions: { roles: pingRoleIds },
      });
    }
    return ticket;
  }

  private async openPanelTicket(interaction: DiscordInteraction, panelId: string): Promise<void> {
    const guildId = interaction.guild_id;
    const userId = actorId(interaction);
    const panel = guildId
      ? (this.state.snapshot().ticketPanels[guildId] ?? []).find((item) => item.id === panelId && item.enabled)
      : undefined;
    if (!guildId || !userId || !panel) {
      await this.reply(interaction, "This ticket panel is no longer active.");
      return;
    }
    try {
      const ticket = await this.createPrivateTicket(interaction, {
        guildId,
        createdById: userId,
        subject: panel.name,
        category: "Support",
        details: panel.description,
        panelId: panel.id,
      });
      await this.reply(interaction, `Your private ticket is ready: <#${ticket.channelId}>`);
    } catch (error) {
      await this.reply(interaction, `Could not open the private ticket: ${(error as Error).message}`);
    }
  }

  private async addTicketRole(
    interaction: DiscordInteraction,
    ticketId: string,
    role: "middleman" | "dispute",
  ): Promise<void> {
    const ticket = this.state.snapshot().tickets.find((item) => item.id === ticketId);
    const actor = actorId(interaction);
    if (!ticket || !actor) {
      await this.reply(interaction, "This ticket no longer exists.");
      return;
    }
    if (actor !== ticket.createdById && actor !== ticket.buyerId && actor !== ticket.sellerId && !isManager(interaction)) {
      await this.reply(interaction, "Only a ticket participant or server manager can request help.");
      return;
    }
    const config = this.state.snapshot().ticketConfigs[ticket.guildId];
    const roleId = role === "middleman" ? config?.middlemanRoleId : config?.disputeRoleId;
    if (!roleId) {
      await this.reply(interaction, `No ${role} role is configured. Ask a manager to update \`/ticket setup\`.`);
      return;
    }
    await this.rest.editChannelPermission(ticket.channelId, roleId, {
      type: 0,
      allow: String(TICKET_MEMBER_PERMISSIONS),
    });
    await this.rest.createMessage(ticket.channelId, {
      content: `<@&${roleId}> has been added to ticket **${ticket.id}** for ${role} support.`,
      allowed_mentions: { roles: [roleId] },
    });
    await this.reply(interaction, `${role === "middleman" ? "Middleman" : "Dispute"} support has been requested.`);
  }

  private async closeTicket(interaction: DiscordInteraction, ticketId: string): Promise<void> {
    const ticket = this.state.snapshot().tickets.find((item) => item.id === ticketId);
    const actor = actorId(interaction);
    if (!ticket) {
      await this.reply(interaction, "This ticket no longer exists.");
      return;
    }
    if (
      actor !== ticket.createdById &&
      actor !== ticket.buyerId &&
      actor !== ticket.sellerId &&
      !isManager(interaction)
    ) {
      await this.reply(interaction, "Only a ticket participant or server manager can close this ticket.");
      return;
    }
    await this.state.updateTicket(ticketId, { status: "closed" });
    await this.rest.editChannel(ticket.channelId, { name: `closed-${ticket.id.toLocaleLowerCase()}` });
    await this.rest.createMessage(ticket.channelId, {
      content: `Ticket **${ticket.id}** is closed. A server manager can archive this channel.`,
      components: [],
      allowed_mentions: { parse: [] },
    });
    const panel = ticket.panelId
      ? (this.state.snapshot().ticketPanels[ticket.guildId] ?? []).find((item) => item.id === ticket.panelId)
      : undefined;
    const logChannelId = this.state.snapshot().ticketLogChannels[ticket.guildId] ?? panel?.logChannelId;
    if (logChannelId) {
      try {
        const messages = await this.rest.listMessages(ticket.channelId, 100);
        const transcript = [
          `PokeMarket Ticket Transcript`,
          `Ticket ID: ${ticket.id}`,
          `Subject: ${ticket.subject}`,
          `Category: ${ticket.category}`,
          `Created: ${new Date(ticket.createdAt).toISOString()}`,
          `Closed: ${new Date().toISOString()}`,
          `Created by: ${ticket.createdById}`,
          `Closed by: ${actor ?? "Unknown"}`,
          "",
          "================ MESSAGES ================",
          ...messages.reverse().map((message) => {
            const attachments = (message.attachments ?? []).map((attachment) => `\n[Attachment] ${attachment.filename ?? "file"}: ${attachment.url ?? attachment.proxy_url ?? ""}`).join("");
            const embeds = (message.embeds ?? []).length ? `\n[Embeds: ${message.embeds?.length}]` : "";
            return `[${message.id}] ${message.author?.username ?? message.author?.id ?? "Unknown"}: ${message.content ?? "[no text]"}${attachments}${embeds}`;
          }),
        ].join("\n");
        await this.rest.createFileMessage(logChannelId, `ticket-${ticket.id.toLowerCase()}-transcript.txt`, transcript);
      } catch (error) {
        console.warn(`[tickets] Could not save transcript file for ${ticket.id}: ${(error as Error).message}`);
      }
    }
    await this.reply(interaction, "Ticket closed.");
  }

  private async handleAutocomplete(interaction: DiscordInteraction): Promise<void> {
    const focused = interaction.data?.options?.find((option) => option.focused);
    if (!focused || !["subset", "set"].includes(focused.name)) {
      await this.rest.respond(interaction.id, interaction.token, { type: 8, data: { choices: [] } });
      return;
    }
    const isSetCommand = interaction.data?.name === "set";
    const selectedLanguage = isSetCommand ? optionValue(interaction, "language") : undefined;
    const selectedEra = isSetCommand ? optionValue(interaction, "era") : undefined;
    if (isSetCommand && (!isLanguageCode(selectedLanguage) || !selectedEra)) {
      await this.rest.respond(interaction.id, interaction.token, { type: 8, data: { choices: [] } });
      return;
    }
    const languages: LanguageCode[] =
      selectedLanguage && isLanguageCode(selectedLanguage) ? [selectedLanguage] : LANGUAGES;
    const query = String(focused.value ?? "").toLocaleLowerCase();
    const setLists = await Promise.all(
      languages.map(async (language) => {
        try {
          return { language, sets: await this.catalog.listSets(language) };
        } catch (error) {
          console.warn(`[tcgdex] Could not load ${language} autocomplete sets: ${(error as Error).message}`);
          return { language, sets: [] };
        }
      }),
    );
    const choices = setLists
      .flatMap(({ language, sets }) =>
        sets
          .filter((set) => !isSetCommand || set.eraId === selectedEra)
          .map((set) => {
          const name = setAutocompleteLabel(language, set.id, set.name, set.englishName);
          return {
            name,
            value: `${language}:${set.eraId ?? "misc"}:${set.id}`,
            search: `${name} ${language} ${set.eraName ?? ""} ${set.name} ${set.englishName ?? ""} ${set.id}`.toLocaleLowerCase(),
          };
        }),
      )
      .filter((choice) => !query || choice.search.includes(query))
      .slice(0, 25)
      .map(({ name, value }) => ({ name, value }));
    await this.rest.respond(interaction.id, interaction.token, { type: 8, data: { choices } });
  }

  private async handleSet(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id) {
      await this.reply(interaction, "Use `/set` inside a server.");
      return;
    }
    const selectedLanguage = optionValue(interaction, "language");
    if (!isLanguageCode(selectedLanguage)) {
      await this.reply(interaction, "Choose a language first.");
      return;
    }
    const selectedEra = optionValue(interaction, "era");
    if (!selectedEra) {
      await this.reply(interaction, "Choose an era first.");
      return;
    }
    const selected = optionValue(interaction, "subset");
    const set = selected ? await this.resolveSet(selected) : undefined;
    if (!set || set.language !== selectedLanguage || set.eraId !== selectedEra) {
      await this.reply(interaction, "Choose a subset from the selected language and era.");
      return;
    }

    const customId = `set-destination|${set.language}|${set.id}`;
    await this.rest.respond(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: EPHEMERAL,
        content: `Where should **${set.englishName ?? set.name}** be posted? Choose a text channel or forum.`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 8,
                custom_id: customId,
                placeholder: "Select a text channel or forum",
                min_values: 1,
                max_values: 1,
                channel_types: DESTINATION_CHANNEL_TYPES,
              },
            ],
          },
        ],
      },
    });
  }

  private async handleQuickset(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id) {
      await this.reply(interaction, "Use `/quickset` inside a server.");
      return;
    }

    const selectedLanguage = optionValue(interaction, "language");
    const destinationId = optionValue(interaction, "channel");

    if (!isLanguageCode(selectedLanguage)) {
      await this.reply(interaction, "Choose a language first.");
      return;
    }
    if (!destinationId) {
      await this.reply(interaction, "Choose a Forum Channel destination.");
      return;
    }

    try {
      const destination = await this.rest.channel(destinationId);
      if (destination.guild_id !== interaction.guild_id || !DESTINATION_CHANNEL_TYPES.includes(destination.type)) {
        await this.reply(interaction, "Choose a Forum Channel from this server.");
        return;
      }

      let sets = await this.catalog.refreshSets(selectedLanguage);
      if (sets.length === 0) {
        await this.reply(interaction, `No sets were found for ${quicksetLanguageLabel(selectedLanguage)}.`);
        return;
      }

      // Quickset publishes sets from the oldest release date to the newest.
      const releaseDates = await mapWithConcurrency(sets, 4, async (set) => {
        try {
          return {
            id: set.id,
            releaseDate: await this.catalog.getSetReleaseDate(set.language, set.id),
          };
        } catch (error) {
          console.warn(`[tcgdex] Could not read release date for ${set.id}: ${(error as Error).message}`);
          return { id: set.id, releaseDate: undefined };
        }
      });
      const releaseDateById = new Map(releaseDates.map((entry) => [entry.id, entry.releaseDate]));
      sets = sets
        .map((set) => ({ ...set, releaseDate: releaseDateById.get(set.id) }))
        .sort((a, b) => {
          const aTime = a.releaseDate ? Date.parse(a.releaseDate) : Number.POSITIVE_INFINITY;
          const bTime = b.releaseDate ? Date.parse(b.releaseDate) : Number.POSITIVE_INFINITY;
          return aTime - bTime;
        });

      await this.rest.respond(interaction.id, interaction.token, {
        type: 5,
        data: { flags: EPHEMERAL },
      });

      await this.editOriginal(
        interaction,
        `Starting quick setup for **${sets.length} ${quicksetLanguageLabel(selectedLanguage)} sets**…`,
      );

      let published = 0;
      let failed = 0;
      for (const [index, set] of sets.entries()) {
        try {
          let fullSet: PokemonSet;
          let cards: import("./types.js").PokemonCard[];
          try {
            const loaded = await this.catalog.getSet(set.language, set.id);
            fullSet = loaded.set;
            cards = loaded.cards;
          } catch (error) {
            console.warn(`[publisher] Using set summary for ${set.id}: ${(error as Error).message}`);
            fullSet = set;
            cards = [];
          }
          await this.editOriginal(
            interaction,
            `Quickset: publishing **${fullSet.name}${fullSet.englishName && fullSet.englishName !== fullSet.name ? ` — ${fullSet.englishName}` : ""}** (${index + 1}/${sets.length}) — ${cards.length ? `loaded ${cards.length} cards` : "posting set summary"}…`,
          );
          await this.publisher.publish(
            interaction.guild_id,
            destinationId,
            fullSet,
            cards,
            async () => undefined,
            { privateBrowseOnly: true },
          );
          published += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[publisher] Quickset could not publish ${set.id}: ${(error as Error).message}`);
        }
      }

      await this.editOriginal(
        interaction,
        `Quickset complete: **${published}/${sets.length} ${quicksetLanguageLabel(selectedLanguage)} sets** posted.` +
          (failed ? ` ${failed} set(s) could not be posted.` : ""),
      );
    } catch (error) {
      console.error(`[publisher] Quickset failed: ${(error as Error).message}`);
      await this.editOriginal(interaction, `Could not complete quickset: ${(error as Error).message}`);
    }
  }


  private async handleDestinationSelect(interaction: DiscordInteraction): Promise<void> {
    const customId = interaction.data?.custom_id ?? "";
    const parts = customId.split("|");
    if (parts[0] !== "set-destination" || parts.length < 3) return;
    const guildId = interaction.guild_id;
    const channelId = interaction.data?.values?.[0];
    const set = await this.resolveSet(`${parts[1]}:${parts.slice(2).join("|")}`);
    await this.rest.respond(interaction.id, interaction.token, { type: 6 });
    if (!guildId || !channelId || !set) {
      await this.editOriginal(interaction, "The selection expired or could not be loaded.");
      return;
    }

    try {
      const { set: fullSet, cards } = await this.catalog.getSet(set.language, set.id);
      await this.editOriginal(
        interaction,
        `Starting **${set.name}** — loading ${cards.length} cards and checking PriceCharting prices…`,
      );
      const count = await this.publisher.publish(guildId, channelId, fullSet, cards, async (completed, total) => {
        await this.editOriginal(
          interaction,
          `Posting **${set.name}**: ${completed}/${total} cards. This can take a few minutes for large sets.`,
        );
      });
      await this.editOriginal(
        interaction,
        `Posted the **${set.name}** set summary with ${count} cards available in the private sort menu.`,
      );
    } catch (error) {
      console.error(`[publisher] Set publish failed: ${(error as Error).message}`);
      await this.editOriginal(interaction, `Could not post this set: ${(error as Error).message}`);
    }
  }

  private async handleLocate(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id) {
      await this.reply(interaction, "Use `/locate` inside a server.");
      return;
    }
    const name = optionValue(interaction, "name");
    if (!name?.trim()) {
      await this.reply(interaction, "Enter a card name to locate.");
      return;
    }
    const number = optionValue(interaction, "number");
    if (!number?.trim()) {
      await this.reply(interaction, "Enter the card number too, such as `123` or `TG12`.");
      return;
    }

    await this.rest.respond(interaction.id, interaction.token, {
      type: 5,
      data: { flags: EPHEMERAL },
    });
    try {
      const matches = await locateMatches(
        this.rest,
        this.state,
        interaction.guild_id,
        name,
        number,
      );
      if (matches.length === 0) {
        await this.editOriginal(
          interaction,
          "No matching cards found in the channels added with `/locateadd`. " +
            "The bot needs View Channel and Read Message History there.",
        );
        return;
      }
      const links = matches
        .slice(0, 20)
        .map((match) => {
          const title =
            match.threadName ?? match.message.embeds?.[0]?.title ?? match.message.author?.username ?? "Card post";
          return `• [${truncate(title, 80)}](${discordMessageUrl(
            interaction.guild_id!,
            match.channelId,
            match.message.id,
          )})`;
        });
      const header = `Found ${matches.length} matching card post${matches.length === 1 ? "" : "s"} for **${name} ${number}**:\n`;
      const visibleLinks: string[] = [];
      for (const link of links) {
        if (`${header}${visibleLinks.concat(link).join("\n")}`.length > 1800) break;
        visibleLinks.push(link);
      }
      const moreCount = matches.length - visibleLinks.length;
      const more = moreCount > 0 ? `\n…and ${moreCount} more.` : "";
      await this.editOriginal(
        interaction,
        `${header}${visibleLinks.join("\n")}${more}`,
      );
    } catch (error) {
      await this.editOriginal(interaction, `Could not search the configured channels: ${(error as Error).message}`);
    }
  }

  private async handleLocateRange(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id) {
      await this.reply(interaction, "Use `/locaterange` inside a server.");
      return;
    }
    const permissions = BigInt(interaction.member?.permissions ?? "0");
    if ((permissions & 0x20n) === 0n && (permissions & 0x8n) === 0n) {
      await this.reply(interaction, "Only server managers can change the locate range.");
      return;
    }

    const subcommand = interaction.data?.options?.[0];
    if (subcommand?.name === "list") {
      const ids = this.state.snapshot().locateChannels[interaction.guild_id] ?? [];
      const channels = await Promise.all(
        ids.map(async (id) => {
          try {
            const channel = await this.rest.channel(id);
            return `• <#${channel.id}>`;
          } catch {
            return `• ${id} (not accessible)`;
          }
        }),
      );
      await this.reply(
        interaction,
        channels.length
          ? `Locate searches these channels and their public threads:\n${channels.join("\n")}`
          : "No channels selected. Use `/locateRange add` to choose channels.",
      );
      return;
    }

    const channelId = subcommand?.options?.find((option) => option.name === "channel")?.value;
    if (!channelId) {
      await this.reply(interaction, "Choose a channel.");
      return;
    }
    const channel = await this.rest.channel(String(channelId));
    if (channel.guild_id !== interaction.guild_id || !LOCATE_CHANNEL_TYPES.includes(channel.type)) {
      await this.reply(interaction, "Choose a Forum Channel from this server.");
      return;
    }

    if (subcommand.name === "add") {
      const added = await this.state.addLocateChannel(interaction.guild_id, channel.id);
      await this.reply(
        interaction,
        added
          ? `Added <#${channel.id}> to the locate range. The bot needs View Channel and Read Message History there.`
          : `<#${channel.id}> is already in the locate range.`,
      );
    } else if (subcommand.name === "remove") {
      const removed = await this.state.removeLocateChannel(interaction.guild_id, channel.id);
      await this.reply(
        interaction,
        removed ? `Removed <#${channel.id}> from the locate range.` : `<#${channel.id}> was not selected.`,
      );
    } else {
      await this.reply(interaction, "Unknown `/locateRange` action.");
    }
  }

  private async handleLocateAdd(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id || !isManager(interaction)) {
      await this.reply(interaction, "Only server managers can add locate channels.");
      return;
    }
    const channelId = optionValue(interaction, "channel");
    if (!channelId) {
      await this.reply(interaction, "Choose a text or forum channel.");
      return;
    }
    const channel = await this.rest.channel(channelId);
    if (channel.guild_id !== interaction.guild_id || !LOCATE_CHANNEL_TYPES.includes(channel.type)) {
      await this.reply(interaction, "Choose a Forum Channel from this server.");
      return;
    }
    const added = await this.state.addLocateChannel(interaction.guild_id, channel.id);
    await this.reply(
      interaction,
      added
        ? `Added <#${channel.id}>. /locate will search its messages and public threads.`
        : `<#${channel.id}> is already in the locate range.`,
    );
  }

  private async handleAuctionPage(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id || !isManager(interaction)) {
      await this.reply(interaction, "Only server managers can configure auction pages.");
      return;
    }
    const subcommand = interaction.data?.options?.[0]?.name;
    if (subcommand === "ownerrole") {
      const roleId = nestedOptionValue(interaction, "role");
      if (!roleId) {
        await this.reply(interaction, "Choose an owner role.");
        return;
      }
      await this.state.setAuctionOwnerRole(interaction.guild_id, roleId);
      await this.reply(interaction, `Members with <@&${roleId}> may bid on their own auctions.`);
      return;
    }
    if (subcommand === "list") {
      const channels = this.state.snapshot().auctionPages[interaction.guild_id] ?? [];
      await this.reply(
        interaction,
        channels.length ? `Auction pages:\n${channels.map((id) => `• <#${id}>`).join("\n")}` : "No auction pages configured.",
      );
      return;
    }
    const channelId = nestedOptionValue(interaction, "channel");
    if (!channelId) {
      await this.reply(interaction, "Choose a channel.");
      return;
    }
    const channel = await this.rest.channel(channelId);
    if (channel.guild_id !== interaction.guild_id || !AUCTION_PAGE_CHANNEL_TYPES.includes(channel.type)) {
      await this.reply(interaction, "Auction pages can only be added to a Forum Channel. Choose a forum channel from this server.");
      return;
    }
    const current = this.state.snapshot().auctionPages[interaction.guild_id] ?? [];
    const next = subcommand === "remove"
      ? current.filter((id) => id !== channel.id)
      : [...new Set([...current, channel.id])];
    await this.state.setAuctionPageChannels(interaction.guild_id, next);
    if (subcommand === "remove") {
      await this.reply(interaction, `Removed <#${channel.id}> from auction pages.`);
      return;
    }
    try {
      const added = await this.syncAuctionForum(interaction.guild_id, channel.id);
      await this.reply(interaction, `Added <#${channel.id}>. Scanned existing forum posts and created ${added} auction(s). New posts will be handled automatically.`);
    } catch (error) {
      await this.reply(interaction, `Added <#${channel.id}>, but I could not scan every post: ${(error as Error).message}`);
    }
  }

  private async handleBuyPageLocate(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id || !isManager(interaction)) {
      await this.reply(interaction, "Only server managers can configure buy pages.");
      return;
    }
    const subcommand = interaction.data?.options?.[0]?.name;
    if (subcommand === "list") {
      const channels = this.state.snapshot().buyPageChannels[interaction.guild_id] ?? [];
      await this.reply(interaction, channels.length ? `Buy page forums:\n${channels.map((id) => `• <#${id}>`).join("\n")}` : "No buy page forums configured.");
      return;
    }
    const channelId = nestedOptionValue(interaction, "channel");
    if (!channelId) {
      await this.reply(interaction, "Choose a forum channel.");
      return;
    }
    const channel = await this.rest.channel(channelId);
    if (channel.guild_id !== interaction.guild_id || !AUCTION_PAGE_CHANNEL_TYPES.includes(channel.type)) {
      await this.reply(interaction, "Auction pages can only be added to a Forum Channel. Choose a forum channel from this server.");
      return;
    }
    const current = this.state.snapshot().buyPageChannels[interaction.guild_id] ?? [];
    const next = subcommand === "remove" ? current.filter((id) => id !== channel.id) : [...new Set([...current, channel.id])];
    await this.state.setBuyPageChannels(interaction.guild_id, next);
    if (subcommand === "remove") {
      await this.reply(interaction, `Removed <#${channel.id}> from buy pages.`);
      return;
    }
    try {
      const added = await this.syncBuyForum(interaction.guild_id, channel.id);
      await this.reply(interaction, `Added <#${channel.id}>. Scanned existing forum posts and added Buy now / Negotiate buttons where possible (${added} post(s)). New posts will be handled automatically.`);
    } catch (error) {
      await this.reply(interaction, `Added <#${channel.id}>, but I could not access every post. Some posts may need to be opened again: ${(error as Error).message}`);
    }
  }

  private async syncAuctionForum(guildId: string, forumId: string): Promise<number> {
    const forum = await this.rest.channel(forumId);
    if (forum.guild_id !== guildId || forum.type !== 15) throw new Error("the selected channel is not an accessible forum");
    const active = (await this.rest.listActiveGuildThreads(guildId)).filter((thread) => thread.parent_id === forumId);
    let archived: DiscordChannel[] = [];
    try {
      archived = await this.rest.listArchivedPublicThreads(forumId);
    } catch (error) {
      console.warn(`[auction] Could not read archived posts in ${forumId}: ${(error as Error).message}`);
    }
    const threads = [...new Map([...active, ...archived].map((thread) => [thread.id, thread])).values()];
    let created = 0;
    for (const thread of threads) {
      try {
        const before = this.state.snapshot().auctions.length;
        await this.processForumPost(guildId, thread, undefined);
        if (this.state.snapshot().auctions.length > before) created++;
      } catch (error) {
        console.warn(`[auction] Could not process forum post ${thread.id}: ${(error as Error).message}`);
      }
    }
    return created;
  }

  private async syncBuyForum(guildId: string, forumId: string): Promise<number> {
    const forum = await this.rest.channel(forumId);
    if (forum.guild_id !== guildId || forum.type !== 15) throw new Error("the selected channel is not an accessible forum");
    const active = (await this.rest.listActiveGuildThreads(guildId)).filter((thread) => thread.parent_id === forumId);
    let archived: DiscordChannel[] = [];
    try {
      archived = await this.rest.listArchivedPublicThreads(forumId);
    } catch (error) {
      console.warn(`[buy] Could not read archived posts in ${forumId}: ${(error as Error).message}`);
    }
    const threads = [...new Map([...active, ...archived].map((thread) => [thread.id, thread])).values()];
    let created = 0;
    for (const thread of threads) {
      try {
        const messages = await this.rest.listMessages(thread.id, 10);
        const starter = messages.find((message) => message.id === thread.id) ?? messages[0];
        if (!starter) {
          await this.rest.createMessage(thread.id, { content: "⚠️ PokeMarket cannot access the original post message, so Buy now / Negotiate could not be added." });
          continue;
        }
        const before = this.state.snapshot().buyListings.length;
        await this.createBuyListing(guildId, forumId, thread, starter);
        if (this.state.snapshot().buyListings.length > before) created++;
      } catch (error) {
        console.warn(`[buy] Could not process forum post ${thread.id}: ${(error as Error).message}`);
        try {
          await this.rest.createMessage(thread.id, { content: "⚠️ PokeMarket cannot access this post right now. Buy now / Negotiate could not be added." });
        } catch {
          // If the bot cannot access the thread, it cannot post the warning there.
        }
      }
    }
    return created;
  }

  private async handleBuyCommand(interaction: DiscordInteraction): Promise<void> {
    if (!interaction.guild_id || !interaction.channel_id) {
      await this.reply(interaction, "Use `/buy` inside a server listing thread.");
      return;
    }
    const listing = this.state.snapshot().buyListings.find(
      (item) => item.guildId === interaction.guild_id && item.sourceChannelId === interaction.channel_id && item.status === "available",
    );
    if (!listing) {
      await this.reply(interaction, "This forum thread does not have an available buy listing yet.");
      return;
    }
    await this.openBuyTicket(interaction, listing.id, false);
  }

  private async handleSetSort(interaction: DiscordInteraction): Promise<void> {
    const parts = (interaction.data?.custom_id ?? "").split("|");
    const language = parts[1] as LanguageCode | undefined;
    const setId = parts.slice(2).join("|");
    const sort = interaction.data?.values?.[0] ?? "name-asc";
    if (!isLanguageCode(language) || !setId) {
      await this.reply(interaction, "This set menu has expired.");
      return;
    }

    try {
      const { set, cards } = await this.catalog.getSet(language, setId);
      const sorted = [...cards].sort((a, b) => compareCardsForSort(a, b, sort));
      const heading = `**${set.englishName ?? set.name}** · ${sortLabel(sort)}\nShowing ${sorted.length} cards.`;

      const embeds = sorted.map((card) => ({
        title: truncate(card.name, 256),
        description: [
          `**Number:** ${card.localId}`,
          `**Rarity:** ${card.rarity ?? "Unknown"}`,
        ].join("\n"),
        ...(card.image ? { image: { url: cardImageUrl(card.image) } } : {}),
        footer: { text: `${set.englishName ?? set.name} · ${card.localId}` },
      }));

      const chunks: Array<typeof embeds> = [];
      for (let i = 0; i < embeds.length; i += 10) {
        chunks.push(embeds.slice(i, i + 10));
      }

      await this.rest.respond(interaction.id, interaction.token, {
        type: 4,
        data: {
          flags: EPHEMERAL,
          content: heading,
          embeds: chunks[0] ?? [],
          allowed_mentions: { parse: [] },
        },
      });

      for (const chunk of chunks.slice(1)) {
        await this.rest.followup(interaction.application_id, interaction.token, {
          content: `**${set.englishName ?? set.name}** · ${sortLabel(sort)}`,
          embeds: chunk,
          flags: EPHEMERAL,
          allowed_mentions: { parse: [] },
        });
      }
    } catch (error) {
      await this.reply(interaction, `Could not load this set: ${(error as Error).message}`);
    }
  }

  private async resolveSet(value: string): Promise<PokemonSet | undefined> {
    const parsed = parseSetChoice(value);
    if (!parsed) return undefined;
    const sets = await this.catalog.listSets(parsed.language);
    return sets.find(
      (set) => set.id === parsed.setId && (!parsed.eraId || set.eraId === parsed.eraId),
    );
  }

  private async reply(interaction: DiscordInteraction, content: string): Promise<void> {
    await this.rest.respond(interaction.id, interaction.token, {
      type: 4,
      data: { content: truncate(content, 1900), flags: EPHEMERAL, allowed_mentions: { parse: [] } },
    });
  }

  private async editOriginal(interaction: DiscordInteraction, content: string): Promise<void> {
    await this.rest.editOriginalResponse(interaction.application_id, interaction.token, {
      content: truncate(content, 1900),
      components: [],
      allowed_mentions: { parse: [] },
    });
  }
}

function optionValue(interaction: DiscordInteraction, name: string): string | undefined {
  return interaction.data?.options?.find((option) => option.name === name)?.value?.toString();
}

function nestedOptionValue(interaction: DiscordInteraction, name: string): string | undefined {
  for (const option of interaction.data?.options ?? []) {
    if (option.name === name) return option.value?.toString();
    const nested = option.options?.find((child) => child.name === name);
    if (nested) return nested.value?.toString();
  }
  return undefined;
}

function actorId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function modalValue(interaction: DiscordInteraction, customId: string): string | undefined {
  for (const row of interaction.data?.components ?? []) {
    const field = row.components?.find((component) => component.custom_id === customId);
    if (field?.value !== undefined) return field.value.trim();
  }
  return undefined;
}

function textInput(
  customId: string,
  label: string,
  style: 1 | 2,
  maxLength: number,
  required = true,
): { type: number; components: Array<Record<string, unknown>> } {
  return {
    type: 1,
    components: [
      {
        type: 4,
        custom_id: customId,
        style,
        label,
        required,
        max_length: maxLength,
      },
    ],
  };
}

function isSnowflake(value: string): boolean {
  return /^\d{5,25}$/.test(value);
}

function parseSnowflakeList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[,\s]+/).filter(isSnowflake))].slice(0, 20);
}

function parseOptionalSnowflake(value: string | undefined): string | undefined {
  return value && isSnowflake(value) ? value : undefined;
}

function ticketSetupComponents(draft?: TicketSetupDraft): unknown[] {
  return [
    { type: 1, components: [{ type: 8, custom_id: "ticket-setup-select|category", placeholder: draft?.categoryId ? "Ticket category selected" : "Choose ticket category", channel_types: [4] }] },
    { type: 1, components: [{ type: 8, custom_id: "ticket-setup-select|panel", placeholder: draft?.panelChannelId ? "Panel channel selected" : "Choose panel channel", channel_types: [0, 5] }] },
    { type: 1, components: [{ type: 6, custom_id: "ticket-setup-select|staff", placeholder: draft?.staffRoleId ? "Staff role selected" : "Choose staff role", max_values: 1 }] },
    { type: 1, components: [{ type: 6, custom_id: "ticket-setup-select|ping", placeholder: draft?.pingRoleIds?.length ? "Ping roles selected" : "Choose roles to ping", min_values: 0, max_values: 10 }] },
    { type: 1, components: [{ type: 2, style: 3, label: "Create Ticket Panel", custom_id: "ticket-setup-create" }] },
  ];
}

function ticketSetupStatusText(draft: TicketSetupDraft): string {
  return [
    "🎫 **Ticket Panel Setup**",
    "",
    `Name: ${draft.name ? draft.name : "❌ Not set"}`,
    `Description: ${draft.description ? truncate(draft.description, 300) : "❌ Not set"}`,
    `Ticket category: ${draft.categoryId ? `<#${draft.categoryId}>` : "❌ Not selected"}`,
    `Panel channel: ${draft.panelChannelId ? `<#${draft.panelChannelId}>` : "❌ Not selected"}`,
    `Staff role: ${draft.staffRoleId ? `<@&${draft.staffRoleId}>` : "❌ Not selected"}`,
    `Ping roles: ${draft.pingRoleIds.length ? draft.pingRoleIds.map((id) => `<@&${id}>`).join(", ") : "None"}`,
    "",
    "Choose the missing items from the dropdowns, then click **Create Ticket Panel**.",
  ].join("\n");
}

function ticketComponents(ticketId: string, transaction: boolean): unknown[] {
  return [
    {
      type: 1,
      components: [
        ...(transaction
          ? [
              { type: 2, style: 1, label: "Middleman", custom_id: `ticket-middleman|${ticketId}` },
              { type: 2, style: 1, label: "Dispute", custom_id: `ticket-dispute|${ticketId}` },
            ]
          : []),
        { type: 2, style: 4, label: "Close ticket", custom_id: `ticket-close|${ticketId}` },
      ],
    },
  ];
}

async function extractAuctionInfoWithAI(
  content: string,
  embeds: DiscordEmbed[],
  fallbackTitle?: string,
): Promise<{ title?: string; cardName?: string; description?: string; startingBid?: number; buyNowPrice?: number; durationMinutes?: number } | undefined> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const embedText = embeds
    .flatMap((embed) => [embed.title, embed.description, ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])])
    .filter(Boolean)
    .join("\n");
  const input = [
    `Forum post title: ${fallbackTitle ?? ""}`,
    `Post content:\n${content}`,
    embedText ? `Embedded content:\n${embedText}` : "",
  ].filter(Boolean).join("\n\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [{
              type: "input_text",
              text: "Extract auction listing fields from a Pokémon marketplace forum post. Return ONLY valid JSON with keys title, cardName, description, startingBid, buyNowPrice, durationMinutes. Identify the Pokémon card name from the post title/content when possible. Never invent a card name. Prices are positive numbers in USD. If duration is not stated, omit durationMinutes. Do not invent prices.",
            }],
          },
          { role: "user", content: [{ type: "input_text", text: input }] },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const raw = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("\n") ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const numberOrUndefined = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    const duration = numberOrUndefined(parsed.durationMinutes);
    return {
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined,
      cardName: typeof parsed.cardName === "string" && parsed.cardName.trim() ? parsed.cardName.trim() : undefined,
      description: typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : undefined,
      startingBid: numberOrUndefined(parsed.startingBid),
      buyNowPrice: numberOrUndefined(parsed.buyNowPrice),
      durationMinutes: duration ? Math.min(10_080, Math.max(5, Math.round(duration))) : undefined,
    };
  } catch (error) {
    console.warn(`[auction-ai] Could not extract auction fields: ${(error as Error).message}`);
    return undefined;
  }
}

function parseMoney(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const amount = Number(value.replace(/[$€£,\s]/g, "").replace(/^R/i, "").replace(/^(?:ZAR|USD|EUR|GBP)/i, ""));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : undefined;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function extractLabeledMoney(content: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = content.match(new RegExp(`${escaped}\\s*[:=-]?\\s*(?:R|ZAR|USD|US\\$|\\$|€|EUR|£|GBP)?\\s*([0-9]+(?:[.,][0-9]{1,2})?)`, "i"));
    const value = parseMoney(match?.[1]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function compareCardNumber(left: string, right: string): number {
  const parse = (value: string): [number, string] => {
    const match = value.match(/^(\d+)(.*)$/);
    return match ? [Number(match[1]), match[2]] : [Number.MAX_SAFE_INTEGER, value];
  };
  const [leftNumber, leftSuffix] = parse(left);
  const [rightNumber, rightSuffix] = parse(right);
  return leftNumber - rightNumber || leftSuffix.localeCompare(rightSuffix);
}

function compareCardsForSort(
  left: import("./types.js").PokemonCard,
  right: import("./types.js").PokemonCard,
  sort: string,
): number {
  const direction = sort.endsWith("-desc") ? -1 : 1;
  let result = 0;

  if (sort.startsWith("number")) {
    result = compareCardNumber(left.localId, right.localId);
  } else if (sort.startsWith("rarity")) {
    result = (left.rarity ?? "Unknown").localeCompare(right.rarity ?? "Unknown");
    if (result === 0) result = left.name.localeCompare(right.name);
  } else {
    result = left.name.localeCompare(right.name);
    if (result === 0) result = compareCardNumber(left.localId, right.localId);
  }

  return result * direction;
}

function sortLabel(sort: string): string {
  if (sort === "number-asc") return "Card number · Ascending";
  if (sort === "number-desc") return "Card number · Descending";
  if (sort === "rarity-asc") return "Rarity · Ascending";
  if (sort === "rarity-desc") return "Rarity · Descending";
  if (sort === "name-desc") return "Name · Descending";
  return "Name · Ascending";
}

function buyListingPayload(listing: import("./types.js").BuyListing): {
  content: string;
  embeds: DiscordEmbed[];
  components: unknown[];
} {
  return {
    content: `**Buy listing** · Seller: <@${listing.sellerId}>`,
    embeds: [{
      title: truncate(listing.title, 256),
      description: truncate(listing.description, 4_000),
      color: 0xf59e0b,
      fields: [
        ...(listing.buyNowPrice !== undefined
          ? [{ name: "Buy now", value: money(listing.buyNowPrice), inline: true }]
          : []),
        { name: "How to buy", value: "Choose Negotiate to discuss the listing or Buy now to open a purchase ticket." },
      ],
      footer: { text: `Buy listing ${listing.id}` },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: "Negotiate", custom_id: `buy-negotiate|${listing.id}` },
        { type: 2, style: 3, label: "Buy now", custom_id: `buy-now|${listing.id}` },
      ],
    }],
  };
}

function ticketPanelPayload(panel: import("./types.js").TicketPanel): {
  content: string;
  embeds: DiscordEmbed[];
  components: unknown[];
} {
  return {
    content: "",
    embeds: [{
      title: truncate(panel.name, 256),
      description: truncate(panel.description, 4_000),
      color: 0x5865f2,
      footer: { text: "Private support tickets" },
    }],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 1,
        label: truncate(panel.buttonLabel, 80),
        custom_id: `ticket-panel-open|${panel.id}`,
      }],
    }],
  };
}

function extractMessageImageUrl(message: import("./types.js").DiscordMessage): string | undefined {
  const attachment = (message.attachments ?? []).find((item) => {
    const type = item.content_type?.toLowerCase() ?? "";
    const name = item.filename?.toLowerCase() ?? "";
    return type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
  });
  if (attachment?.url) return attachment.url;
  if (attachment?.proxy_url) return attachment.proxy_url;
  const embedImage = (message.embeds ?? []).find((embed) => Boolean(embed.image?.url))?.image?.url;
  return embedImage;
}

function isVerifiedForumPost(post: DiscordChannel, forum: DiscordChannel): boolean {
  const applied = post.applied_tags ?? [];
  const tags = forum.available_tags ?? [];
  if (applied.length === 0 || tags.length === 0) return false;
  return tags.some((tag) => applied.includes(tag.id) && tag.name.trim().toLowerCase() === "verified");
}

function isManager(interaction: DiscordInteraction): boolean {
  const permissions = BigInt(interaction.member?.permissions ?? "0");
  return (permissions & 0x20n) !== 0n || (permissions & 0x8n) !== 0n;
}

function getAuctionPhase(auction: Auction, now = Date.now()): "upcoming" | "live" | "ended" {
  if (auction.status === "sold") return "ended";
  if (auction.startsAt && auction.startsAt > now) return "upcoming";
  if (auction.endsAt <= now) return "ended";
  return "live";
}

function parseAuctionSchedule(text: string, now: number, fallbackDurationMinutes: number): { startsAt: number; endsAt: number } {
  const clean = text.replace(/\r/g, "");
  const start = parseDateFromText(clean, ["start date", "starts", "start", "opening date", "opens"]);
  const end = parseDateFromText(clean, ["end date", "ends", "end", "closing date", "closes"]);
  const startsAt = start ?? now;
  const endsAt = end ?? startsAt + fallbackDurationMinutes * 60_000;
  if (endsAt <= startsAt) return { startsAt, endsAt: startsAt + fallbackDurationMinutes * 60_000 };
  return { startsAt, endsAt };
}

function parseDateFromText(text: string, labels: string[]): number | undefined {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = text.match(new RegExp(`(?:${labelPattern})\\s*[:=-]\\s*([^\\n|;]+)`, "i"));
  if (!match?.[1]) return undefined;
  const value = match[1].trim().replace(/\s+at\s+/i, " ");
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function detectCountry(content: string, title?: string, embeds: DiscordEmbed[] = []): string | undefined {
  const text = [title ?? "", content, ...embeds.flatMap((embed) => [embed.title ?? "", embed.description ?? "", ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])])].join("\n");
  const explicit = text.match(/(?:country|location|from|ships? from)\s*[:\-]\s*([A-Za-z][A-Za-z .&'()]{1,40})/i);
  if (explicit?.[1]) return normalizeCountry(explicit[1]);
  const countries: Record<string, string> = {
    "south africa": "South Africa", "united states": "United States", "usa": "United States", "us": "United States",
    "united kingdom": "United Kingdom", "uk": "United Kingdom", "england": "United Kingdom", "japan": "Japan",
    "canada": "Canada", "australia": "Australia", "new zealand": "New Zealand", "germany": "Germany",
    "france": "France", "italy": "Italy", "spain": "Spain", "netherlands": "Netherlands", "belgium": "Belgium",
    "singapore": "Singapore", "hong kong": "Hong Kong", "south korea": "South Korea", "korea": "South Korea",
  };
  const lower = text.toLocaleLowerCase();
  const found = Object.keys(countries).find((name) => new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`, "i").test(lower));
  return found ? countries[found] : undefined;
}

function detectShipping(content: string, title?: string, embeds: DiscordEmbed[] = []): "national" | "international" | undefined {
  const text = [title ?? "", content, ...embeds.flatMap((embed) => [embed.title ?? "", embed.description ?? "", ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])])].join("\n");
  const explicit = text.match(/(?:shipping|delivery|ships?)\s*[:\-]\s*(national|domestic|local|international|worldwide|global)/i);
  const value = (explicit?.[1] ?? "").toLowerCase();
  if (["international", "worldwide", "global"].includes(value)) return "international";
  if (["national", "domestic", "local"].includes(value)) return "national";
  if (/\b(international shipping|ships? internationally|worldwide shipping|ships? worldwide)\b/i.test(text)) return "international";
  if (/\b(national shipping|domestic shipping|ships? nationally|ships? domestically)\b/i.test(text)) return "national";
  return undefined;
}

function normalizeCountry(value: string): string {
  const clean = value.replace(/[\n\r].*$/, "").replace(/[|,;].*$/, "").trim();
  return clean.length > 50 ? clean.slice(0, 50).trim() : clean;
}

function auctionMessagePayload(auction: Auction): {
  content: string;
  embeds: DiscordEmbed[];
  components: unknown[];
} {
  const now = Date.now();
  const phase = auction.status === "sold" ? "SOLD" : getAuctionPhase(auction, now) === "upcoming" ? "UPCOMING" : getAuctionPhase(auction, now) === "live" ? "LIVE" : "ENDED";
  const timer = phase === "UPCOMING" && auction.startsAt
    ? `Starts <t:${Math.floor(auction.startsAt / 1000)}:R>`
    : phase === "LIVE"
      ? `Ends <t:${Math.floor(auction.endsAt / 1000)}:R>`
      : phase === "ENDED"
        ? `Ended <t:${Math.floor(auction.endsAt / 1000)}:R>`
        : `Sold to <@${auction.soldToId}> for ${money(auction.soldPrice ?? auction.buyNowPrice)}`;
  const currentBid = auction.currentBid
    ? `${money(auction.currentBid)} by <@${auction.currentBidderId}>`
    : `No bids (starts at ${money(auction.startingBid)})`;
  const embed: DiscordEmbed = {
    title: truncate(auction.cardName ?? auction.title, 256),
    description: "",
    color: phase === "LIVE" ? 0x16a34a : phase === "UPCOMING" ? 0xf59e0b : phase === "SOLD" ? 0x2563eb : 0x64748b,
    fields: [
      { name: "Card", value: truncate(auction.cardName ?? auction.title, 256), inline: true },
      { name: "Country", value: truncate(auction.country ?? "Unable to detect", 256), inline: true },
      { name: "Shipping", value: auction.shipping === "international" ? "International" : auction.shipping === "national" ? "National" : "Not specified", inline: true },
      { name: "Current Bid", value: currentBid, inline: true },
      { name: "Starting Bid", value: money(auction.startingBid), inline: true },
      { name: "Buy Now", value: money(auction.buyNowPrice), inline: true },
      ...(auction.startsAt ? [{ name: "Start", value: `<t:${Math.floor(auction.startsAt / 1000)}:F>`, inline: true }] : []),
      { name: "End", value: `<t:${Math.floor(auction.endsAt / 1000)}:F>`, inline: true },
      { name: "Timer", value: `${phase} · ${timer}`, inline: false },
      ...(auction.paymentMethod ? [{ name: "Payment Method", value: truncate(auction.paymentMethod, 256), inline: true }] : []),
    ],
    footer: { text: `Auction ${auction.id} • Seller <@${auction.sellerId}>` },
    ...(auction.cardImageUrl ? { image: { url: auction.cardImageUrl } } : {}),
  };
  return {
    content: `**Auction ${auction.id}** · **${phase}**`,
    embeds: [embed],
    components: [{ type: 1, components: [
      ...(phase === "LIVE" ? [
        { type: 2, style: 1, label: "Place / change bid", custom_id: `auction-bid|${auction.id}` },
        { type: 2, style: 3, label: `Buy now ${money(auction.buyNowPrice)}`, custom_id: `auction-buy|${auction.id}` },
      ] : []),
      { type: 2, style: 2, label: "View bidding list", custom_id: `auction-bids|${auction.id}` },
      ...(phase === "LIVE" ? [{ type: 2, style: 4, label: "End auction", custom_id: `auction-end|${auction.id}` }] : []),
    ] }],
  };
}

function cardImageUrl(image: string): string {
  // TCGdex card assets are intentionally extensionless. Discord is more reliable
  // when we give it an explicit image asset, so request the high-quality WebP.
  const trimmed = image.trim();
  if (/\.(?:png|jpe?g|webp)(?:\?.*)?$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/$/, "")}/high.webp`;
}

function isLanguageCode(value: string | undefined): value is LanguageCode {
  return value !== undefined && LANGUAGES.includes(value as LanguageCode);
}

function languageLabel(language: LanguageCode): string {
  if (language === "en") return "English";
  if (language === "ja") return "Japanese";
  return language === "zh-cn" ? "Chinese (Simplified)" : "Chinese (Traditional)";
}

export function setAutocompleteLabel(
  language: LanguageCode,
  setId: string,
  localName: string,
  englishName?: string,
): string {
  const displayName =
    SET_LABEL_OVERRIDES[`${language}:${setId.toLocaleLowerCase()}`] ??
    englishName ??
    localName;
  return `${languageLabel(language)} | ${displayName} (${setId})`.slice(0, 100);
}
