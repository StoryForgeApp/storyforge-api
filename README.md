# Vintage Story Download Links API

This tool provides a simple API to fetch and serve all download links for every Vintage Story version, using [Elysia.js](https://elysiajs.com/) and TypeScript. It parses the official Vintage Story account downloads page and returns structured download URLs for Windows, Mac, Linux, and server packages.

## Features

- Fetches all available Vintage Story versions and their download links.
- Returns links for Windows, Mac, Linux, Windows Server, and Linux Server.
- Prefers CDN links when available.
- Robust parsing for both stable and unstable releases.
- Easy to run locally with Bun.

## API Usage

Once running, the API exposes:

- `GET /`  
	Returns a JSON object mapping each version to its download links.

Example response:
```json
{
	"1.21.0": {
		"windows": "https://cdn.vintagestory.at/vs_install_1.21.0.exe",
		"mac": "https://cdn.vintagestory.at/vs_mac_1.21.0.zip",
		"linux": "https://cdn.vintagestory.at/vs_archive_1.21.0.tar.gz",
		"windows_server": "https://cdn.vintagestory.at/vs_server_win-x64_1.21.0.zip",
		"linux_server": "https://cdn.vintagestory.at/vs_server_linux-x64_1.21.0.tar.gz"
	},
	...
}
```

- `GET /download/:version/:platform`  
	Returns `{ "url": "…" }` for one platform. For `windows` the URL is the
	launcher-ready zip, which this API serves itself:
	`GET /gamefiles/:version/windows.zip` answers `302` to a presigned R2 URL.
	The official channel only ships an `.exe`, so the zip is built from it by a
	two-hourly job; a version that has just been released may answer `404` until
	its zip exists.

Clients should keep the `/gamefiles/…` URL rather than the presigned one: it
never expires, and resuming a paused download (a `Range` request) re-resolves
to a fresh presigned URL.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) installed
- Vintage Story account (to access the downloads page)

### Installation

1. Clone this repository.
2. Install dependencies:
	 ```sh
	 bun install
	 ```
3. Set up environment variables (see below).

### Required Environment Variables

The API requires two session cookies to access the downloads page:

- `PHPSESSID`
- `VS_WEBSESSIONKEY`

#### How to Obtain Your Session Cookies

1. Log in to [https://account.vintagestory.at/](https://account.vintagestory.at/).
2. Open your browser’s Developer Tools (usually F12 or right-click → Inspect).
3. Go to the **Network** tab.
4. Refresh the page.
5. Click on any request to `account.vintagestory.at` (e.g., the main document or an XHR request).
6. In the request details, find the **Cookies** section.
7. Copy the values for `PHPSESSID` and `vs_websessionkey`.

Alternatively, in Chrome/Firefox:

- Go to the **Application/Storage** tab in DevTools.
- Under **Cookies**, select `account.vintagestory.at`.
- Find and copy the values for `PHPSESSID` and `vs_websessionkey`.

#### Example `.env` file

Create a `.env` file in the project root:

```
PHPSESSID=your_php_session_id_here
VS_WEBSESSIONKEY=your_vs_websessionkey_here
```

The storage and cache settings are also required: `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE` and
`REDIS_URL`. `R2_PUBLIC_BASE` is the public bucket URL used for modpack files.

Set `PUBLIC_BASE_URL` (e.g. `https://api.getstoryforge.app`) when the process
sits behind a reverse proxy: Windows download links are built from it. Without
it the API uses `X-Forwarded-Host`/`X-Forwarded-Proto`, then the host of the
incoming request (upgraded to `https` unless it is loopback).

## Running the API

Start the server:

```sh
bun run src/index.ts
```

The API will be available at `http://localhost:3000/`.

## License

MIT
