# Local fonts (offline PWA)

MealForge uses **Michroma** for the UI. To avoid depending on Google Fonts when offline, the font is served from this folder.

## Setup

1. Download the Michroma woff2 file (latin subset) from Google Fonts:
   - **Direct URL:** https://fonts.gstatic.com/s/michroma/v21/PN_zRfy9qWD8fEagAPg9pTk.woff2
   - Or use [Google Webfonts Helper](https://gwfh.mranftl.com/fonts/michroma?subsets=latin) and download the woff2.

2. Save it in this folder as:
   ```
   Michroma-Regular.woff2
   ```

3. Ensure your server serves the `fonts` directory (same origin as the app). The service worker will cache this file so the app works offline.

Final path from project root: `fonts/Michroma-Regular.woff2` (requested by the app as `/fonts/Michroma-Regular.woff2`).
