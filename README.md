# PokeMarket Discord Bot

## Included fixes
- Reliable Forum `THREAD_CREATE` handling for auction and buy forums, with starter-message retries and duplicate protection.
- `/auctionpage add` scans existing posts; new posts are processed automatically.
- Auction prices accept common formats including `$`, `R`, `ZAR`, `USD`, `EUR`, and `GBP`.
- Auction listings show detected country and Shipping: National / International when supplied in the post.
- Missing auction requirements now produce an explanation inside the forum post instead of silently doing nothing.
- `/buypagelocate` supports multiple forums without duplicate listing messages.
- `/tlog channel:#ticket-log` stores closed-ticket transcripts as `.txt` files.
- `/quickset` refreshes the TCGdex set list, processes every returned set, and falls back to a set-summary post when card-detail loading fails.
- Japanese/Chinese set posts show the localized set name first and the English counterpart/translation when available.
- `/quickset` orders sets oldest release date to newest.

## TCGdex note
TCGdex is the live source for set data. Japanese and Traditional Chinese are supported by TCGdex; Simplified Chinese availability depends on TCGdex's own dataset coverage.
