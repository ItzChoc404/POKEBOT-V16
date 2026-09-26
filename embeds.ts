import type { DiscordEmbed, PokemonCard, PokemonSet, PriceChartingPrice, PriceSnapshot } from "./types.js";
import { truncate } from "./discord-rest.js";

export function makeCardEmbed(
  card: PokemonCard,
  set: PokemonSet,
  price: PriceChartingPrice | undefined,
  history: PriceSnapshot[] = [],
  relatedLinks: string[] = [],
): DiscordEmbed {
  const cardFacts = [
    card.category,
    card.hp !== undefined ? `${card.hp} HP` : "",
    card.types?.length ? card.types.join(" / ") : "",
    card.stage ? `${card.stage} stage` : "",
    card.rarity,
  ].filter(Boolean);
  const details = [
    card.evolveFrom ? `**Evolves from:** ${card.evolveFrom}` : "",
    card.evolveTo?.length ? `**Evolves to:** ${card.evolveTo.join(", ")}` : "",
    card.trainerType ? `**Trainer type:** ${card.trainerType}` : "",
    card.illustrator ? `**Illustrator:** ${card.illustrator}` : "",
    card.regulationMark ? `**Regulation mark:** ${card.regulationMark}` : "",
    card.dexId?.length ? `**Pokédex:** ${card.dexId.join(", ")}` : "",
    card.variants
      ? `**Prints:** ${Object.entries(card.variants)
          .filter(([, available]) => available)
          .map(([variant]) => variant)
          .join(", ")}`
      : "",
  ].filter(Boolean);

  const abilityLines = (card.abilities ?? []).map((ability) =>
    [ability.name, ability.type ? `(${ability.type})` : "", ability.effect]
      .filter(Boolean)
      .join(" "),
  );
  const attackLines = (card.attacks ?? []).map((attack) => {
    const cost = attack.cost?.length ? ` [${attack.cost.join(", ")}]` : "";
    const damage = attack.damage !== undefined ? ` — ${attack.damage}` : "";
    return `**${attack.name ?? "Attack"}**${cost}${damage}${attack.effect ? `\n${attack.effect}` : ""}`;
  });
  const defenses = [
    ...(card.weaknesses ?? []).map((item) => `Weakness ${item.type ?? ""} ${item.value ?? ""}`.trim()),
    ...(card.resistances ?? []).map((item) => `Resistance ${item.type ?? ""} ${item.value ?? ""}`.trim()),
    card.retreat !== undefined ? `Retreat ${card.retreat}` : "",
  ].filter(Boolean);

  const observedAverage = mean(history.map((item) => item.ungradedPrice));
  const priceLines = price?.ungradedPrice !== undefined
    ? [
        `**${money(price.ungradedPrice, price.currency)}** ungraded`,
        observedAverage !== undefined
          ? `30-day average: ${money(observedAverage, price.currency)}`
          : "",
        "PriceCharting estimate",
      ].filter(Boolean)
    : price
      ? ["Found on PriceCharting, but no ungraded value is listed."]
      : [
          "No price available. A matching listing and PriceCharting API access are required.",
        ];

  const title = truncate(`${card.name} · ${card.localId}`, 256);
  const description = [
    `**${set.englishName ?? set.name}** · ${languageName(set.language)}`,
    cardFacts.join("  ·  "),
  ]
    .filter(Boolean)
    .join("\n");
  const cardText = [card.description, card.effect].filter(Boolean).join("\n\n");
  const footer = `TCGdex  ·  ${languageName(set.language)} set:${set.id}`;
  const fields = fitFields(
    [
      ...(abilityLines.length ? [{ name: "Ability", value: abilityLines.join("\n\n") }] : []),
      ...(attackLines.length ? [{ name: "Attacks", value: attackLines.join("\n\n") }] : []),
      ...(cardText ? [{ name: "Card text", value: cardText }] : []),
      ...(defenses.length
        ? [{ name: "Weakness · Resistance · Retreat", value: defenses.join("  ·  ") }]
        : []),
      ...(details.length ? [{ name: "Other details", value: details.join("\n") }] : []),
      { name: "Market price", value: priceLines.join("\n") },
      ...(relatedLinks.length
        ? [{ name: "Matching cards", value: relatedLinks.join("\n") }]
        : []),
    ],
    title.length + description.length + footer.length,
  );

  return {
    title,
    description,
    color: cardAccent(card),
    fields: fields.slice(0, 25),
    ...(card.image
      ? { image: { url: card.image.match(/\.(png|jpe?g|webp)(\?.*)?$/i) ? card.image : `${card.image}/high.webp` } }
      : {}),
    footer: { text: footer },
  };
}

function cardAccent(card: PokemonCard): number {
  const rarity = card.rarity?.toLocaleLowerCase() ?? "";
  if (rarity.includes("secret") || rarity.includes("illustration") || rarity.includes("hyper")) {
    return 0xd6a52f;
  }
  if (rarity.includes("rare")) return 0x8b5cc7;

  const type = card.types?.[0]?.toLocaleLowerCase() ?? "";
  const typeColors: Record<string, number> = {
    fire: 0xe65b42,
    water: 0x3478c9,
    lightning: 0xd6ad27,
    electric: 0xd6ad27,
    grass: 0x3c8c58,
    psychic: 0x925bb2,
    fighting: 0xad653e,
    darkness: 0x504657,
    metal: 0x74879b,
    dragon: 0xb58c35,
    fairy: 0xd876a2,
    colorless: 0x738192,
  };
  return typeColors[type] ?? 0x48657f;
}

function fitFields(
  requested: Array<{ name: string; value: string }>,
  fixedCharacters: number,
): Array<{ name: string; value: string }> {
  let remaining = Math.max(0, 6000 - fixedCharacters);
  const fields: Array<{ name: string; value: string }> = [];
  for (const field of requested.slice(0, 25)) {
    const name = truncate(field.name, 256);
    const valueBudget = Math.min(1024, remaining - name.length);
    if (valueBudget < 1) break;
    const value = truncate(field.value, valueBudget);
    fields.push({ name, value });
    remaining -= name.length + value.length;
  }
  return fields;
}

function mean(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (present.length === 0) return undefined;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function money(value: number, currency: string): string {
  return `${currency} ${value.toFixed(2)}`;
}

function languageName(language: PokemonSet["language"]): string {
  if (language === "en") return "English";
  if (language === "ja") return "Japanese";
  return language === "zh-cn" ? "Chinese (Simplified)" : "Chinese (Traditional)";
}