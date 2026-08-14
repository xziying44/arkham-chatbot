/**
 * @arkham/deck-renderer — 卡组分享渲染引擎
 *
 * 公共 API：
 * - 引擎：renderDeck / computeHeight / sectionHeight / createImageCache
 * - 排班表类型：DeckLayout / DeckSection / CardRef ...
 * - 数据层：createCardImageResolver / loadCardMetadata
 * - 卡组层：fetchDeck / organizeDeck / autoLayout / expandCards
 * - 字体：registerFonts
 *
 * 典型用法：
 * ```ts
 * registerFonts(fontsDir);
 * const meta = await loadCardMetadata(arkhamDbDir, cardDbDir);
 * const deck = await fetchDeck(deckId);
 * const organized = organizeDeck(deck, meta);
 * const layout = autoLayout(organized, { title: deck.name });
 * const resolver = createCardImageResolver({ cardDatabaseDir: cardDbDir });
 * const png = await renderDeck(layout, { resolver });
 * await writeFile(out, png);
 * ```
 */
export type {
	CardImageResolver,
	CardRef,
	DeckLayout,
	DeckSection,
	FreeImage,
	HeaderBlock,
	PathImageLoader,
	TextItem,
	XY,
	Size,
	CardFace,
} from "./types.ts";

export { renderDeck, computeHeight, sectionHeight, createImageCache } from "./engine.ts";
export type { ImageCache, RenderOptions } from "./engine.ts";

export { planDeck, describePositions, investigatorSize, DEFAULT_PLAN } from "./plan.ts";
export type { DeckPlan, PlanSlot, PlanResult, CardPosition } from "./plan.ts";

export { validateDeckPlan, formatValidation } from "./validate.ts";
export type { ValidationReport, MissingCard } from "./validate.ts";

export { registerFonts, isFontsRegistered } from "./fonts.ts";
export * as theme from "./theme.ts";

export { createCardImageResolver } from "./data/card-image-resolver.ts";
export { loadCardMetadata, peekMetadata } from "./data/card-metadata.ts";
export type { CardMeta } from "./data/card-metadata.ts";

export { fetchDeck, fetchArkhamBuildDeck, parseArkhamBuildShareId } from "./deck/fetch-deck.ts";
export type { ArkhamDeck, FetchDeckOptions } from "./deck/fetch-deck.ts";

export { organizeDeck, expandCards, expandedCounts, assetSlotWeight } from "./deck/organize.ts";
export type { OrganizedCard, OrganizedDeck, OrganizeOptions } from "./deck/organize.ts";

export { autoLayout, autoPlan, buildDefaultPlan, DEFAULT_LAYOUT_PARAMS } from "./deck/auto-layout.ts";
export type { AutoLayoutOptions } from "./deck/auto-layout.ts";
