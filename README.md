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

## Running the API

Start the server:

```sh
bun run src/index.ts
```

The API will be available at `http://localhost:3000/`.

## License

MIT
