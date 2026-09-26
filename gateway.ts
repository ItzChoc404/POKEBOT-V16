import WebSocket from "ws";
import { BotCommands } from "./commands.js";
import { DiscordRest } from "./discord-rest.js";
import type { DiscordInteraction } from "./types.js";

const INTENTS = 1 | 512 | 32768; // Guilds, Guild Messages, Message Content
const ERA_CHOICES = [
  { name: "Miscellaneous", value: "misc" },
  { name: "Base", value: "base" },
  { name: "Gym", value: "gym" },
  { name: "Neo", value: "neo" },
  { name: "Legendary Collection", value: "lc" },
  { name: "E-Card", value: "ecard" },
  { name: "EX", value: "ex" },
  { name: "POP", value: "pop" },
  { name: "Trainer Kits", value: "tk" },
  { name: "Diamond & Pearl", value: "dp" },
  { name: "Platinum", value: "pl" },
  { name: "HeartGold & SoulSilver", value: "hgss" },
  { name: "Call of Legends", value: "col" },
  { name: "Black & White", value: "bw" },
  { name: "McDonald's Collection", value: "mc" },
  { name: "XY", value: "xy" },
  { name: "Sun & Moon", value: "sm" },
  { name: "Sword & Shield", value: "swsh" },
  { name: "Scarlet & Violet", value: "sv" },
  { name: "Pokémon TCG Pocket", value: "tcgp" },
  { name: "Mega Evolution", value: "me" },
];

type GatewayPayload = {
  op: number;
  d?: any;
  s?: number | null;
  t?: string;
};

type BotApplication = { id: string; name?: string };
type ApplicationCommand = {
  id: string;
  name: string;
  type?: number;
  options?: Array<{ name: string }>;
};

export class DiscordGateway {
  private socket?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private gatewayUrl = "wss://gateway.discord.gg";
  private resumeUrl?: string;
  private sequence: number | null = null;
  private sessionId?: string;
  private applicationId?: string;
  private heartbeatInterval = 0;
  private heartbeatAcknowledged = true;
  private stopping = false;
  private reconnecting = false;
  private readyResolver?: () => void;

  constructor(
    private readonly token: string,
    private readonly rest: DiscordRest,
    private readonly commands: BotCommands,
  ) {}

  async start(): Promise<string> {
    const gateway = await this.rest.request<{ url: string }>("/gateway/bot");
    if (!gateway.url) throw new Error("Discord did not return a Gateway URL.");
    this.gatewayUrl = gateway.url;

    try {
      const app = await this.rest.request<BotApplication>("/oauth2/applications/@me");
      this.applicationId = app.id;
    } catch {
      this.applicationId = decodeApplicationId(this.token);
    }
    if (!this.applicationId) {
      throw new Error("Could not determine the Discord application ID from the bot token.");
    }

    await this.registerCommands();
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolver = undefined;
        reject(new Error("Discord Gateway did not send READY within 30 seconds."));
      }, 30_000);
      this.readyResolver = () => {
        clearTimeout(timeout);
        this.readyResolver = undefined;
        resolve();
      };
    });
    this.openSocket(this.resumeUrl ?? this.gatewayUrl);
    try {
      await ready;
      return this.applicationId;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Bot shutdown");
  }

  private async registerCommands(): Promise<void> {
    const commands = [
      {
        name: "set",
        description: "Post every card in a Pokémon set",
        options: [
          {
            type: 3,
            name: "language",
            description: "Show sets in this language",
            required: true,
            choices: [
              { name: "English", value: "en" },
              { name: "Japanese", value: "ja" },
              { name: "Chinese (Simplified)", value: "zh-cn" },
              { name: "Chinese (Traditional)", value: "zh-tw" },
            ],
          },
          {
            type: 3,
            name: "era",
            description: "Choose an English-named Pokémon era",
            required: true,
            choices: ERA_CHOICES,
          },
          {
            type: 3,
            name: "subset",
            description: "Choose an English-named set",
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        name: "quickset",
        description: "Post all Pokémon sets for a language",
        options: [
          {
            type: 3,
            name: "language",
            description: "Language for all sets",
            required: true,
            choices: [
              { name: "English", value: "en" },
              { name: "Japanese", value: "ja" },
              { name: "Chinese (Simplified)", value: "zh-cn" },
              { name: "Chinese (Traditional)", value: "zh-tw" },
            ],
          },
          {
            type: 7,
            name: "channel",
            description: "Forum Channel where all sets should be posted",
            required: true,
            channel_types: [15],
          },
        ],
      },
      {
        name: "locate",
        description: "Find cards with this name in configured channels",
        options: [
          { type: 3, name: "name", description: "Card name to find", required: true },
          { type: 3, name: "number", description: "Card number, such as 123 or TG12", required: true },
        ],
      },
      {
        name: "locateadd",
        description: "Add a Forum Channel to card searches",
        default_member_permissions: "32",
        options: [
          { type: 7, name: "channel", description: "Forum Channel to search", required: true, channel_types: [15] },
        ],
      },
      {
        name: "locaterange",
        description: "Choose where card searches look",
        default_member_permissions: "32",
        options: [
          {
            type: 1,
            name: "add",
            description: "Add a Forum Channel to the search range",
            options: [
              { type: 7, name: "channel", description: "Forum Channel to search", required: true, channel_types: [15] },
            ],
          },
          {
            type: 1,
            name: "remove",
            description: "Remove a Forum Channel from the search range",
            options: [
              { type: 7, name: "channel", description: "Forum Channel to remove", required: true, channel_types: [15] },
            ],
          },
          { type: 1, name: "list", description: "Show channels in the search range" },
        ],
      },
      {
        name: "ticket",
        description: "Set up or open private tickets",
        options: [
          {
            type: 1,
            name: "setup",
            description: "Configure ticket destination, categories, and staff roles",
          },
          {
            type: 1,
            name: "open",
            description: "Open a private support ticket",
          },
          {
            type: 1,
            name: "mediator",
            description: "Set the role that can act as ticket mediator",
            options: [{ type: 8, name: "role", description: "Mediator role", required: true }],
          },
          {
            type: 1,
            name: "dispute",
            description: "Set the role that handles disputes",
            options: [{ type: 8, name: "role", description: "Dispute team role", required: true }],
          },
        ],
      },
      {
        name: "auctionpage",
        description: "Configure forum channels that contain verified auction posts",
        default_member_permissions: "32",
        options: [
          {
            type: 1,
            name: "add",
            description: "Watch a Forum Channel for verified auction posts",
            options: [{ type: 7, name: "channel", description: "Forum Channel to watch", required: true, channel_types: [15] }],
          },
          {
            type: 1,
            name: "remove",
            description: "Stop watching a Forum Channel for auction posts",
            options: [{ type: 7, name: "channel", description: "Forum Channel to remove", required: true, channel_types: [15] }],
          },
          { type: 1, name: "list", description: "List auction page channels" },
          {
            type: 1,
            name: "ownerrole",
            description: "Set the role allowed to bid on its own auctions",
            options: [{ type: 8, name: "role", description: "Owner role", required: true }],
          },
        ],
      },
      {
        name: "buypagelocate",
        description: "Configure forums that automatically receive buy listings",
        default_member_permissions: "32",
        options: [
          {
            type: 1,
            name: "add",
            description: "Watch a forum for buy listings",
            options: [{ type: 7, name: "channel", description: "Forum channel", required: true, channel_types: [15] }],
          },
          {
            type: 1,
            name: "remove",
            description: "Stop watching a forum",
            options: [{ type: 7, name: "channel", description: "Forum channel", required: true, channel_types: [15] }],
          },
          { type: 1, name: "list", description: "List buy page forums" },
        ],
      },
      {
        name: "tlog",
        description: "Set the channel for closed-ticket transcript files",
        default_member_permissions: "32",
        options: [
          { type: 7, name: "channel", description: "Channel for transcript files", required: true, channel_types: [0, 5] },
        ],
      },
      {
        name: "buy",
        description: "Open a negotiation ticket for the current buy listing",
      },
      {
        name: "auction",
        description: "Create or manage a Pokémon card auction",
        options: [
          {
            type: 1,
            name: "create",
            description: "Create an auction from the latest message in this channel",
            options: [
              { type: 3, name: "title", description: "Auction title", required: true },
            ],
          },
          {
            type: 1,
            name: "end",
            description: "End one of your auction listings",
            options: [
              {
                type: 3,
                name: "auction_id",
                description: "Auction ID shown on the listing",
                required: true,
              },
            ],
          },
        ],
      },
    ];
    await this.rest.request(`/applications/${this.applicationId}/commands`, {
      method: "PUT",
      body: commands,
    });
  }

  private async removeLegacyGuildSetCommands(guildIds: string[]): Promise<void> {
    if (!this.applicationId) return;

    let removed = 0;
    await Promise.all(
      guildIds.map(async (guildId) => {
        try {
          const route = `/applications/${this.applicationId}/guilds/${encodeURIComponent(guildId)}/commands`;
          const commands = await this.rest.request<ApplicationCommand[]>(route);
          const legacySets = commands.filter((command) => {
            if (command.name !== "set" || (command.type !== undefined && command.type !== 1)) {
              return false;
            }
            return command.options?.[0]?.name !== "language" || command.options?.[1]?.name !== "set";
          });

          for (const command of legacySets) {
            await this.rest.request(`${route}/${encodeURIComponent(command.id)}`, {
              method: "DELETE",
            });
            removed++;
          }
        } catch (error) {
          console.warn(
            `[commands] Could not check old /set commands in server ${guildId}: ${(error as Error).message}`,
          );
        }
      }),
    );

    if (removed > 0) {
      console.info(`[commands] Removed ${removed} outdated server-specific /set command(s).`);
    }
  }

  private openSocket(url: string): void {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    const socketUrl = `${url}${url.includes("?") ? "&" : "?"}v=10&encoding=json`;
    const socket = new WebSocket(socketUrl);
    this.socket = socket;

    socket.on("open", () => {
      this.reconnecting = false;
      console.info("[gateway] WebSocket connected to Discord.");
    });
    socket.on("message", (data) => {
      try {
        const payload = JSON.parse(data.toString()) as GatewayPayload;
        if (payload.s !== null && payload.s !== undefined) this.sequence = payload.s;
        void this.handlePayload(payload);
      } catch (error) {
        console.error(`[gateway] Could not parse a gateway message: ${(error as Error).message}`);
      }
    });
    socket.on("close", (code, reason) => {
      this.reconnecting = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      console.warn(
        `[gateway] Connection closed (code ${code}` +
          `${reason?.toString() ? `, reason: ${reason.toString()}` : ""}).`,
      );
      if (code === 4014) {
        console.error(
          "[gateway] Discord rejected a privileged intent. Enable Message Content Intent in the Developer Portal.",
        );
      }
      if (!this.stopping) this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      console.error(`[gateway] WebSocket connection error: ${error.message}`);
    });
  }

  private async handlePayload(payload: GatewayPayload): Promise<void> {
    if (payload.op === 10) {
      this.heartbeatInterval = payload.d?.heartbeat_interval ?? 0;
      this.startHeartbeats();
      if (this.sessionId && this.sequence !== null) {
        this.send({
          op: 6,
          d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
        });
      } else {
        this.send({
          op: 2,
          d: {
            token: this.token,
            intents: INTENTS,
            properties: { os: process.platform, browser: "pokemon-card-bot", device: "pokemon-card-bot" },
          },
        });
      }
      return;
    }
    if (payload.op === 1) {
      this.sendHeartbeat();
      return;
    }
    if (payload.op === 7) {
      this.socket?.close(4000, "Gateway requested reconnect");
      return;
    }
    if (payload.op === 9) {
      const resumable = Boolean(payload.d);
      if (!resumable) {
        this.sessionId = undefined;
        this.sequence = null;
        this.resumeUrl = undefined;
      }
      await sleep(1_500);
      this.socket?.close(4000, "Invalid session");
      return;
    }
    if (payload.op === 11) {
      this.heartbeatAcknowledged = true;
      return;
    }
    if (payload.op !== 0) return;

    if (payload.t === "READY") {
      this.sessionId = payload.d?.session_id;
      this.resumeUrl = payload.d?.resume_gateway_url;
      if (this.applicationId && payload.d?.application?.id) {
        this.applicationId = payload.d.application.id;
      }
      console.info(`[gateway] Connected as ${payload.d?.user?.username ?? "Discord bot"}.`);
      const guildIds: string[] = Array.isArray(payload.d?.guilds)
        ? payload.d.guilds.flatMap((guild: { id?: string }) =>
            typeof guild.id === "string" ? [guild.id] : [],
          )
        : [];
      void this.removeLegacyGuildSetCommands(guildIds);
      this.readyResolver?.();
    } else if (payload.t === "INTERACTION_CREATE") {
      void this.commands.handle(payload.d as DiscordInteraction).catch((error) => {
        console.error(`[gateway] Interaction handling failed: ${(error as Error).message}`);
      });
    } else if (payload.t === "MESSAGE_CREATE") {
      void this.commands.handleMessage(payload.d).catch((error) => {
        console.error(`[gateway] Message handling failed: ${(error as Error).message}`);
      });
    } else if (payload.t === "THREAD_CREATE") {
      void this.commands.handleThreadCreate(payload.d).catch((error) => {
        console.error(`[gateway] Thread handling failed: ${(error as Error).message}`);
      });
    }
  }

  private startHeartbeats(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!this.heartbeatInterval) return;
    this.heartbeatAcknowledged = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcknowledged) {
        this.socket?.close(4000, "Missed heartbeat acknowledgement");
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  private sendHeartbeat(): void {
    this.heartbeatAcknowledged = false;
    this.send({ op: 1, d: this.sequence });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket(this.resumeUrl ?? this.gatewayUrl);
    }, 3_000);
  }
}

function decodeApplicationId(token: string): string | undefined {
  const firstPart = token.split(".")[0];
  if (!firstPart) return undefined;
  try {
    return Buffer.from(firstPart, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}