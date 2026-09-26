export type LanguageCode = "en" | "ja" | "zh-cn" | "zh-tw";

export type PokemonSet = {
  id: string;
  name: string;
  language: LanguageCode;
  englishName?: string;
  eraId?: string;
  eraName?: string;
  cardCount?: { total?: number; official?: number };
  image?: string;
  releaseDate?: string;
};

export type CardSummary = {
  id: string;
  name: string;
  localId: string;
};

export type PokemonCard = {
  id: string;
  localId: string;
  name: string;
  image?: string;
  category?: string;
  hp?: number | string;
  types?: string[];
  stage?: string;
  evolveFrom?: string;
  evolveTo?: string[];
  dexId?: number[];
  regulationMark?: string;
  rarity?: string;
  illustrator?: string;
  effect?: string;
  variants?: Record<string, boolean>;
  abilities?: Array<{ type?: string; name?: string; effect?: string }>;
  attacks?: Array<{
    name?: string;
    cost?: string[];
    damage?: string | number;
    effect?: string;
  }>;
  weaknesses?: Array<{ type?: string; value?: string }>;
  resistances?: Array<{ type?: string; value?: string }>;
  retreat?: number;
  trainerType?: string;
  description?: string;
  englishName?: string;
};

export type PriceChartingPrice = {
  productId: string;
  currency: "USD";
  ungradedPrice?: number;
  productName?: string;
  consoleName?: string;
};

export type TrackedPost = {
  guildId: string;
  language: LanguageCode;
  setId: string;
  setName: string;
  card: PokemonCard;
  parentChannelId: string;
  channelId: string;
  messageId: string;
  priceProductId?: string;
  lastPriceLookupAt?: number;
  forumPost: boolean;
};

export type PriceSnapshot = {
  at: number;
  ungradedPrice?: number;
};

export type BotState = {
  locateChannels: Record<string, string[]>;
  trackedPosts: TrackedPost[];
  priceHistory: Record<string, PriceSnapshot[]>;
  postedCrossLinks: string[];
  auctions: Auction[];
  tickets: Ticket[];
  ticketConfigs: Record<string, TicketConfig>;
  ticketPanels: Record<string, TicketPanel[]>;
  auctionPages: Record<string, string[]>;
  auctionOwnerRoles: Record<string, string>;
  buyPageChannels: Record<string, string[]>;
  ticketLogChannels: Record<string, string>;
  buyListings: BuyListing[];
};

export type TicketConfig = {
  categoryId: string;
  categories: string[];
  staffRoleIds: string[];
  middlemanRoleId?: string;
  disputeRoleId?: string;
};

export type TicketPanel = {
  id: string;
  guildId: string;
  panelChannelId: string;
  panelMessageId: string;
  name: string;
  description: string;
  buttonLabel: string;
  buttonEmoji?: string;
  categoryId: string;
  staffRoleId: string;
  pingRoleId?: string;
  pingRoleIds?: string[];
  logChannelId?: string;
  namingFormat: string;
  middlemanRoleId?: string;
  disputeRoleId?: string;
  enabled: boolean;
};

export type BuyListing = {
  id: string;
  guildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sellerId: string;
  title: string;
  description: string;
  buyNowPrice?: number;
  messageId: string;
  status: "available" | "sold";
};

export type Auction = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  sourceMessageId?: string;
  sellerId: string;
  title: string;
  description: string;
  startingBid: number;
  buyNowPrice: number;
  currentBid?: number;
  currentBidderId?: string;
  startsAt?: number;
  endsAt: number;
  status: "open" | "closed" | "sold";
  soldToId?: string;
  soldPrice?: number;
  ownerRoleId?: string;
  cardName?: string;
  cardImageUrl?: string;
  country?: string;
  shipping?: "national" | "international";
  paymentMethod?: string;
  bids?: Array<{ bidderId: string; amount: number; at: number }>;
};

export type Ticket = {
  id: string;
  guildId: string;
  channelId: string;
  createdById: string;
  subject: string;
  category: string;
  details: string;
  status: "open" | "closed";
  auctionId?: string;
  buyerId?: string;
  sellerId?: string;
  panelId?: string;
  createdAt: number;
  closedAt?: number;
  closedById?: string;
  staffMemberIds?: string[];
};

export type DiscordChannel = {
  id: string;
  guild_id?: string;
  type: number;
  parent_id?: string;
  name?: string;
  applied_tags?: string[];
  available_tags?: Array<{ id: string; name: string }>;
};

export type DiscordEmbed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  image?: { url: string };
  footer?: { text: string };
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: { id: string; bot?: boolean; username?: string };
  content?: string;
  embeds?: DiscordEmbed[];
  attachments?: Array<{ id: string; filename?: string; url?: string; proxy_url?: string; content_type?: string; width?: number; height?: number }>;
  thread?: DiscordChannel;
  message_reference?: { channel_id?: string; message_id?: string };
};

export type DiscordThread = DiscordChannel & {
  message?: DiscordMessage;
  thread_metadata?: { archive_timestamp?: string; archived?: boolean };
};

export type DiscordInteraction = {
  id: string;
  application_id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { permissions?: string; roles?: string[]; user?: { id: string } };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    components?: Array<{
      type: number;
      components?: Array<{ type: number; custom_id?: string; value?: string }>;
    }>;
    options?: Array<{
      name: string;
      type: number;
      value?: string;
      focused?: boolean;
      options?: Array<{ name: string; type: number; value?: string }>;
    }>;
  };
};