# Pixiv - Popularity Filter

A lightweight, high-performance userscript for [Pixiv](https://www.pixiv.net/) that sorts illustrations and manga strictly by Likes or Bookmarks without requiring Pixiv Premium.

Includes a **Hall of Fame Harvester** to instantly pull all-time top artworks (`10000users入り`, `5000users入り`, etc.) on massive tags with thousands of pages.

---

## Features

- **True Popularity Sorting:** Guaranteed strict descending order (most liked or bookmarked to least).
- **Instant Metric Toggle:** Switch between Likes and Bookmarks with 0ms delay without re-fetching data.
- **Hybrid Hall of Fame Harvester:** Automatically queries community milestone tiers (`10000users入り`, `5000users入り`, `1000users入り`) in parallel to fetch all-time top artworks in under half a second.
- **Category Support:** Toggle seamlessly between Illustrations and Manga.
- **Flexible Page Depth:** Choose how many pages to scan (`1`, `3`, `5`, `10`, `25`, `50`, `100`, `Custom`, or `All Pages`).
- **Anti Clash Isolation:** Renders into an independent container outside Pixiv's Next.js React reconciler, preventing glitchy re-renders and out-of-order posts when scrolling.
- **429 Ratelimit Protection:** Built-in exponential backoff that automatically pauses and retries safely during large scans.
- **Threshold Filters:** Quick filter chips to hide lower-engagement posts (`All`, `50+`, `100+`, `500+`, `1000+`, `5000+`).
- **Stop & Show Now:** Freeze long scans at any point and immediately view results collected up to that moment.

---

## Installation

1. Install a userscript manager extension for your browser:
   - [Tampermonkey](https://www.tampermonkey.net/) (Recommended)
   - [Violentmonkey](https://violentmonkey.github.io/)
2. Create a new script in your userscript manager and paste the contents of [`pixivPopularitySorter,js`](https://raw.githubusercontent.com/juanjesusmcsalad/pixiv-auto-popularity/refs/heads/main/pixivPopularitySorter.js).
3. Save the script and visit any tag or search page on [Pixiv](https://www.pixiv.net/).
4. You can tab out and do other things while letting the page scan, duration heavily depends on how many posts that tag has but it can take less than a minute on most tags.

---

## How It Works

### 1. Bypassing Metric Stripping
Pixiv's search API deliberately strips `likeCount` and `bookmarkCount` for free users. The script solves this by:
- Gathering artwork IDs and thumbnail metadata via the search endpoint.
- Capturing the official top teaser works returned in `body.popular`.
- Using a 10-worker parallel queue to query Pixiv's unauthenticated public detail endpoint (`/ajax/illust/:id`) for exact counts.
- Storing fetched counts in `sessionStorage` so repeated scans or filter adjustments take 0ms of network time.

### 2. The Hybrid Hall of Fame Harvester (`+users入り`)
On large tags with thousands of pages (such as *Genshin*, *Blue Archive*, or *Hololive*), scanning every chronological page would take hours.
- When `+users入り` is enabled, the script simultaneously queries Pixiv's community milestone tags (`10000users入り`, `5000users入り`, `1000users入り`).
- It merges historical top works with recent trending works, deduplicates them, and ranks them strictly descending.

### 3. Anti-Clash Isolated Wall
Pixiv is a Next.js Single Page App. Modifying Pixiv's native container directly causes React's virtual DOM to overwrite elements on scroll.
- The script hides Pixiv's native container (`display: none`) and mounts an isolated `#pixiv-ranked-popularity-wall`.
- React never touches the ranked wall, guaranteeing post #1 has more likes than post #2, #3, etc., with zero visual flickering.

---

## License

This project is licensed under the [MIT License](LICENSE).
