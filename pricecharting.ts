import type { LanguageCode, PokemonCard, PokemonSet, PriceChartingPrice } from "./types.js";

const API_ROOT = "https://www.pricecharting.com";
const LOOKUP_CONCURRENCY = 3;

type PriceChartingProduct = {
  status?: string;
  id?: string | number;
  "product-name"?: string;
  "console-name"?: string;
  "loose-price"?: number | string | null;
  message?: string;
  error?: string;
};

function tokenFromEnv(): string | undefined {
  const token = process.env.PRICECHARTING_API_TOKEN?.trim();
  return token || undefined;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function numberCandidates(localId: string): Set<string> {
  const firstPart = localId.split("/")[0]?.trim() ?? "";
  const values = new Set([firstPart, localId.trim()]);
  const numeric = firstPart.match(/\d+/)?.[0];
  if (numeric) values.add(numeric.replace(/^0+(?=\d)/, ""));
  return new Set([...values].map(normalize).filter(Boolean));
}

function dollarsFromCents(value: PriceChartingProduct["loose-price"]): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const cents = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(cents) || cents <= 0) return undefined;
  return cents / 100;
}

function toPrice(product: PriceChartingProduct): PriceChartingPrice {
  return {
    productId: String(product.id),
    currency: "USD",
    ungradedPrice: dollarsFromCents(product["loose-price"]),
    ...(product["product-name"] ? { productName: product["product-name"] } : {}),
    ...(product["console-name"] ? { consoleName: product["console-name"] } : {}),
  };
}

function matchesCard(
  product: PriceChartingProduct,
  set: PokemonSet,
  card: PokemonCard,
): boolean {
  const productName = normalize(product["product-name"] ?? "");
  const consoleName = normalize(product["console-name"] ?? "");
  const combined = `${productName} ${consoleName}`;
  if (!productName) return false;

  const language = set.language;
  if (language === "ja" && !/\b(japanese|japan)\b/.test(consoleName)) return false;
  if (
    (language === "zh-cn" || language === "zh-tw") &&
    !/\b(chinese|china)\b/.test(consoleName)
  ) {
    return false;
  }
  if (
    language === "en" &&
    /\b(japanese|japan|chinese|china)\b/.test(consoleName)
  ) {
    return false;
  }

  const cardNames = [card.englishName, card.name]
    .filter((name): name is string => Boolean(name))
    .map(normalize)
    .filter((name) => name.length > 1);
  const nameMatches = cardNames.some((name) => productName.includes(name));
  if (!nameMatches) return false;

  const productTokens = new Set(combined.split(" "));
  return [...numberCandidates(card.localId)].some((number) => productTokens.has(number));
}

function productQuery(set: PokemonSet, card: PokemonCard): string {
  const region =
    set.language === "ja"
      ? "Pokemon Japanese"
      : set.language === "zh-cn" || set.language === "zh-tw"
        ? "Pokemon Chinese"
        : "Pokemon";
  const setName = set.englishName || set.name;
  const cardName = card.englishName || card.name;
  return `${region} ${setName} ${cardName} #${card.localId} ${set.id}`;
}

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

export class PriceChartingClient {
  private readonly token = tokenFromEnv();
  private readonly warnedMessages = new Set<string>();
  private accessVerified = false;
  private accessRejected = false;

  get isConfigured(): boolean {
    return Boolean(this.token);
  }

  get isAvailable(): boolean {
    return Boolean(this.token) && !this.accessRejected;
  }

  get hasVerifiedAccess(): boolean {
    return this.accessVerified;
  }

  async pricesForSet(
    set: PokemonSet,
    cards: PokemonCard[],
  ): Promise<Map<string, PriceChartingPrice>> {
    const output = new Map<string, PriceChartingPrice>();
    if (!this.isAvailable) return output;

    const matches = await mapWithConcurrency(cards, LOOKUP_CONCURRENCY, async (card) => {
      try {
        const product = await this.requestProduct({ q: productQuery(set, card) });
        if (!product || !matchesCard(product, set, card)) return undefined;
        return [card.id, toPrice(product)] as const;
      } catch (error) {
        this.warnOnce(`Card lookup failed: ${(error as Error).message}`);
        return undefined;
      }
    });

    for (const match of matches) {
      if (match) output.set(match[0], match[1]);
    }
    return output;
  }

  async pricesForProducts(productIds: string[]): Promise<Map<string, PriceChartingPrice>> {
    const output = new Map<string, PriceChartingPrice>();
    if (!this.isAvailable) return output;

    const ids = [...new Set(productIds.filter(Boolean))];
    const products = await mapWithConcurrency(ids, LOOKUP_CONCURRENCY, async (productId) => {
      try {
        const product = await this.requestProduct({ id: productId });
        return product ? [productId, toPrice(product)] as const : undefined;
      } catch (error) {
        this.warnOnce(`Price refresh failed: ${(error as Error).message}`);
        return undefined;
      }
    });

    for (const product of products) {
      if (product) output.set(product[0], product[1]);
    }
    return output;
  }

  private async requestProduct(
    lookup: { id: string } | { q: string },
  ): Promise<PriceChartingProduct | undefined> {
    const token = this.token;
    if (!token || this.accessRejected) return undefined;

    const url = new URL("/api/product", API_ROOT);
    url.searchParams.set("t", token);
    if ("id" in lookup) url.searchParams.set("id", lookup.id);
    else url.searchParams.set("q", lookup.q);

    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "PokemonSetDiscordBot/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.accessRejected = true;
        throw new Error("PriceCharting rejected the token or API subscription (401/403).");
      }
      throw new Error(`PriceCharting returned HTTP ${response.status}.`);
    }

    const product = (await response.json()) as PriceChartingProduct;
    if (product.status !== "success" || product.id === undefined) {
      const details = `${product.message ?? ""} ${product.error ?? ""}`.toLocaleLowerCase();
      if (/(token|auth|subscription|api access|permission)/.test(details)) {
        this.accessRejected = true;
        throw new Error("PriceCharting rejected the token or API subscription.");
      }
      this.accessVerified = true;
      return undefined;
    }
    this.accessVerified = true;
    return product;
  }

  private warnOnce(message: string): void {
    if (this.warnedMessages.has(message)) return;
    this.warnedMessages.add(message);
    console.warn(`[pricecharting] ${message}`);
  }
}